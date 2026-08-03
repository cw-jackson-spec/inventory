// Verifies the owner PIN against the OWNER_PIN environment variable set in
// Netlify's dashboard (Site settings > Environment variables). The PIN itself
// never ships in the frontend code — only this function ever sees it.
exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  if (!process.env.OWNER_PIN) {
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: 'OWNER_PIN is not set. Add it under Site settings > Environment variables in Netlify, then redeploy.',
      }),
    };
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const pin = body.pin;
  if (pin && pin === process.env.OWNER_PIN) {
    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: true }) };
  }

  return { statusCode: 401, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: false, error: 'Incorrect PIN' }) };
};
