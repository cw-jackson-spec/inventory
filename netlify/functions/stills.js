// Owner-only. Moonshine still log + pricing settings.
// Every request must carry an X-Owner-Pin header matching OWNER_PIN.
//
// STORAGE LAYOUT (Netlify Blobs, store "cassanova", strong consistency):
//   stills                  -> { stations, pricing }   small doc, read-modify-write
//   stills-run/<id>         -> one rated run per key   (never rewritten as a list)
//   stills-pending/<id>     -> one collected, unrated batch per key
// Runs and pending batches each live under their own key, so saving one can
// never overwrite another. Older data that kept runs/pending as arrays inside
// "stills" is moved to per-key storage automatically on the next request.
//
// A moonshine recipe is the barrel's 5 slots IN ORDER. Each slot holds one
// ingredient, a quantity, and the gauge position for that slot (0/25/50/75/100).
//
// GET  -> { stations, pending, runs, pricing }
// POST -> one change per request:
//   { op: 'station', id: 's1'..'s5', station: { slots, brewing, startedAt } }
//   { op: 'pricing', pricing: {...} }
//   { op: 'run', run: { id, station, slots, tier, at } }          rated directly
//   { op: 'deleteRun', id }
//   { op: 'collect', id: 's1'..'s5', pending: { id, station, slots, at } }
//   { op: 'rate', id: <pending id>, tier }                          pending -> run
//   { op: 'discardPending', id }
//   { op: 'import', runs: [...], pending: [...] }                   restore a backup (adds, never removes)
const { getStore, connectLambda } = require('@netlify/blobs');

const KEY = 'stills';
const RUN_PREFIX = 'stills-run/';
const PENDING_PREFIX = 'stills-pending/';
const STATION_IDS = ['s1', 's2', 's3', 's4', 's5'];
const INGREDIENTS = ['water', 'apple', 'corn', 'bread', 'barley'];
const LEGACY_ORDER = ['apple', 'corn', 'bread', 'barley', 'water']; // pre-slot formulas

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

const safeId = id => String(id || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 80);

// keepNullGauge: runs from before gauges were tracked keep gauge = null.
function cleanSlots(slots, keepNullGauge) {
  const out = [];
  for (let i = 0; i < 5; i++) {
    const s = (Array.isArray(slots) && slots[i]) || {};
    const ing = INGREDIENTS.includes(s.ing) ? s.ing : '';
    const gauge = (s.gauge === null && keepNullGauge) ? null : Math.round(clampInt(s.gauge, 0, 100, 50) / 25) * 25;
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
    id: safeId(r.id),
    station: String(r.station || '').slice(0, 10),
    slots: Array.isArray(r.slots) ? cleanSlots(r.slots, true) : legacySlots(r.formula, r.gauges),
    tier: clampInt(r.tier, 1, 5, 1),
    at: Number(r.at) || Date.now(),
  };
}

function cleanPending(p) {
  return { id: safeId(p.id), station: String(p.station || '').slice(0, 10), slots: cleanSlots(p.slots), at: Number(p.at) || Date.now() };
}

function normalizeMain(doc) {
  const stations = {};
  STATION_IDS.forEach(id => { stations[id] = cleanStation(doc && doc.stations && doc.stations[id]); });
  const pricing = doc && doc.pricing && typeof doc.pricing === 'object' ? doc.pricing : {};
  return { stations, pricing };
}

async function readAll(store, prefix) {
  const { blobs } = await store.list({ prefix });
  const items = await Promise.all(blobs.map(b => store.get(b.key, { type: 'json' })));
  return items.filter(Boolean);
}

// Move runs/pending that older versions kept inside the "stills" doc into
// their own keys. Each item is written before the array is dropped, so an
// interruption can only leave a duplicate, never a loss.
async function migrate(store, raw) {
  const runs = Array.isArray(raw && raw.runs) ? raw.runs.filter(r => r && r.id) : [];
  const pending = Array.isArray(raw && raw.pending) ? raw.pending.filter(p => p && p.id) : [];
  if (!runs.length && !pending.length) return;
  for (const r of runs) { const c = cleanRun(r); if (c.id) await store.setJSON(RUN_PREFIX + c.id, c); }
  for (const p of pending) { const c = cleanPending(p); if (c.id) await store.setJSON(PENDING_PREFIX + c.id, c); }
  await store.setJSON(KEY, normalizeMain(raw));
}

