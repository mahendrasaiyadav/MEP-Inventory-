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

1. **Auto-loads** `materials.xlsx` on first visit
2. All data (stock levels, usage, engineers) stored in **browser localStorage**
3. Stock deducts automatically when you record usage
4. Push a new `materials.xlsx` to GitHub → users get the updated material list on next load

## 📱 Features

- **Dashboard** — KPIs, category stock bars, low-stock alerts, recent transactions
- **Material Overview** — Search and filter all materials with live stock status
- **Record Usage** — Issue materials to engineers with stock validation
- **Engineer Reports** — Monthly usage per engineer with transaction detail
- **Transaction Log** — Complete history with CSV export
- **Settings** — Add/remove engineers, adjust reorder threshold

## 🔑 Notes

- Usage data is stored **per browser** in localStorage
- For team use: consider a backend (Supabase, Firebase) — see extended version
- Password: `mep2024` (for Excel file protection only)
