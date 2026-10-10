// Owner-only. Moonshine still log + pricing settings, kept in their own blob
// key ("stills") so logging a batch never rewrites the main inventory ledger.
// Every request must carry an X-Owner-Pin header matching OWNER_PIN.
//
// A moonshine recipe is the barrel's 5 slots IN ORDER. Each slot holds one
// ingredient, a quantity, and the position (0-100) of the gauge slider that
// matches that slot (slot 1 = slider 1, and so on).
//
// GET  -> { stations, runs, pricing }
// POST -> one targeted change per request (read-modify-write on the server):
//   { op: 'station',   id: 's1'..'s5', station: { slots, brewing, startedAt } }
//   { op: 'run',       run: { id, station, slots, tier, at } }
//   { op: 'deleteRun', id }
//   { op: 'pricing',   pricing: { ...settings } }
const { getStore, connectLambda } = require('@netlify/blobs');

const KEY = 'stills';
const STATION_IDS = ['s1', 's2', 's3', 's4', 's5'];
const INGREDIENTS = ['water', 'apple', 'corn', 'bread', 'barley'];
const LEGACY_ORDER = ['apple', 'corn', 'bread', 'barley', 'water']; // pre-slot formulas
const MAX_RUNS = 5000;

function isAuthorized(event) {
  const pin = event.headers['x-owner-pin'] || event.headers['X-Owner-Pin'];
  return Boolean(process.env.OWNER_PIN) && pin === process.env.OWNER_PIN;
}

function json(statusCode, body) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

function clampInt(v, lo, hi, dflt) {
  const n = Math.round(Number(v));
  return isFinite(n) ? Math.max(lo, Math.min(hi, n)) : dflt;
}

// keepNullGauge: runs from before gauges were tracked keep gauge = null.
function cleanSlots(slots, keepNullGauge) {
  const out = [];
  for (let i = 0; i < 5; i++) {
    const s = (Array.isArray(slots) && slots[i]) || {};
    const ing = INGREDIENTS.includes(s.ing) ? s.ing : '';
    const gauge = (s.gauge === null && keepNullGauge) ? null : clampInt(s.gauge, 0, 100, 50);
    out.push({ ing, qty: ing ? clampInt(s.qty, 0, 999, 0) : 0, gauge });
  }
  return out;
}

// Older data stored a fixed ingredient list with no slot order.
function legacySlots(formula, gauges) {
  const slots = LEGACY_ORDER.filter(k => Number(formula && formula[k]) > 0)
    .map((k, i) => ({ ing: k, qty: Number(formula[k]), gauge: Array.isArray(gauges) ? gauges[i] : null }));
  return cleanSlots(slots, true);
}

function cleanStation(s) {
  s = s || {};
  const slots = Array.isArray(s.slots) ? cleanSlots(s.slots) : (s.formula ? cleanSlots(legacySlots(s.formula, s.gauges)) : cleanSlots([]));
  return { slots, brewing: Boolean(s.brewing), startedAt: s.startedAt || null };
}

function cleanRun(r) {
  return {
    id: String(r.id),
    station: String(r.station || ''),
    slots: Array.isArray(r.slots) ? cleanSlots(r.slots, true) : legacySlots(r.formula, r.gauges),
    tier: clampInt(r.tier, 1, 5, 1),
    at: Number(r.at) || Date.now(),
  };
}

function emptyDoc() {
  const stations = {};
  STATION_IDS.forEach(id => { stations[id] = cleanStation({}); });
  return { stations, runs: [], pricing: {} };
}

function normalize(doc) {
  const base = emptyDoc();
  if (!doc || typeof doc !== 'object') return base;
  STATION_IDS.forEach(id => {
    const s = doc.stations && doc.stations[id];
    if (s) base.stations[id] = cleanStation(s);
  });
  base.runs = Array.isArray(doc.runs) ? doc.runs.filter(r => r && r.id).map(cleanRun) : [];
  base.pricing = doc.pricing && typeof doc.pricing === 'object' ? doc.pricing : {};
  return base;
}

exports.handler = async function (event) {
  if (!isAuthorized(event)) return json(401, { error: 'Unauthorized' });

  try {
    connectLambda(event);
    const store = getStore('cassanova');
    const doc = normalize(await store.get(KEY, { type: 'json' }));

    if (event.httpMethod === 'GET') return json(200, doc);

    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

    let body;
    try { body = JSON.parse(event.body || '{}'); } catch (e) { return json(400, { error: 'Invalid JSON' }); }

    switch (body.op) {
      case 'station':
        if (!STATION_IDS.includes(body.id) || !body.station) return json(400, { error: 'Unknown station' });
        doc.stations[body.id] = cleanStation(body.station);
        break;
      case 'run': {
        const r = body.run || {};
        const tier = Math.round(Number(r.tier));
        if (!r.id || !(tier >= 1 && tier <= 5)) return json(400, { error: 'A run needs an id and a result tier from 1 to 5' });
        if (!doc.runs.some(x => x.id === String(r.id))) {
          doc.runs.push(cleanRun(r));
          if (doc.runs.length > MAX_RUNS) doc.runs = doc.runs.slice(-MAX_RUNS);
        }
        break;
      }
      case 'deleteRun':
        doc.runs = doc.runs.filter(x => x.id !== body.id);
        break;
      case 'pricing':
        if (!body.pricing || typeof body.pricing !== 'object') return json(400, { error: 'Pricing settings missing' });
        doc.pricing = body.pricing;
        break;
      default:
        return json(400, { error: 'Unknown operation' });
    }

    await store.setJSON(KEY, doc);
    return json(200, doc);
  } catch (err) {
    console.error('stills function error', err);
    return json(500, { error: 'Still log storage error: ' + err.message });
  }
};
