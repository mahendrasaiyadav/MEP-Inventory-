/**
 * MEP Inventory — Sync Worker (Cloudflare D1 + R2)
 * ----------------------------------------------------------------
 * A real shared database for the app. No GitHub involved anywhere —
 * this worker never reads or writes your GitHub repo.
 *
 *   - Cloudflare D1  → SQL database: engineers, transactions, settings.
 *     Every engineer / transaction is its own row, written directly —
 *     there is no "merge the whole file" step, so there is no way for
 *     one device's write to silently undo another device's write.
 *   - Cloudflare R2  → file storage: the current materials list (JSON),
 *     every materials.xlsx you upload (kept, timestamped, forever), and
 *     a full snapshot every time Admin Settings clears data.
 *
 * ONE-TIME SETUP (~10 minutes, Cloudflare dashboard only, no CLI):
 *  1. https://dash.cloudflare.com → sign up free.
 *  2. Workers & Pages → D1 → Create database → name it "mep-db".
 *     Open it → Console tab → paste the contents of schema.sql (next to
 *     this file) → Run. This creates the tables.
 *  3. R2 → Create bucket → name it "mep-files".
 *  4. Workers & Pages → Create → Create Worker → name it "mep-sync" →
 *     paste this whole file in, replacing the default code → Deploy.
 *  5. Worker → Settings → Bindings:
 *       - Add D1 database binding: variable name "DB" → select "mep-db"
 *       - Add R2 bucket binding:  variable name "FILES" → select "mep-files"
 *       - Add a secret variable: SYNC_KEY = <make up any random string>
 *  6. Copy the Worker's URL (https://mep-sync.<you>.workers.dev).
 *     Paste it into app.js → SYNC_PROXY_URL, and the same SYNC_KEY into
 *     app.js → SYNC_KEY. Push app.js to GitHub Pages. Done.
 * ----------------------------------------------------------------
 */

function cors() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,X-Sync-Key',
  };
}
function json(obj, status, extraHeaders) {
  return new Response(JSON.stringify(obj), { status: status || 200, headers: { ...cors(), 'Content-Type': 'application/json', ...(extraHeaders||{}) } });
}
function checkKey(request, env) {
  const key = request.headers.get('X-Sync-Key');
  return env.SYNC_KEY && key === env.SYNC_KEY;
}
function b64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/* ── /state — everything a device needs on load / poll, one round trip ── */
async function getState(env) {
  const engineersRes = await env.DB.prepare(
    `SELECT name, designation, updated_at as updatedAt FROM engineers WHERE deleted = 0 ORDER BY name`
  ).all();
  const txRes = await env.DB.prepare(
    `SELECT id, date, time, engineer, cat, desc, spec, uom, qty,
            stock_before as stockBefore, stock_after as stockAfter, remarks
     FROM transactions ORDER BY date, time, id`
  ).all();
  const settingsRow = await env.DB.prepare(`SELECT value FROM settings WHERE key='main'`).first();
  const metaRow = await env.DB.prepare(`SELECT version FROM materials_meta WHERE id=1`).first();

  let settings = { reorderPct: 20 };
  if (settingsRow && settingsRow.value) { try { settings = JSON.parse(settingsRow.value); } catch(e) {} }

  return {
    engineers: engineersRes.results || [],
    transactions: txRes.results || [],
    settings,
    materialsVersion: metaRow ? metaRow.version : 0,
  };
}

async function handleState(request, env) {
  if (!checkKey(request, env)) return json({ error: 'Unauthorized' }, 401);
  const state = await getState(env);
  return json(state);
}

/* ── /engineers — upsert one engineer row (add, edit, or soft-delete) ─── */
async function handleEngineers(request, env) {
  if (!checkKey(request, env)) return json({ error: 'Unauthorized' }, 401);
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  const body = await request.json(); // { name, designation, deleted }
  if (!body.name) return json({ error: 'name required' }, 400);
  const nameKey = body.name.trim().toLowerCase();
  const updatedAt = Date.now();
  await env.DB.prepare(
    `INSERT INTO engineers (name_key, name, designation, deleted, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(name_key) DO UPDATE SET
       name=excluded.name, designation=excluded.designation,
       deleted=excluded.deleted, updated_at=excluded.updated_at
     WHERE excluded.updated_at >= engineers.updated_at`
  ).bind(nameKey, body.name.trim(), body.designation || '', body.deleted ? 1 : 0, updatedAt).run();
  return json({ ok: true, updatedAt });
}

/* ── /transactions — insert one transaction (append-only, never edited) ─ */
async function handleTransactions(request, env) {
  if (!checkKey(request, env)) return json({ error: 'Unauthorized' }, 401);
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  const t = await request.json();
  if (!t.id) return json({ error: 'id required' }, 400);
  await env.DB.prepare(
    `INSERT INTO transactions (id, date, time, engineer, cat, desc, spec, uom, qty, stock_before, stock_after, remarks, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO NOTHING`
  ).bind(t.id, t.date||'', t.time||'', t.engineer||'', t.cat||'', t.desc||'', t.spec||'', t.uom||'',
         t.qty||0, t.stockBefore||0, t.stockAfter||0, t.remarks||'', Date.now()).run();
  return json({ ok: true });
}

