# Cassanova Ledger

A crim inventory tracker with a public order form, built to run on Netlify.

## How it's structured

- `public/index.html` — the whole frontend (one file: HTML, CSS, JS).
- `netlify/functions/` — the backend. Four small serverless functions:
  - `catalog.js` — **public**. Returns item name, category, quantity, and sale price only. No cost, no MSRP.
  - `login.js` — **public**. Checks a submitted PIN against the `OWNER_PIN` environment variable. The PIN itself never ships to the browser.
  - `ledger.js` — **owner-only**. Full inventory (MSRP, cost, quantities) and the sales log. Every request must include a matching `X-Owner-Pin` header.
  - `orders.js` — mixed. Submitting an order (`POST`) is public. Viewing, updating status, or deleting orders (`GET` / `PATCH` / `DELETE`) requires the PIN header.
- Data lives in **Netlify Blobs** — a key-value store Netlify provisions automatically for your site. No separate database to set up.

Two blob keys are used: `ledger` (items + sales) and `orders` (the order queue).

## Deploy it

You need a free [Netlify](https://netlify.com) account and a way to get this code onto Netlify. Two options:

### Option A — GitHub (recommended, gives you auto-deploy on future edits)
1. Create a new repository on GitHub and push this folder to it.
2. In Netlify: **Add new site > Import an existing project**, connect GitHub, pick the repo.
3. Netlify auto-detects `netlify.toml` — build settings are already correct. Click **Deploy**.

### Option B — Netlify CLI (faster for a one-off deploy)
```bash
npm install -g netlify-cli
cd cassanova-netlify
netlify login
netlify deploy --prod
```

## After deploying — set your PIN

The site will be live but the owner login won't work until you set your PIN:

1. In the Netlify dashboard, open your site.
2. **Site settings > Environment variables > Add a variable**.
3. Key: `OWNER_PIN`, Value: whatever PIN you want (default suggestion was `0315`, but pick your own).
4. **Trigger a redeploy** (Deploys tab > Trigger deploy > Deploy site) so the function picks up the new variable.

## Using it

- The published URL (something like `https://your-site-name.netlify.app`, or a custom domain if you add one in Netlify's Domain settings) is what you bookmark for yourself **and** what you hand to customers.
- Customers see: available stock, your current sale price, and an order form. They never see MSRP, your cost, or margins.
- Click **🔒 Owner Login** top-right and enter your PIN to unlock inventory management (restock, sell, edit prices, add/remove items, the sales log, and the incoming-orders queue).
- The lock resets on every page reload, on purpose.

## Notes

- **This is a real backend now** — data lives in Netlify's storage, not in your browser and not tied to any Claude account. It'll be identical no matter what device or browser opens the link.
- Free Netlify plan is enough for this — Netlify Blobs and Functions are both included.
- If you ever want to wipe everything and start clean, use **Reset Data** inside the owner view (after unlocking), or delete the site in Netlify to remove it entirely.
