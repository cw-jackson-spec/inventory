// POST is public — anyone can submit an order. GET/PATCH/DELETE (viewing the
// queue, changing status, removing an order) require the owner PIN header.
// Order quantities and prices are re-validated here against the live ledger,
// server-side — a customer's browser can never write a fake price or a
// quantity higher than what's actually in stock.
const { getStore } = require('@netlify/blobs');
const crypto = require('crypto');

function isAuthorized(event) {
  const pin = event.headers['x-owner-pin'] || event.headers['X-Owner-Pin'];
  return Boolean(process.env.OWNER_PIN) && pin === process.env.OWNER_PIN;
}

exports.handler = async function (event) {
  const store = getStore('cassanova');

  if (event.httpMethod === 'POST') {
    let body;
    try {
      body = JSON.parse(event.body || '{}');
    } catch (e) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) };
    }

    const icName = (body.icName || '').toString().trim().slice(0, 100);
    const icPhone = (body.icPhone || '').toString().trim().slice(0, 50);
    const deliveryDate = (body.deliveryDate || '').toString().slice(0, 20);
    const requestedLines = Array.isArray(body.lines) ? body.lines : [];

    if (!icName || requestedLines.length === 0) {
      return { statusCode: 400, body: JSON.stringify({ error: 'icName and at least one item are required' }) };
    }

    const ledger = (await store.get('ledger', { type: 'json' })) || { items: [] };
    const items = Array.isArray(ledger.items) ? ledger.items : [];

    const cleanLines = [];
    for (const line of requestedLines) {
      const item = items.find((i) => i.id === line.itemId);
      if (!item) continue;
      const requestedQty = parseInt(line.qty, 10) || 0;
      const qty = Math.max(0, Math.min(requestedQty, item.qty));
      if (qty > 0) {
        cleanLines.push({ itemId: item.id, name: item.name, qty, price: item.salePrice });
      }
    }

    if (cleanLines.length === 0) {
      return { statusCode: 400, body: JSON.stringify({ error: 'None of the requested items are currently in stock at that quantity' }) };
    }

    const existing = (await store.get('orders', { type: 'json' })) || [];
    const orders = Array.isArray(existing) ? existing : [];
    const newOrder = {
      id: crypto.randomUUID(),
      icName,
      icPhone,
      deliveryDate,
      lines: cleanLines,
      status: 'Pending',
      submittedAt: Date.now(),
    };
    orders.push(newOrder);
    await store.setJSON('orders', orders);

    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(newOrder) };
  }

  if (event.httpMethod === 'GET') {
    if (!isAuthorized(event)) {
      return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized' }) };
    }
    const orders = (await store.get('orders', { type: 'json' })) || [];
    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(Array.isArray(orders) ? orders : []) };
  }

  if (event.httpMethod === 'PATCH') {
    if (!isAuthorized(event)) {
      return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized' }) };
    }
    let body;
    try {
      body = JSON.parse(event.body || '{}');
    } catch (e) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) };
    }
    const existing = (await store.get('orders', { type: 'json' })) || [];
    const orders = Array.isArray(existing) ? existing : [];
    const order = orders.find((o) => o.id === body.id);
    if (!order) {
      return { statusCode: 404, body: JSON.stringify({ error: 'Order not found' }) };
    }
    order.status = body.status;
    await store.setJSON('orders', orders);
    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: true }) };
  }

  if (event.httpMethod === 'DELETE') {
    if (!isAuthorized(event)) {
      return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized' }) };
    }
    let body = {};
    try {
      body = JSON.parse(event.body || '{}');
    } catch (e) {
      /* fall through to query param */
    }
    const id = body.id || (event.queryStringParameters && event.queryStringParameters.id);
    const existing = (await store.get('orders', { type: 'json' })) || [];
    let orders = Array.isArray(existing) ? existing : [];
    orders = orders.filter((o) => o.id !== id);
    await store.setJSON('orders', orders);
    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: true }) };
  }

  return { statusCode: 405, body: 'Method Not Allowed' };
};
