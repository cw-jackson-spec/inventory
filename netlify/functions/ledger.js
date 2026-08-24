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
      const ledger = (await store.get('ledger', { type: 'json' })) || {
        items: [], sales: [], ordersEnabled: false, recipes: [], adjustments: [], craftLog: [],
      };
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          items: ledger.items || [],
          sales: ledger.sales || [],
          ordersEnabled: Boolean(ledger.ordersEnabled),
          recipes: Array.isArray(ledger.recipes) ? ledger.recipes : [],
          adjustments: Array.isArray(ledger.adjustments) ? ledger.adjustments : [],
          craftLog: Array.isArray(ledger.craftLog) ? ledger.craftLog : [],
        }),
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
      await store.setJSON('ledger', {
        items: body.items,
        sales: body.sales,
        ordersEnabled: Boolean(body.ordersEnabled),
        recipes: Array.isArray(body.recipes) ? body.recipes : [],
        adjustments: Array.isArray(body.adjustments) ? body.adjustments : [],
        craftLog: Array.isArray(body.craftLog) ? body.craftLog : [],
      });
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