/* ── /settings — single-row upsert, last-write-wins by timestamp ──────── */
async function handleSettings(request, env) {
  if (!checkKey(request, env)) return json({ error: 'Unauthorized' }, 401);
  if (request.method !== 'PUT') return json({ error: 'Method not allowed' }, 405);
  const s = await request.json(); // { reorderPct, ... }
  const updatedAt = Date.now();
  await env.DB.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES ('main', ?, ?)
     ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at
     WHERE excluded.updated_at >= settings.updated_at`
  ).bind(JSON.stringify(s), updatedAt).run();
  return json({ ok: true, updatedAt });
}

/* ── /materials — GET current list, POST a new upload (xlsx + parsed) ─── */
async function handleMaterialsGet(request, env) {
  if (!checkKey(request, env)) return json({ error: 'Unauthorized' }, 401);
  const obj = await env.FILES.get('materials-current.json');
  if (!obj) return json({ materials: {} });
  const text = await obj.text();
  let materials = {};
  try { materials = JSON.parse(text); } catch(e) {}
  return json({ materials });
}

async function handleMaterialsPost(request, env) {
  if (!checkKey(request, env)) return json({ error: 'Unauthorized' }, 401);
  const body = await request.json(); // { parsed, filename, fileBase64 }
  if (!body.parsed) return json({ error: 'parsed materials required' }, 400);

  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const safeName = (body.filename || 'materials.xlsx').replace(/[^a-zA-Z0-9_.-]/g, '_');

  // Keep the raw uploaded file, timestamped, forever — never overwritten.
  if (body.fileBase64) {
    await env.FILES.put(`materials-uploads/${ts}-${safeName}`, b64ToBytes(body.fileBase64), {
      httpMetadata: { contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
    });
  }
  // Overwrite the "current" pointer every device reads from.
  await env.FILES.put('materials-current.json', JSON.stringify(body.parsed));

  await env.DB.prepare(
    `INSERT INTO materials_meta (id, version, updated_at) VALUES (1, 1, ?)
     ON CONFLICT(id) DO UPDATE SET version = materials_meta.version + 1, updated_at = excluded.updated_at`
  ).bind(Date.now()).run();

  const metaRow = await env.DB.prepare(`SELECT version FROM materials_meta WHERE id=1`).first();
  return json({ ok: true, version: metaRow ? metaRow.version : 1, storedAs: `materials-uploads/${ts}-${safeName}` });
}

/* ── /admin/clear-all & /admin/clear-transactions ──────────────────────
   The ONLY endpoints allowed to delete rows. Both archive a full snapshot
   to R2 first (a brand-new timestamped file — nothing is overwritten). */
async function snapshotToR2(env, name) {
  const state = await getState(env);
  const materialsObj = await env.FILES.get('materials-current.json');
  const materials = materialsObj ? JSON.parse(await materialsObj.text()) : {};
  const snapshot = { ...state, materials, archivedAt: new Date().toISOString() };
  const path = `archive/${name}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  await env.FILES.put(path, JSON.stringify(snapshot, null, 2));
  return path;
}

async function handleClearAll(request, env) {
  if (!checkKey(request, env)) return json({ error: 'Unauthorized' }, 401);
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  const archivedPath = await snapshotToR2(env, 'data-cleared');
  await env.DB.batch([
    env.DB.prepare('DELETE FROM transactions'),
    env.DB.prepare('DELETE FROM engineers'),
    env.DB.prepare(`DELETE FROM settings`),
  ]);
  await env.FILES.put('materials-current.json', JSON.stringify({}));
  await env.DB.prepare(
    `INSERT INTO materials_meta (id, version, updated_at) VALUES (1, 1, ?)
     ON CONFLICT(id) DO UPDATE SET version = materials_meta.version + 1, updated_at = excluded.updated_at`
  ).bind(Date.now()).run();
  return json({ ok: true, archivedPath });
}

async function handleClearTransactions(request, env) {
  if (!checkKey(request, env)) return json({ error: 'Unauthorized' }, 401);
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  const archivedPath = await snapshotToR2(env, 'transactions-cleared');
  await env.DB.prepare('DELETE FROM transactions').run();
  return json({ ok: true, archivedPath });
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors() });
    const url = new URL(request.url);
    try {
      switch (url.pathname) {
        case '/state': return await handleState(request, env);
        case '/engineers': return await handleEngineers(request, env);
        case '/transactions': return await handleTransactions(request, env);
        case '/settings': return await handleSettings(request, env);
        case '/materials':
          return request.method === 'GET' ? await handleMaterialsGet(request, env) : await handleMaterialsPost(request, env);
        case '/admin/clear-all': return await handleClearAll(request, env);
        case '/admin/clear-transactions': return await handleClearTransactions(request, env);
        default: return json({ error: 'Not found' }, 404);
      }
    } catch (err) {
      return json({ error: err.message }, 500);
    }
  },
};
