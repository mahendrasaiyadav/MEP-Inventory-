# MEP Material Inventory System

A full-featured web application for managing MEP/HVAC materials, tracking engineer usage, and monitoring stock levels — powered by a simple Excel file.

## 🚀 Deploy to GitHub Pages

1. Create a new GitHub repository
2. Upload all files from this folder
3. Go to **Settings → Pages → Source → main branch**
4. Your site will be live at `https://yourusername.github.io/repo-name`

## 📁 File Structure

```
├── index.html        ← Main app
├── styles.css        ← All styles
├── app.js            ← App logic
├── materials.xlsx    ← Master material data ← UPDATE THIS
└── README.md
```

## 📦 Adding / Updating Materials

**Edit `materials.xlsx`:**
- Each **sheet** = one material category (MS, GI, CPVC, FP, VALVES, etc.)
- Required columns: `S.No | Material Description | Specification | UOM | QTY`
- `QTY` = physical opening stock quantity
- Add as many sheets and rows as needed
- Push to GitHub — the app will auto-load the new file

**Example sheet structure:**

| S.No | Material Description | Specification | UOM | QTY |
|------|---------------------|---------------|-----|-----|
| 1    | MS Pipe             | 50mm          | Mtr | 100 |
| 2    | MS Pipe             | 100mm         | Mtr | 60  |
| 3    | MS Elbow 90°        | 50mm          | Nos | 80  |

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

1. **Auto-loads** `materials.xlsx` on first visit (this is your shared material master, versioned in Git)
2. Everything is cached in **browser localStorage** for instant offline use…
3. …and, if you connect **GitHub Sync** (see below), engineers and issued-material transactions are also written to a JSON file in your repo, so every device pulls the same data
4. Stock deducts automatically when you record usage (always recalculated from the transaction log, never a separate counter, so it can't drift between devices)
5. Push a new `materials.xlsx` to GitHub → users get the updated material list on next load

## 🌐 Cross-Device Sync (GitHub)

Go to **Settings → 🔗 Data Sync (GitHub)** and enter:

| Field | Example |
|---|---|
| Owner / Repository | `yourusername/your-repo` |
| Branch | `main` |
| Data File Path | `data.json` |
| Personal Access Token | a token with **Contents: Read & write** on that repo |

Click **Save & Connect**. From then on:
- Adding an engineer or issuing material pushes the change to `data.json` in your repo
- The app also polls every ~25s so entries made on *other* devices appear here automatically
- The topbar badge shows sync status: `● LIVE` (synced), `⏳ SYNCING`, `● LOCAL ONLY` (not connected), `✖ SYNC ERROR`
- Deleting an engineer is tracked so it doesn't reappear after syncing with a device that hasn't deleted it yet

Each device/browser stores its own token locally — it's never sent anywhere except directly to `api.github.com`.

## 📱 Features

- **Dashboard** — KPIs (click any card to jump to that section), category → material summary (drill into any category to see per-material totals), recent transactions, full low/critical stock list, monthly usage
- **Material Overview** — Search and filter all materials with live stock status
- **Record Usage** — Select Category → Material → **Specification** (filtered to that material only) → issue, with stock validation
- **Engineer Reports** — Monthly usage per engineer with transaction detail
- **Transaction Log** — Complete history with CSV export
- **Settings** — Add/remove engineers, adjust reorder threshold, connect GitHub sync

## 🔑 Notes

- Materials list (`materials.xlsx`) is shared via Git the same way as before
- Engineers + issued transactions are shared via Git too, once GitHub Sync is connected (see above)
- Without GitHub Sync connected, data stays local to that browser only
- Password: `mep2024` (for Excel file protection only)