exports.handler = async function (event) {
  if (!isAuthorized(event)) return json(401, { error: 'Unauthorized' });

  try {
    connectLambda(event);
    // Strong consistency: every read sees the latest write, so a save can
    // never be built on a stale copy of the data.
    const store = getStore({ name: 'cassanova', consistency: 'strong' });

    const raw = await store.get(KEY, { type: 'json' });
    await migrate(store, raw);
    const main = normalizeMain(raw);

    if (event.httpMethod === 'GET') {
      const [runs, pending] = await Promise.all([readAll(store, RUN_PREFIX), readAll(store, PENDING_PREFIX)]);
      return json(200, { stations: main.stations, pricing: main.pricing, runs: runs.map(cleanRun), pending: pending.map(cleanPending) });
    }

    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

    let body;
    try { body = JSON.parse(event.body || '{}'); } catch (e) { return json(400, { error: 'Invalid JSON' }); }

    switch (body.op) {
      case 'station':
        if (!STATION_IDS.includes(body.id) || !body.station) return json(400, { error: 'Unknown station' });
        main.stations[body.id] = cleanStation(body.station);
        await store.setJSON(KEY, main);
        break;

      case 'pricing':
        if (!body.pricing || typeof body.pricing !== 'object') return json(400, { error: 'Pricing settings missing' });
        main.pricing = body.pricing;
        await store.setJSON(KEY, main);
        break;

      case 'run': {
        const r = cleanRun(body.run || {});
        if (!r.id || !(Number(body.run && body.run.tier) >= 1)) return json(400, { error: 'A run needs an id and a result tier from 1 to 5' });
        await store.setJSON(RUN_PREFIX + r.id, r);
        break;
      }

      case 'deleteRun':
        if (!safeId(body.id)) return json(400, { error: 'Run id missing' });
        await store.delete(RUN_PREFIX + safeId(body.id));
        break;

      case 'collect': {
        if (!STATION_IDS.includes(body.id) || !body.pending || !safeId(body.pending.id)) return json(400, { error: 'Unknown station or batch' });
        const p = cleanPending(body.pending);
        await store.setJSON(PENDING_PREFIX + p.id, p);          // save the batch first
        main.stations[body.id] = Object.assign(main.stations[body.id], { brewing: false, startedAt: null });
        await store.setJSON(KEY, main);                          // then free the station
        break;
      }

      case 'rate': {
        const tier = Math.round(Number(body.tier));
        const id = safeId(body.id);
        if (!id || !(tier >= 1 && tier <= 5)) return json(400, { error: 'Pick a result tier from 1 to 5' });
        const p = await store.get(PENDING_PREFIX + id, { type: 'json' });
        if (p) {
          await store.setJSON(RUN_PREFIX + id, cleanRun(Object.assign({}, p, { tier })));  // write the run first
          await store.delete(PENDING_PREFIX + id);                                          // then clear the pending copy
        }
        break;
      }

      case 'discardPending':
        if (!safeId(body.id)) return json(400, { error: 'Batch id missing' });
        await store.delete(PENDING_PREFIX + safeId(body.id));
        break;

      case 'import': {
        // Restore from an exported backup. Adds anything missing; never deletes.
        const runs = Array.isArray(body.runs) ? body.runs : [];
        const pending = Array.isArray(body.pending) ? body.pending : [];
        if (runs.length + pending.length > 5000) return json(400, { error: 'Backup is too large to import in one go' });
        let added = 0;
        for (const r of runs) {
          const c = cleanRun(r || {});
          if (!c.id) continue;
          if (!(await store.get(RUN_PREFIX + c.id, { type: 'json' }))) { await store.setJSON(RUN_PREFIX + c.id, c); added++; }
        }
        for (const x of pending) {
          const c = cleanPending(x || {});
          if (!c.id) continue;
          const asRun = await store.get(RUN_PREFIX + c.id, { type: 'json' });
          if (!asRun && !(await store.get(PENDING_PREFIX + c.id, { type: 'json' }))) { await store.setJSON(PENDING_PREFIX + c.id, c); added++; }
        }
        return json(200, { ok: true, added });
      }

      default:
        return json(400, { error: 'Unknown operation' });
    }

    return json(200, { ok: true });
  } catch (err) {
    console.error('stills function error', err);
    return json(500, { error: 'Still log storage error: ' + err.message });
  }
};
