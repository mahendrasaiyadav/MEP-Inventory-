# MEP Material Inventory System

A full-featured web application for managing MEP/HVAC materials, tracking engineer usage, and monitoring stock levels — backed by a real Cloudflare database, shared across every device automatically.

## 🚀 Deploy the site

1. Create a new GitHub repository
2. Upload `index.html`, `styles.css`, `app.js` from this folder
3. Go to **Settings → Pages → Source → main branch**
4. Your site will be live at `https://yourusername.github.io/repo-name`

The GitHub repo only ever holds the static site itself — no app data (materials, engineers, transactions) is ever written to it.

## 🗄️ Set up the backend (one-time, ~10 minutes, Cloudflare dashboard only)

All shared data lives in **Cloudflare**, not GitHub:
- **D1** (a real SQL database) → engineers, transactions, settings
- **R2** (file storage) → the current materials list, every `materials.xlsx` you've ever uploaded (kept, timestamped), and a snapshot every time Admin Settings clears data

Steps — see the full walkthrough at the top of `sync-worker/worker.js`:
1. Sign up free at https://dash.cloudflare.com
2. **D1** → Create database → name it `mep-db` → open its Console → paste in `sync-worker/schema.sql` → Run
3. **R2** → Create bucket → name it `mep-files`
4. **Workers & Pages** → Create Worker → paste in `sync-worker/worker.js` → Deploy
5. Worker → Settings → Bindings → add D1 binding `DB` → `mep-db`, R2 binding `FILES` → `mep-files`, and a secret `SYNC_KEY` (any random string you make up)
6. Copy the Worker's URL and paste it (plus your `SYNC_KEY`) into `app.js` → `SYNC_PROXY_URL` / `SYNC_KEY` near the top, then push `app.js` to your repo

Once this is done, every device that opens the site auto-connects — nobody ever enters a token or credential.

## 📦 Adding / Updating Materials

Upload a `.xlsx` file from **Settings** or drag it onto the dashboard drop zone. Each **sheet** = one material category (MS, GI, CPVC, FP, VALVES, etc.), with columns `S.No | Material Description | Specification | UOM | QTY`.

The moment you upload:
- It's parsed and applied locally right away
- The raw file is stored in Cloudflare R2, timestamped, permanently (nothing is ever overwritten)
- The parsed list becomes the new "current" materials for every device — everyone sees it within ~25 seconds via background sync, or instantly on next page load

## 📋 Supported Category Sheets

| Sheet Name   | Category              |
|--------------|-----------------------|
| MS           | MS Pipes & Fittings   |
| GI           | GI Pipes & Fittings   |
| CPVC         | CPVC Pipes & Fittings |
| FP           | Fire Protection       |
| COMPOSITE    | PPR / PEX / Composite |
| VALVES       | All Valves            |
| PVC          | PVC / uPVC Pipes      |
| ELECTRICAL   | Electrical Materials  |
| MISCELLANEOUS| Misc Items            |

> You can add any new sheet — it automatically becomes a new category.

## 🔄 How It Works

1. On load, the app pulls the current engineers, transactions, settings, and materials list from Cloudflare (read-only — loading the page never changes any data)
2. Everything is cached in **browser localStorage** too, for instant offline use
3. Recording usage, adding/removing an engineer, saving settings, or uploading materials each write directly to Cloudflare — every engineer and every transaction is its own database row, so one device's update can never silently erase another device's update
4. The app also polls every ~25s so entries made on *other* devices appear here automatically
5. Stock deducts automatically when you record usage (always recalculated from the transaction log, never a separate counter, so it can't drift between devices)
6. The topbar badge shows sync status: `● LIVE` (synced), `⏳ SYNCING`, `● LOCAL ONLY` (backend not configured yet), `✖ SYNC ERROR`

## 🔐 Admin Settings

In **Settings → Admin Settings** (password-protected), you can:
- **Export / Import Backup** — download or restore a full JSON snapshot
- **Force Resync** — re-pull the latest data from the server
- **Clear Transactions Only** — wipes usage history, keeps materials + engineers
- **Clear ALL Data** — wipes everything

Both clear actions are the *only* things allowed to delete data. Before deleting anything, the Worker automatically saves a full snapshot to a brand-new timestamped file in Cloudflare R2 (`archive/...json`), so nothing is ever permanently lost.

> Note: this is a static, client-side site, so the admin password only deters casual/accidental use — it isn't real security. Don't rely on it to protect anything you wouldn't want a technical user to eventually be able to see.

## 📱 Features

- **Dashboard** — KPIs (click any card to jump to that section), category → material summary, recent transactions, full low/critical stock list, monthly usage
- **Material Overview** — Search and filter all materials with live stock status
- **Record Usage** — Select Category → Material → **Specification** (filtered to that material only) → issue, with stock validation
- **Engineer Reports** — Monthly usage per engineer with transaction detail
- **Transaction Log** — Complete history with CSV export
- **Settings** — Add/remove engineers (no limit), adjust reorder threshold, upload materials, Admin Settings
