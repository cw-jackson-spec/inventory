// Owner-only. Moonshine still log + pricing settings.
// Every request must carry an X-Owner-Pin header matching OWNER_PIN.
//
// STORAGE LAYOUT (Netlify Blobs, store "cassanova"):
//   stills-station/<s1..s5>  -> one station per key
//   stills-pricing           -> pricing settings
//   stills-run/<id>          -> one rated run per key
//   stills-pending/<id>      -> one collected, unrated batch per key
// Every save replaces only its own key and never reads-then-rewrites a list,
// so a briefly out-of-date read (Netlify reads can lag up to ~60 s) can never
// wipe other data. Older versions kept everything in one "stills" doc; that
// is copied into this layout automatically on the next request.
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
//   { op: 'collect', id: 's1'..'s5', pending: { id, station, slots, at }, station }
//   { op: 'rate', id, tier, pending: { id, station, slots, at } } pending -> run
//   { op: 'discardPending', id }
//   { op: 'import', runs: [...], pending: [...] }                   restore a backup (adds, never removes)
const { getStore, connectLambda } = require('@netlify/blobs');

const LEGACY_KEY = 'stills';
const STATION_PREFIX = 'stills-station/';
const PRICING_KEY = 'stills-pricing';
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

async function readPrefix(store, prefix) {
  const { blobs } = await store.list({ prefix });
  const items = await Promise.all(blobs.map(b => store.get(b.key, { type: 'json' })));
  return items.filter(Boolean);
}

// Copy anything still in the old single "stills" doc into per-key storage.
// Runs and pending batches are copied by id (safe to repeat). Stations and
// pricing are copied only where no per-key copy exists yet. The old doc is
// then marked as migrated rather than deleted.
// Returns the copied data so the same request can show it right away.
async function migrateLegacy(store) {
  const raw = await store.get(LEGACY_KEY, { type: 'json' });
  if (!raw || raw.migrated) return null;
  const runs = Array.isArray(raw.runs) ? raw.runs.filter(r => r && r.id) : [];
  const pending = Array.isArray(raw.pending) ? raw.pending.filter(p => p && p.id) : [];
  for (const r of runs) { const c = cleanRun(r); if (c.id) await store.setJSON(RUN_PREFIX + c.id, c); }
  for (const p of pending) { const c = cleanPending(p); if (c.id) await store.setJSON(PENDING_PREFIX + c.id, c); }
  for (const id of STATION_IDS) {
    if (raw.stations && raw.stations[id] && !(await store.get(STATION_PREFIX + id, { type: 'json' }))) {
      await store.setJSON(STATION_PREFIX + id, cleanStation(raw.stations[id]));
    }
  }
  if (raw.pricing && typeof raw.pricing === 'object' && !(await store.get(PRICING_KEY, { type: 'json' }))) {
    await store.setJSON(PRICING_KEY, raw.pricing);
  }
  // Keep the old content alongside the marker, so nothing is ever thrown away.
  await store.setJSON(LEGACY_KEY, Object.assign({}, raw, { migrated: true, migratedAt: Date.now() }));
  return {
    runs: runs.map(cleanRun),
    pending: pending.map(cleanPending),
    stations: raw.stations || {},
    pricing: raw.pricing && typeof raw.pricing === 'object' ? raw.pricing : null,
  };
}

exports.handler = async function (event) {
  if (!isAuthorized(event)) return json(401, { error: 'Unauthorized' });

  try {
    connectLambda(event);
    const store = getStore('cassanova');
    const moved = await migrateLegacy(store);

    if (event.httpMethod === 'GET') {
      const [stationList, pricing, runs, pending] = await Promise.all([
        Promise.all(STATION_IDS.map(id => store.get(STATION_PREFIX + id, { type: 'json' }))),
        store.get(PRICING_KEY, { type: 'json' }),
        readPrefix(store, RUN_PREFIX),
        readPrefix(store, PENDING_PREFIX),
      ]);
      const stations = {};
      STATION_IDS.forEach((id, i) => {
        stations[id] = cleanStation(stationList[i] || (moved && moved.stations[id]));
      });
      // Include anything just moved from the old layout, in case the new keys aren't readable yet.
      const runMap = new Map(runs.map(cleanRun).map(r => [r.id, r]));
      if (moved) moved.runs.forEach(r => { if (!runMap.has(r.id)) runMap.set(r.id, r); });
      const pendMap = new Map(pending.map(cleanPending).map(x => [x.id, x]));
      if (moved) moved.pending.forEach(x => { if (!pendMap.has(x.id)) pendMap.set(x.id, x); });
      // A batch that has a rated run is no longer waiting; clear any leftover copy.
      const leftovers = pending.map(x => safeId(x.id)).filter(id => runMap.has(id));
      if (leftovers.length) await Promise.all(leftovers.map(id => store.delete(PENDING_PREFIX + id)));
      for (const id of runMap.keys()) pendMap.delete(id);
      return json(200, {
        stations,
        pricing: (pricing && typeof pricing === 'object') ? pricing : ((moved && moved.pricing) || {}),
        runs: [...runMap.values()],
        pending: [...pendMap.values()],
      });
    }

    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

    let body;
    try { body = JSON.parse(event.body || '{}'); } catch (e) { return json(400, { error: 'Invalid JSON' }); }

    switch (body.op) {
      case 'station':
        if (!STATION_IDS.includes(body.id) || !body.station) return json(400, { error: 'Unknown station' });
        await store.setJSON(STATION_PREFIX + body.id, cleanStation(body.station));
        break;

      case 'pricing':
        if (!body.pricing || typeof body.pricing !== 'object') return json(400, { error: 'Pricing settings missing' });
        await store.setJSON(PRICING_KEY, body.pricing);
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
        await store.setJSON(PENDING_PREFIX + p.id, p);                    // save the batch first
        const st = cleanStation(body.station || { slots: p.slots });
        st.brewing = false; st.startedAt = null;
        await store.setJSON(STATION_PREFIX + body.id, st);                 // then free the station
        break;
      }

      case 'rate': {
        const tier = Math.round(Number(body.tier));
        const id = safeId(body.id);
        if (!id || !(tier >= 1 && tier <= 5)) return json(400, { error: 'Pick a result tier from 1 to 5' });
        // The page sends the batch it is rating, so this never depends on a fresh read.
        const p = body.pending && safeId(body.pending.id) === id ? body.pending : await store.get(PENDING_PREFIX + id, { type: 'json' });
        if (!p) return json(404, { error: 'That batch was not found' });
        await store.setJSON(RUN_PREFIX + id, cleanRun(Object.assign({}, p, { id, tier })));  // write the run first
        await store.delete(PENDING_PREFIX + id);                                             // then clear the pending copy
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
        const have = new Set((await store.list({ prefix: RUN_PREFIX })).blobs.map(b => b.key));
        const havePending = new Set((await store.list({ prefix: PENDING_PREFIX })).blobs.map(b => b.key));
        let added = 0;
        for (const r of runs) {
          const c = cleanRun(r || {});
          if (c.id && !have.has(RUN_PREFIX + c.id)) { await store.setJSON(RUN_PREFIX + c.id, c); added++; }
        }
        for (const x of pending) {
          const c = cleanPending(x || {});
          if (c.id && !have.has(RUN_PREFIX + c.id) && !havePending.has(PENDING_PREFIX + c.id)) { await store.setJSON(PENDING_PREFIX + c.id, c); added++; }
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
