// Owner-only. Every request must carry an X-Owner-Pin header matching the
// OWNER_PIN environment variable, checked server-side. This is what returns
// and updates the full ledger: MSRP, cost/unit, quantities, and the sales log.
const { getStore, connectLambda } = require('@netlify/blobs');

function isAuthorized(event) {
  const pin = event.headers['x-owner-pin'] || event.headers['X-Owner-Pin'];
  return Boolean(process.env.OWNER_PIN) && pin === process.env.OWNER_PIN;
}

exports.handler = async function (event) {
  if (!isAuthorized(event)) {
    return { statusCode: 401, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  try {
    connectLambda(event); // links the Blobs client to this site's storage credentials
    const store = getStore('cassanova');

    if (event.httpMethod === 'GET') {
      const ledger = (await store.get('ledger', { type: 'json' })) || { items: [], sales: [] };
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(ledger),
      };
    }

    if (event.httpMethod === 'POST') {
      let body;
      try {
        body = JSON.parse(event.body || '{}');
      } catch (e) {
        return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) };
      }
      if (!Array.isArray(body.items) || !Array.isArray(body.sales)) {
        return { statusCode: 400, body: JSON.stringify({ error: '"items" and "sales" arrays are required' }) };
      }
      await store.setJSON('ledger', { items: body.items, sales: body.sales });
      return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: true }) };
    }

    return { statusCode: 405, body: 'Method Not Allowed' };
  } catch (err) {
    console.error('ledger function error', err);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Ledger storage error: ' + err.message }),
    };
  }
};
