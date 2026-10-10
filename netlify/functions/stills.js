// Owner-only. Moonshine still log + pricing settings, kept in their own blob
// key ("stills") so logging a batch never rewrites the main inventory ledger.
// Every request must carry an X-Owner-Pin header matching OWNER_PIN.
//
// GET  -> { stations, runs, pricing }
// POST -> one targeted change per request (read-modify-write on the server):
//   { op: 'station',   id: 's1'..'s5', station: { formula, brewing, startedAt } }
//   { op: 'run',       run: { id, station, formula, tier, at } }
//   { op: 'deleteRun', id }
//   { op: 'pricing',   pricing: { ...settings } }
const { getStore, connectLambda } = require('@netlify/blobs');

const KEY = 'stills';
const STATION_IDS = ['s1', 's2', 's3', 's4', 's5'];
const INGREDIENTS = ['apple', 'corn', 'bread', 'barley', 'water'];
const MAX_RUNS = 5000;

function isAuthorized(event) {
  const pin = event.headers['x-owner-pin'] || event.headers['X-Owner-Pin'];
  return Boolean(process.env.OWNER_PIN) && pin === process.env.OWNER_PIN;
}

function json(statusCode, body) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

function cleanFormula(f) {
  const out = {};
  INGREDIENTS.forEach(k => {
    const n = Math.round(Number(f && f[k]) || 0);
    out[k] = Math.max(0, Math.min(999, n));
  });
  return out;
}

function emptyDoc() {
  const stations = {};
  STATION_IDS.forEach(id => { stations[id] = { formula: cleanFormula({}), brewing: false, startedAt: null }; });
  return { stations, runs: [], pricing: {} };
}

function normalize(doc) {
  const base = emptyDoc();
  if (!doc || typeof doc !== 'object') return base;
  STATION_IDS.forEach(id => {
    const s = doc.stations && doc.stations[id];
    if (s) base.stations[id] = { formula: cleanFormula(s.formula), brewing: Boolean(s.brewing), startedAt: s.startedAt || null };
  });
  base.runs = Array.isArray(doc.runs) ? doc.runs : [];
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
      case 'station': {
        if (!STATION_IDS.includes(body.id) || !body.station) return json(400, { error: 'Unknown station' });
        const s = body.station;
        doc.stations[body.id] = { formula: cleanFormula(s.formula), brewing: Boolean(s.brewing), startedAt: s.startedAt || null };
        break;
      }
      case 'run': {
        const r = body.run || {};
        const tier = Math.round(Number(r.tier));
        if (!r.id || !(tier >= 1 && tier <= 5)) return json(400, { error: 'A run needs an id and a result tier from 1 to 5' });
        if (!doc.runs.some(x => x.id === r.id)) {
          doc.runs.push({ id: String(r.id), station: String(r.station || ''), formula: cleanFormula(r.formula), tier, at: Number(r.at) || Date.now() });
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
