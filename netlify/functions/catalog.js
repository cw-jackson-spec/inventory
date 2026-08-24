// Public endpoint. Anyone can hit this — it only ever returns what customers
// should see: name, category, quantity available, your sale price, and
// whether ordering is currently turned on. Defaults OFF if never set, so a
// fresh site never accidentally shows an order form before the owner opts in.
// Items are also filtered to only the categories the owner has marked public —
// this filtering happens here, server-side, not just hidden in the frontend.
const { getStore, connectLambda } = require('@netlify/blobs');

const DEFAULT_PUBLIC_CATEGORIES = ['Recycling Materials', 'Drug Items'];

exports.handler = async function (event) {
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }
  try {
    connectLambda(event); // links the Blobs client to this site's storage credentials
    const store = getStore('cassanova');
    const ledger = (await store.get('ledger', { type: 'json' })) || { items: [], ordersEnabled: false };
    const items = Array.isArray(ledger.items) ? ledger.items : [];
    const publicCategories = Array.isArray(ledger.publicCategories) ? ledger.publicCategories : DEFAULT_PUBLIC_CATEGORIES;
    const catalogItems = items
      .filter((i) => publicCategories.includes(i.category))
      .map((i) => ({
        id: i.id,
        name: i.name,
        category: i.category,
        qty: i.qty,
        salePrice: i.salePrice,
      }));
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        items: catalogItems,
        ordersEnabled: Boolean(ledger.ordersEnabled),
      }),
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
