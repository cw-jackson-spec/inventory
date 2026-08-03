// Public endpoint. Anyone can hit this — it only ever returns what customers
// should see: name, category, quantity available, and your sale price.
// MSRP, cost, and margins never leave the ledger.js endpoint, which is PIN-gated.
const { getStore } = require('@netlify/blobs');

exports.handler = async function (event) {
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }
  try {
    const store = getStore('cassanova');
    const ledger = (await store.get('ledger', { type: 'json' })) || { items: [] };
    const items = Array.isArray(ledger.items) ? ledger.items : [];
    const catalog = items.map((i) => ({
      id: i.id,
      name: i.name,
      category: i.category,
      qty: i.qty,
      salePrice: i.salePrice,
    }));
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(catalog),
    };
  } catch (err) {
    console.error('catalog error', err);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Failed to load catalog' }),
    };
  }
};
