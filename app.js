/* ════════════════════════════════════════════════════════════════════════════
   MEP Material Inventory — app.js
   All data stored in localStorage. Excel loaded via SheetJS (xlsx).
   ════════════════════════════════════════════════════════════════════════════ */
const SYNC_PROXY_URL = 'https://mep-sync-api.mahendrasaiyadav.workers.dev';
const SYNC_KEY = 'mep-sync-8823';
/* ── STATE ──────────────────────────────────────────────────────────────── */
const STATE = {
  materials: {},   // { category: [ {sno,desc,spec,uom,physicalQty,used} ] }
  transactions: [], // [ {id,date,time,engineer,category,desc,spec,uom,qty,stockBefore,stockAfter,remarks} ]
  engineers: [],   // [ {name,designation} ]
  settings: { reorderPct: 20 },
};

const CATEGORY_COLORS = {
  MS:'#3b82f6', GI:'#22c55e', CPVC:'#f59e0b', FP:'#ef4444',
  COMPOSITE:'#8b5cf6', VALVES:'#06b6d4', PVC:'#f97316',
  ELECTRICAL:'#eab308', MISCELLANEOUS:'#6b7280',
};
function catColor(cat) { return CATEGORY_COLORS[cat] || '#6b7280'; }

/* ── PERSISTENCE ─────────────────────────────────────────────────────────── */
function save() {
  localStorage.setItem('mep_materials',     JSON.stringify(STATE.materials));
  localStorage.setItem('mep_transactions',  JSON.stringify(STATE.transactions));
  localStorage.setItem('mep_engineers',     JSON.stringify(STATE.engineers));
  localStorage.setItem('mep_settings',      JSON.stringify(STATE.settings));
}
function load() {
  try {
    const m = localStorage.getItem('mep_materials');
    const t = localStorage.getItem('mep_transactions');
    const e = localStorage.getItem('mep_engineers');
    const s = localStorage.getItem('mep_settings');
    if (m) STATE.materials    = JSON.parse(m);
    if (t) STATE.transactions = JSON.parse(t);
    if (e) STATE.engineers    = JSON.parse(e);
    if (s) STATE.settings     = JSON.parse(s);
  } catch(err) { console.warn('Load error', err); }
  recomputeUsed();
}

/* ── DERIVE USAGE FROM TRANSACTIONS (single source of truth) ────────────── */
// item.used is always recomputed from STATE.transactions so that syncing
// engineers+transactions across devices is enough to keep stock correct
// everywhere — no separate "used" counter needs to be merged/synced.
function recomputeUsed() {
  Object.values(STATE.materials).forEach(items => items.forEach(i => { i.used = 0; }));
  STATE.transactions.forEach(t => {
    const items = STATE.materials[t.cat];
    if (!items) return;
    const item = items.find(i => i.desc === t.desc && i.spec === t.spec);
    if (item) item.used += t.qty;
  });
}
/* ── SYNC — real shared database via Cloudflare (D1 + R2) ───────────────────
   No GitHub involved. Each engineer and each transaction is its own row in
   a Cloudflare D1 database, written directly through the Worker — there is
   no "download the whole file, merge, re-upload" step, so one device's
   write can never silently undo another device's write (this is what was
   causing added engineers to vanish after sync). Materials live in
   Cloudflare R2 as files, also independent of GitHub — see
   sync-worker/worker.js.

   SYNC_PROXY_URL / SYNC_KEY are NOT secrets — SYNC_KEY is just a low-value
   shared key to keep random internet traffic off the Worker; the real
   database/bucket credentials live only in Cloudflare's own bindings. */

let ghSyncing = false;
let ghPollTimer = null;
let lastMaterialsVersion = -1;

function syncConfigured() {
  return SYNC_PROXY_URL && !SYNC_PROXY_URL.includes('REPLACE-WITH');
}

function setSyncBadge(state, text) {
  const el = document.getElementById('liveStatus');
  if (!el) return;
  el.className = 'badge-live' + (state === 'ok' ? '' : ' ' + state);
  el.textContent = text;
}

function syncHeaders(extra) {
  return { 'X-Sync-Key': SYNC_KEY, ...(extra || {}) };
}

// GET /state — engineers, transactions, settings, materialsVersion in one call.
async function fetchState() {
  const res = await fetch(`${SYNC_PROXY_URL}/state`, { headers: syncHeaders() });
  if (!res.ok) throw new Error(`Sync read failed (${res.status})`);
  return res.json();
}

// GET /materials — the current materials list (from R2).
async function fetchMaterials() {
  const res = await fetch(`${SYNC_PROXY_URL}/materials`, { headers: syncHeaders() });
  if (!res.ok) throw new Error(`Materials read failed (${res.status})`);
  const json = await res.json();
  return json.materials || {};
}

// POST /engineers — upsert a single engineer (add, edit, or soft-delete).
async function pushEngineer(eng) {
  const res = await fetch(`${SYNC_PROXY_URL}/engineers`, {
    method: 'POST',
    headers: syncHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(eng),
  });
  if (!res.ok) throw new Error(`Engineer sync failed (${res.status})`);
  return res.json();
}

// POST /transactions — insert one transaction (append-only).
async function pushTransaction(t) {
  const res = await fetch(`${SYNC_PROXY_URL}/transactions`, {
    method: 'POST',
    headers: syncHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(t),
  });
  if (!res.ok) throw new Error(`Transaction sync failed (${res.status})`);
  return res.json();
}

// PUT /settings — single-row upsert.
async function pushSettings(s) {
  const res = await fetch(`${SYNC_PROXY_URL}/settings`, {
    method: 'PUT',
    headers: syncHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(s),
  });
  if (!res.ok) throw new Error(`Settings sync failed (${res.status})`);
  return res.json();
}

// POST /materials — upload a new materials.xlsx: stored as a timestamped
// file in R2 (kept forever) and set as the new "current" list for everyone.
async function pushMaterials(parsed, filename, fileBase64) {
  const res = await fetch(`${SYNC_PROXY_URL}/materials`, {
    method: 'POST',
    headers: syncHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ parsed, filename, fileBase64 }),
  });
  if (!res.ok) throw new Error(`Materials upload failed (${res.status})`);
  return res.json(); // { ok, version, storedAs }
}


// Apply a /state payload to local STATE (server is authoritative — no local
// merge needed since D1 already resolved everything at the row level).
function applyState(state) {
  STATE.engineers = (state.engineers || []).map(e => ({ name: e.name, designation: e.designation }));
  STATE.transactions = state.transactions || [];
  STATE.settings = state.settings || STATE.settings;
  lastMaterialsVersion = state.materialsVersion;
}

// Pull latest state (+ materials if the version changed) and render.
// Used for page load and background polling — READ ONLY, writes nothing.
async function ghPullOnly(showToast) {
  if (!syncConfigured()) { setSyncBadge('local', '● LOCAL ONLY'); return; }
  if (ghSyncing) return;
  ghSyncing = true;
  setSyncBadge('syncing', '⏳ SYNCING');
  const statusEl = document.getElementById('ghStatus');
  try {
    const state = await fetchState();
    const materialsChanged = state.materialsVersion !== lastMaterialsVersion;
    applyState(state);
    if (materialsChanged) {
      STATE.materials = await fetchMaterials();
    }
    recomputeUsed();
    save();
    renderAll();
    setSyncBadge('ok', '● LIVE');
    if (statusEl) { statusEl.textContent = `✓ Loaded from server at ${new Date().toLocaleTimeString()}`; statusEl.className = 'load-status ok'; }
    if (showToast) toast('Loaded latest data ✓', 'ok');
  } catch (err) {
    console.warn('Pull error', err);
    setSyncBadge('err', '✖ SYNC ERROR');
    if (statusEl) { statusEl.textContent = `Error: ${err.message}`; statusEl.className = 'load-status err'; }
    if (showToast) toast('Could not load latest data', 'err');
  } finally {
    ghSyncing = false;
  }
}

// Background poll — same as ghPullOnly but quiet and only re-renders if
// something actually changed, so it doesn't interrupt anyone mid-typing.
async function ghPollOnce() {
  if (!syncConfigured() || ghSyncing) return;
  try {
    const state = await fetchState();
    const before = JSON.stringify([STATE.engineers, STATE.transactions, STATE.settings, lastMaterialsVersion]);
    const materialsChanged = state.materialsVersion !== lastMaterialsVersion;
    applyState(state);
    if (materialsChanged) STATE.materials = await fetchMaterials();
    const after = JSON.stringify([STATE.engineers, STATE.transactions, STATE.settings, lastMaterialsVersion]);
    if (before !== after) { recomputeUsed(); save(); renderAll(); toast('New data synced', 'ok'); }
    setSyncBadge('ok', '● LIVE');
  } catch (err) {
    setSyncBadge('err', '✖ SYNC ERROR');
  }
}

// Sync is fully automatic — every device that loads the site talks to the
// same Worker with no per-device setup or token entry required. Loading
// the page and polling are READ-ONLY. Writes only happen from real user
// actions (see pushEngineer / pushTransaction / pushSettings / pushMaterials
// call sites) or from Admin Settings' clear actions.
function initGitHubSync() {
  clearInterval(ghPollTimer);
  if (syncConfigured()) {
    ghPullOnly(false);
    ghPollTimer = setInterval(ghPollOnce, 25000);
  } else {
    setSyncBadge('local', '● LOCAL ONLY (Worker not configured yet)');
  }
}

/* ── EXCEL PARSING ───────────────────────────────────────────────────────── */
function parseExcel(file, onDone) {
  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const wb = XLSX.read(e.target.result, { type: 'array' });
      const result = {};
      wb.SheetNames.forEach(name => {
        const ws = wb.Sheets[name];
        const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
        if (rows.length < 2) return;

        // Find header row — look for "Material Description" or "S.No"
        let headerIdx = 0;
        for (let i = 0; i < Math.min(rows.length, 5); i++) {
          const row = rows[i].map(c => String(c).trim().toLowerCase());
          if (row.some(c => c.includes('material') || c.includes('s.no') || c.includes('sno'))) {
            headerIdx = i; break;
          }
        }
        const headers = rows[headerIdx].map(c => String(c).trim().toLowerCase());

        // Map columns
        const colIdx = (keywords) => {
          for (const kw of keywords) {
            const idx = headers.findIndex(h => h.includes(kw));
            if (idx !== -1) return idx;
          }
          return -1;
        };
        const iDesc = colIdx(['material description', 'description', 'material']);
        const iSpec = colIdx(['specification', 'spec']);
        const iUOM  = colIdx(['uom', 'unit']);
        const iQty  = colIdx(['qty', 'quantity', 'physical']);

        if (iDesc === -1) return; // skip if no material column

        const items = [];
        for (let r = headerIdx + 1; r < rows.length; r++) {
          const row = rows[r];
          const desc = String(row[iDesc] || '').trim();
          if (!desc) continue;
          items.push({
            sno:  items.length + 1,
            desc,
            spec: String(row[iSpec] || '').trim(),
            uom:  String(row[iUOM]  || '').trim(),
            physicalQty: parseFloat(row[iQty]) || 0,
            used: 0,
          });
        }
        if (items.length) result[name] = items;
      });
      onDone(null, result);
    } catch(err) { onDone(err); }
  };
  reader.readAsArrayBuffer(file);
}

/* ── AUTO-LOAD materials.xlsx FROM REPO ──────────────────────────────────── */
/* ── LOCAL FALLBACK materials.xlsx ────────────────────────────────────────
   Cloudflare (R2, via the Worker) is the source of truth for materials once
   configured — see fetchMaterials()/ghPullOnly(). This bundled file is only
   a read-only fallback for first-time use before Cloudflare is set up; the
   app never writes back to it or to the GitHub repo. */
async function tryAutoLoad() {
  if (Object.keys(STATE.materials).length > 0) return; // already have data
  if (syncConfigured()) return; // Cloudflare is the source of truth once configured
  try {
    const res = await fetch('materials.xlsx');
    if (!res.ok) return;
    const buf = await res.arrayBuffer();
    const wb = XLSX.read(buf, { type: 'array' });
    const result = {};
    wb.SheetNames.forEach(name => {
      const ws = wb.Sheets[name];
      const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
      if (rows.length < 2) return;
      let hi = 0;
      for (let i = 0; i < Math.min(rows.length,5); i++) {
        const r = rows[i].map(c=>String(c).trim().toLowerCase());
        if (r.some(c=>c.includes('material')||c.includes('s.no'))) { hi=i; break; }
      }
      const hdrs = rows[hi].map(c=>String(c).trim().toLowerCase());
      const ci = kws => { for(const k of kws){const x=hdrs.findIndex(h=>h.includes(k));if(x!==-1)return x;} return -1; };
      const iD=ci(['material description','description','material']);
      const iS=ci(['specification','spec']);
      const iU=ci(['uom','unit']);
      const iQ=ci(['qty','quantity','physical']);
      if(iD===-1) return;
      const items=[];
      for(let r=hi+1;r<rows.length;r++){
        const row=rows[r];
        const desc=String(row[iD]||'').trim();
        if(!desc) continue;
        items.push({sno:items.length+1,desc,spec:String(row[iS]||'').trim(),
          uom:String(row[iU]||'').trim(),physicalQty:parseFloat(row[iQ])||0,used:0});
      }
      if(items.length) result[name]=items;
    });
    if (Object.keys(result).length) {
      STATE.materials = result;
      recomputeUsed();
      save();
      renderAll();
      toast('Materials loaded from materials.xlsx ✓','ok');
    }
  } catch(e) { /* silently skip if no file */ }
}

/* ── HELPERS ──────────────────────────────────────────────────────────────── */
function available(item) { return Math.max(0, item.physicalQty - item.used); }
function statusOf(item) {
  const avail = available(item);
  const pct   = item.physicalQty > 0 ? (avail / item.physicalQty) * 100 : 0;
  if (avail <= 0) return 'crit';
  if (pct <= STATE.settings.reorderPct) return 'low';
  return 'ok';
}
function pillHtml(status) {
  const map = { ok:['🟢','OK'], low:['🟡','LOW'], crit:['🔴','CRITICAL'] };
  const [icon,lbl] = map[status] || map.ok;
  return `<span class="pill ${status}">${icon} ${lbl}</span>`;
}
function fmt(n) { return Number(n).toLocaleString(); }
function today() { return new Date().toISOString().split('T')[0]; }
function nowTime() {
  const d = new Date();
  return d.toTimeString().slice(0,5);
}
function fmtDate(d) {
  if (!d) return '—';
  const dt = new Date(d + 'T00:00:00');
  return dt.toLocaleDateString('en-GB', { day:'2-digit', month:'short', year:'numeric' });
}
function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2,6); }

function toast(msg, type='ok') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = `toast show ${type}`;
  clearTimeout(el._timer);
  el._timer = setTimeout(() => { el.className = 'toast'; }, 3200);
}

function allMaterials() {
  const arr = [];
  Object.entries(STATE.materials).forEach(([cat, items]) => {
    items.forEach(item => arr.push({ cat, ...item }));
  });
  return arr;
}

function totalStats() {
  const items = allMaterials();
  return {
    total:   items.length,
    totalPhy: items.reduce((s,i)=>s+i.physicalQty,0),
    totalUsed: items.reduce((s,i)=>s+i.used,0),
    totalAvail: items.reduce((s,i)=>s+available(i),0),
    low:  items.filter(i=>statusOf(i)==='low').length,
    crit: items.filter(i=>statusOf(i)==='crit').length,
  };
}

/* ── NAV ─────────────────────────────────────────────────────────────────── */
const pageTitles = {
  dashboard:'Dashboard', overview:'Material Overview',
  usage:'Record Usage', engineers:'Engineer Reports',
  history:'Transaction Log', settings:'Settings',
};
let currentPage = 'dashboard';

function showPage(page) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  document.getElementById(`page-${page}`).classList.add('active');
  document.querySelector(`[data-page="${page}"]`).classList.add('active');
  document.getElementById('pageTitle').textContent = pageTitles[page];
  currentPage = page;
  renderPage(page);
  // close mobile sidebar
  document.getElementById('sidebar').classList.remove('open');
}

function renderPage(page) {
  if (page === 'dashboard')  renderDashboard();
  if (page === 'overview')   renderOverview();
  if (page === 'usage')      renderUsagePage();
  if (page === 'engineers')  renderEngineers();
  if (page === 'history')    renderHistory();
  if (page === 'settings')   renderSettings();
}

function renderAll() { renderPage(currentPage); }

/* ── DASHBOARD ───────────────────────────────────────────────────────────── */
function renderDashboard() {
  const stats = totalStats();
  const txToday = STATE.transactions.filter(t=>t.date===today());

  // KPIs — each is clickable and jumps to the relevant place
  const kpis = [
    { icon:'📦', value: fmt(stats.total), label:'Total Materials',
      sub:`${Object.keys(STATE.materials).length} categories`, accent:'var(--accent)',
      nav: ()=> showPage('overview') },
    { icon:'⚠️', value: stats.low + stats.crit, label:'Low / Critical',
      sub:`${stats.crit} critical, ${stats.low} low`, accent:'var(--red)',
      nav: ()=> { showPage('dashboard'); setTimeout(()=>document.getElementById('lowStockSection')?.scrollIntoView({behavior:'smooth',block:'start'}), 50); } },
    { icon:'📅', value: txToday.reduce((s,t)=>s+t.qty,0), label:"Today's Issues",
      sub:`${txToday.length} transactions`, accent:'var(--orange)',
      nav: ()=> showPage('usage') },
    { icon:'👷', value: STATE.engineers.length, label:'Engineers',
      sub:'Active team members', accent:'#06b6d4',
      nav: ()=> showPage('engineers') },
  ];
  document.getElementById('kpiRow').innerHTML = kpis.map(k=>`
    <div class="kpi-card clickable" style="--kpi-accent:${k.accent}">
      <div class="kpi-icon">${k.icon}</div>
      <div class="kpi-value">${k.value}</div>
      <div class="kpi-label">${k.label}</div>
      <div class="kpi-sub">${k.sub}</div>
    </div>`).join('');
  document.querySelectorAll('#kpiRow .kpi-card').forEach((card, idx)=>{
    card.addEventListener('click', ()=> kpis[idx].nav && kpis[idx].nav());
  });

  renderCatMatSummary();

  // Recent transactions
  const recent = [...STATE.transactions].reverse().slice(0,8);
  document.getElementById('recentTxList').innerHTML = recent.length
    ? recent.map(t=>`<div class="alert-item">
        <div class="alert-dot green"></div>
        <div class="alert-main">
          <div class="alert-name">${t.engineer} — ${t.desc}</div>
          <div class="alert-meta">${t.cat} · ${fmtDate(t.date)} ${t.time}</div>
        </div>
        <div class="alert-val">${fmt(t.qty)} ${t.uom}</div>
      </div>`).join('')
    : `<div class="empty-state">No transactions yet</div>`;

  // Low / critical stock — full list, at the bottom
  const lowItems = allMaterials().filter(i=>statusOf(i)!=='ok')
    .sort((a,b)=>available(a)-available(b));
  document.getElementById('lowStockList').innerHTML = lowItems.length
    ? lowItems.map(i=>{
        const st = statusOf(i);
        return `<div class="alert-item">
          <div class="alert-dot ${st==='crit'?'red':'yellow'}"></div>
          <div class="alert-main">
            <div class="alert-name">${i.desc} <span style="color:var(--text-muted);font-size:11px">${i.spec}</span></div>
            <div class="alert-meta">${i.cat} · ${i.uom}</div>
          </div>
          <div class="alert-val" style="color:${st==='crit'?'var(--red)':'var(--yellow)'}">${fmt(available(i))}</div>
        </div>`;}).join('')
    : `<div class="empty-state">✅ All stocks are healthy</div>`;

  renderMonthlyUsage();
}

/* ── CATEGORY & MATERIAL SUMMARY (grouped by material description) ──────── */
function renderCatMatSummary() {
  const el = document.getElementById('catMatSummary');
  const entries = Object.entries(STATE.materials);
  if (!entries.length) { el.innerHTML = `<div class="empty-state">No materials loaded yet.</div>`; return; }

  const openCats = new Set(
    [...el.querySelectorAll('.cms-group.open')].map(g=>g.dataset.cat)
  );

  el.innerHTML = entries.map(([cat, items])=>{
    const color   = catColor(cat);
    const catPhy  = items.reduce((s,i)=>s+i.physicalQty,0);
    const catUsed = items.reduce((s,i)=>s+(i.used||0),0);
    const catAvail= Math.max(0, catPhy - catUsed);

    // Group every spec-row under its Material Description
    const byDesc = {};
    items.forEach(i=>{
      if (!byDesc[i.desc]) byDesc[i.desc] = { desc:i.desc, phy:0, used:0, specs:0 };
      byDesc[i.desc].phy   += i.physicalQty;
      byDesc[i.desc].used  += (i.used||0);
      byDesc[i.desc].specs += 1;
    });
    const rows = Object.values(byDesc).sort((a,b)=>a.desc.localeCompare(b.desc));
    const isOpen = openCats.has(cat);

    return `
      <div class="cms-group${isOpen?' open':''}" data-cat="${cat}">
        <div class="cms-head">
          <div class="cms-head-left">
            <span class="cms-caret">▶</span>
            <span class="cms-dot" style="background:${color}"></span>
            <span class="cms-cat-name">${cat}</span>
          </div>
          <div class="cms-head-nums">${fmt(catAvail)} avail / ${fmt(catPhy)} total · ${rows.length} materials</div>
        </div>
        <div class="cms-body">
          <div class="cms-colhead"><span>Material Description</span><span>Physical</span><span>Used</span><span>Available</span><span>Specs</span></div>
          ${rows.map(r=>{
            const avail = Math.max(0, r.phy - r.used);
            return `<div class="cms-row">
              <div class="cms-mat-name">${r.desc}</div>
              <div class="cms-num">${fmt(r.phy)}</div>
              <div class="cms-num">${fmt(r.used)}</div>
              <div class="cms-num avail">${fmt(avail)}</div>
              <div class="cms-num">${r.specs}</div>
            </div>`;
          }).join('')}
        </div>
      </div>`;
  }).join('');

  el.querySelectorAll('.cms-head').forEach(head=>{
    head.addEventListener('click', ()=> head.closest('.cms-group').classList.toggle('open'));
  });
}

/* ── MONTHLY USAGE ────────────────────────────────────────────────────────── */
function renderMonthlyUsage() {
  const el = document.getElementById('monthlyUsageBars');
  if (!STATE.transactions.length) { el.innerHTML = `<div class="empty-state">No usage recorded yet</div>`; return; }

  const map = {};
  STATE.transactions.forEach(t=>{
    const key = (t.date||'').slice(0,7); // YYYY-MM
    if (!key) return;
    map[key] = (map[key]||0) + t.qty;
  });
  const monthNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const keys = Object.keys(map).sort().slice(-12); // last 12 months with activity
  const max  = Math.max(...keys.map(k=>map[k]), 1);

  el.innerHTML = keys.map(k=>{
    const [y,m] = k.split('-');
    const label = `${monthNames[parseInt(m,10)-1]} ${y}`;
    const val   = map[k];
    const pct   = Math.round((val/max)*100);
    return `<div class="mu-row">
      <div class="mu-label">${label}</div>
      <div class="mu-track"><div class="mu-fill" style="width:${pct}%"></div></div>
      <div class="mu-val">${fmt(val)}</div>
    </div>`;
  }).join('');
}

/* ── OVERVIEW ─────────────────────────────────────────────────────────────── */
let overviewFilter = 'ALL';
function renderOverview() {
  const cats = ['ALL', ...Object.keys(STATE.materials)];
  document.getElementById('categoryFilters').innerHTML = cats.map(c=>`
    <span class="chip ${c===overviewFilter?'active':''}" data-cat="${c}">${c}</span>`).join('');

  document.querySelectorAll('#categoryFilters .chip').forEach(chip=>{
    chip.addEventListener('click', ()=>{
      overviewFilter = chip.dataset.cat;
      renderOverview();
    });
  });
  filterOverview();
}

function filterOverview() {
  const q  = (document.getElementById('overviewSearch').value || '').toLowerCase();
  const items = allMaterials().filter(i=>{
    const catOk = overviewFilter==='ALL' || i.cat===overviewFilter;
    const qOk   = !q || i.desc.toLowerCase().includes(q) || i.spec.toLowerCase().includes(q) || i.cat.toLowerCase().includes(q);
    return catOk && qOk;
  });
  document.getElementById('overviewBody').innerHTML = items.length
    ? items.map(i=>{
        const avail = available(i);
        const st    = statusOf(i);
        return `<tr>
          <td><span class="cat-tag">${i.cat}</span></td>
          <td>${i.desc}</td>
          <td style="color:var(--text-muted)">${i.spec||'—'}</td>
          <td>${i.uom}</td>
          <td class="num">${fmt(i.physicalQty)}</td>
          <td class="num" style="color:var(--text-muted)">${fmt(i.used)}</td>
          <td class="num" style="font-weight:700">${fmt(avail)}</td>
          <td>${pillHtml(st)}</td>
        </tr>`;}).join('')
    : `<tr><td colspan="8" class="empty-state">No materials found</td></tr>`;
}

/* ── USAGE PAGE ──────────────────────────────────────────────────────────── */
function renderUsagePage() {
  // Set today's date
  const dateEl = document.getElementById('usageDate');
  if (!dateEl.value) dateEl.value = today();

  // Populate engineer dropdown
  const engSel = document.getElementById('usageEngineer');
  const engVal = engSel.value;
  engSel.innerHTML = '<option value="">— Select Engineer —</option>' +
    STATE.engineers.map(e=>`<option value="${e.name}" ${e.name===engVal?'selected':''}>${e.name}</option>`).join('');

  // Populate category dropdown
  const catSel = document.getElementById('usageCategory');
  const catVal = catSel.value;
  catSel.innerHTML = '<option value="">— Select Category —</option>' +
    Object.keys(STATE.materials).map(c=>`<option value="${c}" ${c===catVal?'selected':''}>${c}</option>`).join('');

  renderTodayTable();
}

function updateMaterialDropdown() {
  const cat = document.getElementById('usageCategory').value;
  const matSel = document.getElementById('usageMaterial');
  matSel.innerHTML = '<option value="">— Select Material —</option>';
  resetSpecDropdown('— Select Material first —');
  if (!cat || !STATE.materials[cat]) return;
  const unique = {};
  STATE.materials[cat].forEach(item=>{
    if (!unique[item.desc]) unique[item.desc] = item;
  });
  Object.keys(unique).forEach(desc=>{
    const opt = document.createElement('option');
    opt.value = desc; opt.textContent = desc;
    matSel.appendChild(opt);
  });
}

function resetSpecDropdown(placeholder) {
  const specSel = document.getElementById('usageSpec');
  specSel.innerHTML = `<option value="">${placeholder}</option>`;
  document.getElementById('usageUOM').value = '';
  document.getElementById('usageAvailable').value = '';
}

// A material with a blank specification would otherwise share the same
// (empty) option value as the "please select" placeholder — use a sentinel
// so it's still a distinct, selectable choice.
const SPEC_NONE = '__NONE__';
function specEncode(spec) { return spec === '' ? SPEC_NONE : spec; }
function specDecode(val)  { return val === SPEC_NONE ? '' : val; }

// Material Description chosen → only show the Specifications that belong to
// that material name, so the engineer explicitly picks the right one.
function updateSpecDropdown() {
  const cat  = document.getElementById('usageCategory').value;
  const desc = document.getElementById('usageMaterial').value;
  resetSpecDropdown('— Select Specification —');
  if (!cat || !desc || !STATE.materials[cat]) return;
  const specs = STATE.materials[cat].filter(i=>i.desc===desc);
  const specSel = document.getElementById('usageSpec');
  specs.forEach(item=>{
    const opt = document.createElement('option');
    opt.value = specEncode(item.spec);
    opt.textContent = item.spec ? `${item.spec}  (${fmt(available(item))} ${item.uom} avail)` : `— No spec —  (${fmt(available(item))} ${item.uom} avail)`;
    specSel.appendChild(opt);
  });
}

// Specification chosen → auto-fill the read-only UOM / Available Stock fields
function updateUOMAvailFromSpec() {
  const cat  = document.getElementById('usageCategory').value;
  const desc = document.getElementById('usageMaterial').value;
  const spec = specDecode(document.getElementById('usageSpec').value);
  document.getElementById('usageUOM').value = '';
  document.getElementById('usageAvailable').value = '';
  if (!cat || !desc || !STATE.materials[cat]) return;
  const item = STATE.materials[cat].find(i=>i.desc===desc && i.spec===spec);
  if (!item) return;
  document.getElementById('usageUOM').value = item.uom || '';
  document.getElementById('usageAvailable').value = fmt(available(item));
}

function submitUsage() {
  const date   = document.getElementById('usageDate').value;
  const eng    = document.getElementById('usageEngineer').value;
  const cat    = document.getElementById('usageCategory').value;
  const desc   = document.getElementById('usageMaterial').value;
  const specRaw= document.getElementById('usageSpec').value;
  const spec   = specDecode(specRaw);
  const uom    = document.getElementById('usageUOM').value;
  const qtyStr = document.getElementById('usageQty').value;
  const rem    = document.getElementById('usageRemarks').value.trim();
  const msg    = document.getElementById('formMsg');

  if (!date)   { msg.textContent='Please select a date.';       msg.className='form-msg err'; return; }
  if (!eng)    { msg.textContent='Please select an engineer.';  msg.className='form-msg err'; return; }
  if (!cat)    { msg.textContent='Please select a category.';   msg.className='form-msg err'; return; }
  if (!desc)   { msg.textContent='Please select a material.';   msg.className='form-msg err'; return; }
  if (!specRaw) { msg.textContent='Please select a specification.'; msg.className='form-msg err'; return; }
  const qty = parseFloat(qtyStr);
  if (!qty || qty <= 0) { msg.textContent='Enter a valid quantity > 0.'; msg.className='form-msg err'; return; }

  // Find item and deduct
  const items = STATE.materials[cat];
  const idx   = items.findIndex(i=>i.desc===desc && i.spec===spec);
  if (idx === -1) { msg.textContent='Material / specification not found.'; msg.className='form-msg err'; return; }
  const item = items[idx];
  const avail = available(item);
  if (qty > avail) {
    msg.textContent=`Only ${fmt(avail)} ${uom} available. Cannot issue ${fmt(qty)}.`;
    msg.className='form-msg err'; return;
  }

  const stockBefore = avail;
  const stockAfter  = avail - qty;

  const newTxn = {
    id: uid(), date, time: nowTime(),
    engineer: eng, cat, desc, spec, uom, qty,
    stockBefore, stockAfter, remarks: rem,
  };
  STATE.transactions.push(newTxn);

  recomputeUsed();
  save();
  msg.textContent = `✓ Issued ${fmt(qty)} ${uom} of ${desc} to ${eng}`;
  msg.className = 'form-msg ok';
  document.getElementById('usageQty').value = '';
  document.getElementById('usageRemarks').value = '';
  document.getElementById('usageAvailable').value = fmt(available(item));

  renderTodayTable();
  toast(`Issued ${fmt(qty)} ${uom} · ${desc}`, 'ok');
  setTimeout(()=>{ msg.textContent=''; msg.className='form-msg'; }, 4000);

  if (syncConfigured()) {
    pushTransaction(newTxn).catch(err => toast('Saved locally, but failed to sync: ' + err.message, 'err'));
  }
}

function renderTodayTable() {
  const tx = STATE.transactions.filter(t=>t.date===today()).reverse();
  document.getElementById('todayBody').innerHTML = tx.length
    ? tx.map(t=>`<tr>
        <td style="color:var(--text-muted)">${t.time}</td>
        <td><strong>${t.engineer}</strong></td>
        <td>${t.desc}</td>
        <td style="color:var(--text-muted)">${t.spec||'—'}</td>
        <td>${t.uom}</td>
        <td class="num"><strong>${fmt(t.qty)}</strong></td>
        <td style="color:var(--text-muted)">${t.remarks||'—'}</td>
      </tr>`).join('')
    : `<tr><td colspan="7" class="empty-state">No issues recorded today</td></tr>`;
}

/* ── ENGINEER REPORTS ────────────────────────────────────────────────────── */
function renderEngineers() {
  // Month/year selectors
  const now = new Date();
  const repMonth = document.getElementById('repMonth');
  const repYear  = document.getElementById('repYear');
  if (!repMonth.options.length) {
    ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
      .forEach((m,i)=>{ const o=document.createElement('option'); o.value=i+1; o.textContent=m; repMonth.appendChild(o); });
    repMonth.value = now.getMonth()+1;
    for (let y=now.getFullYear()-2; y<=now.getFullYear()+1; y++) {
      const o=document.createElement('option'); o.value=y; o.textContent=y; repYear.appendChild(o);
    }
    repYear.value = now.getFullYear();
  }

  // Engineer filter in report table
  const repEng = document.getElementById('repEngineer');
  const prevEng = repEng.value;
  repEng.innerHTML = '<option value="">All Engineers</option>' +
    STATE.engineers.map(e=>`<option value="${e.name}" ${e.name===prevEng?'selected':''}>${e.name}</option>`).join('');

  applyEngFilter();
}

function applyEngFilter() {
  const month  = parseInt(document.getElementById('repMonth').value);
  const year   = parseInt(document.getElementById('repYear').value);
  const engFilter = document.getElementById('repEngineer').value;

  const filtered = STATE.transactions.filter(t=>{
    const d = new Date(t.date+'T00:00:00');
    return d.getMonth()+1===month && d.getFullYear()===year &&
      (!engFilter || t.engineer===engFilter);
  });

  // Engineer summary cards
  const engMap = {};
  filtered.forEach(t=>{
    if (!engMap[t.engineer]) engMap[t.engineer]={txns:0,qty:0};
    engMap[t.engineer].txns++;
    engMap[t.engineer].qty += t.qty;
  });

  // Show all engineers, even those with 0
  document.getElementById('engCards').innerHTML = STATE.engineers.map(e=>{
    const d = engMap[e.name] || {txns:0,qty:0};
    const initials = e.name.split(' ').map(w=>w[0]).join('').slice(0,2).toUpperCase();
    return `<div class="eng-card">
      <div class="eng-avatar">${initials}</div>
      <div class="eng-card-name">${e.name}</div>
      <div class="eng-card-desig">${e.designation||'Engineer'}</div>
      <div class="eng-stats">
        <div><div class="eng-stat-val">${d.txns}</div><div class="eng-stat-label">Issues</div></div>
        <div><div class="eng-stat-val">${fmt(d.qty)}</div><div class="eng-stat-label">Qty Used</div></div>
      </div>
    </div>`;
  }).join('') || `<div class="empty-state">No engineers added yet — go to Settings to add them.</div>`;

  // Detail table
  document.getElementById('repBody').innerHTML = filtered.length
    ? [...filtered].reverse().map(t=>`<tr>
        <td>${fmtDate(t.date)}</td>
        <td><strong>${t.engineer}</strong></td>
        <td><span class="cat-tag">${t.cat}</span></td>
        <td>${t.desc}</td>
        <td style="color:var(--text-muted)">${t.spec||'—'}</td>
        <td>${t.uom}</td>
        <td class="num"><strong>${fmt(t.qty)}</strong></td>
        <td style="color:var(--text-muted)">${t.remarks||'—'}</td>
      </tr>`).join('')
    : `<tr><td colspan="8" class="empty-state">No transactions for this period</td></tr>`;
}

/* ── HISTORY ──────────────────────────────────────────────────────────────── */
function renderHistory() {
  filterHistory();
}
function filterHistory() {
  const q = (document.getElementById('histSearch').value||'').toLowerCase();
  const tx = [...STATE.transactions].reverse().filter(t=>
    !q || t.engineer.toLowerCase().includes(q) || t.desc.toLowerCase().includes(q) ||
    t.cat.toLowerCase().includes(q) || (t.remarks||'').toLowerCase().includes(q)
  );
  document.getElementById('histBody').innerHTML = tx.length
    ? tx.map(t=>`<tr>
        <td>${fmtDate(t.date)}</td>
        <td style="color:var(--text-muted)">${t.time}</td>
        <td><strong>${t.engineer}</strong></td>
        <td><span class="cat-tag">${t.cat}</span></td>
        <td>${t.desc}</td>
        <td style="color:var(--text-muted)">${t.spec||'—'}</td>
        <td>${t.uom}</td>
        <td class="num"><strong>${fmt(t.qty)}</strong></td>
        <td class="num" style="color:var(--text-muted)">${fmt(t.stockBefore)}</td>
        <td class="num" style="color:var(--green)">${fmt(t.stockAfter)}</td>
        <td style="color:var(--text-muted)">${t.remarks||'—'}</td>
      </tr>`).join('')
    : `<tr><td colspan="11" class="empty-state">No transactions found</td></tr>`;
}

function exportCSV() {
  const headers = ['Date','Time','Engineer','Category','Material','Specification','UOM','Qty','Stock Before','Stock After','Remarks'];
  const rows = [...STATE.transactions].reverse().map(t=>[
    t.date, t.time, t.engineer, t.cat, t.desc, t.spec||'', t.uom,
    t.qty, t.stockBefore, t.stockAfter, t.remarks||''
  ]);
  const csv = [headers, ...rows].map(r=>r.map(v=>`"${String(v).replace(/"/g,'""')}"`).join(',')).join('\n');
  const a = document.createElement('a');
  a.href = 'data:text/csv;charset=utf-8,' + encodeURIComponent(csv);
  a.download = `mep-transactions-${today()}.csv`;
  a.click();
}

/* ── SETTINGS ─────────────────────────────────────────────────────────────── */
function renderSettings() {
  document.getElementById('reorderPct').value = STATE.settings.reorderPct;

  // Engineer list
  document.getElementById('engList').innerHTML = STATE.engineers.length
    ? STATE.engineers.map((e,i)=>`<div class="eng-list-item">
        <div class="eng-name">${e.name}</div>
        <div class="eng-role">${e.designation||''}</div>
        <button class="eng-del" data-idx="${i}" title="Remove">✕</button>
      </div>`).join('')
    : `<div class="empty-state" style="padding:16px">No engineers yet. Add below.</div>`;

  document.querySelectorAll('.eng-del').forEach(btn=>{
    btn.addEventListener('click',()=>{
      const idx = parseInt(btn.dataset.idx);
      const removed = STATE.engineers[idx];
      STATE.engineers.splice(idx,1);
      save(); renderSettings();
      toast('Engineer removed');
      if (removed && syncConfigured()) {
        pushEngineer({ name: removed.name, designation: removed.designation, deleted: true })
          .catch(err => toast('Removed locally, but failed to sync: ' + err.message, 'err'));
      }
    });
  });

  // Sync engineer select in usage page
  const engSel = document.getElementById('usageEngineer');
  const prev = engSel.value;
  engSel.innerHTML = '<option value="">— Select Engineer —</option>' +
    STATE.engineers.map(e=>`<option value="${e.name}" ${e.name===prev?'selected':''}>${e.name}</option>`).join('');
}

function addEngineer() {
  const name  = document.getElementById('newEngName').value.trim();
  const desig = document.getElementById('newEngDesig').value.trim();
  if (!name) { toast('Enter engineer name','err'); return; }
  if (STATE.engineers.find(e=>e.name.toLowerCase()===name.toLowerCase())) {
    toast('Engineer already exists','err'); return;
  }
  STATE.engineers.push({ name, designation: desig });
  save(); renderSettings();
  document.getElementById('newEngName').value='';
  document.getElementById('newEngDesig').value='';
  toast(`${name} added ✓`,'ok');
  if (syncConfigured()) {
    pushEngineer({ name, designation: desig, deleted: false })
      .catch(err => toast('Saved locally, but failed to sync: ' + err.message, 'err'));
  }
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function handleExcelUpload(file, statusId) {
  const statusEl = document.getElementById(statusId);
  statusEl.textContent = 'Reading file…';
  statusEl.className='load-status';
  parseExcel(file, async (err, result)=>{
    if (err) {
      statusEl.textContent = `Error: ${err.message}`;
      statusEl.className = 'load-status err';
      toast('Failed to parse Excel','err');
      return;
    }
    STATE.materials = result;
    recomputeUsed(); // usage is always derived from STATE.transactions
    save();
    const cats = Object.keys(result).length;
    const total = Object.values(result).reduce((s,a)=>s+a.length,0);
    statusEl.textContent = `✓ Loaded ${total} materials across ${cats} categories`;
    statusEl.className = 'load-status ok';
    renderAll();
    toast(`Loaded ${total} materials ✓`, 'ok');

    if (syncConfigured()) {
      try {
        statusEl.textContent = 'Uploading to Cloudflare…';
        const fileBase64 = await fileToBase64(file);
        const res = await pushMaterials(result, file.name, fileBase64);
        lastMaterialsVersion = res.version;
        statusEl.textContent = `✓ Loaded ${total} materials · saved to Cloudflare — visible on every device`;
        statusEl.className = 'load-status ok';
        toast('Materials synced to all devices ✓', 'ok');
      } catch (upErr) {
        statusEl.textContent = `Loaded locally, but Cloudflare upload failed: ${upErr.message}`;
        statusEl.className = 'load-status err';
        toast('Materials loaded here, but not synced', 'err');
      }
    }
  });
}

/* ── ADMIN SETTINGS ──────────────────────────────────────────────────────
   Note: this is a static, client-side site, so this password screens off
   the panel from casual/accidental use by regular engineers — it is not
   real security (anyone who reads the page source can find it, the same
   way any password baked into a public static site could be found). Don't
   rely on it to protect anything you wouldn't be OK with a technical user
   eventually seeing.                                                     */
const ADMIN_PASSWORD = 'MEP@LOFT45';
let adminUnlocked = false;

function initAdminPanel() {
  const lockView   = document.getElementById('adminLocked');
  const panelView  = document.getElementById('adminPanel');
  const pwInput    = document.getElementById('adminPwInput');
  const unlockBtn  = document.getElementById('adminUnlockBtn');
  const pwMsg      = document.getElementById('adminPwMsg');
  if (!lockView) return; // settings page not yet rendered

  function refreshLockUI() {
    lockView.style.display  = adminUnlocked ? 'none' : '';
    panelView.style.display = adminUnlocked ? '' : 'none';
  }
  refreshLockUI();

  function tryUnlock() {
    if (pwInput.value === ADMIN_PASSWORD) {
      adminUnlocked = true;
      pwMsg.textContent = '';
      pwInput.value = '';
      refreshLockUI();
    } else {
      pwMsg.textContent = 'Incorrect password';
      pwMsg.className = 'form-msg err';
    }
  }
  unlockBtn.onclick = tryUnlock;
  pwInput.onkeydown = e => { if (e.key === 'Enter') tryUnlock(); };

  document.getElementById('adminLockBtn').onclick = () => { adminUnlocked = false; refreshLockUI(); };

  // Clear ALL data — materials, transactions, engineers, settings.
  // This is the ONLY action in the whole app allowed to wipe the database.
  // The Worker archives a full snapshot to a brand-new timestamped file in
  // Cloudflare R2 (archive/data-cleared-<timestamp>.json) before deleting
  // anything, so nothing is ever permanently lost.
  document.getElementById('adminClearAllBtn').onclick = async () => {
    if (!confirm('This permanently deletes ALL materials, transactions, and engineers — on every device. The current data will be archived to a separate backup file first. Continue?')) return;
    if (!confirm('Are you absolutely sure? This cannot be undone.')) return;

    if (!syncConfigured()) {
      toast('Cloudflare sync not configured — nothing to clear on the server', 'err');
      return;
    }
    try {
      toast('Archiving and clearing…', 'ok');
      const res = await fetch(`${SYNC_PROXY_URL}/admin/clear-all`, { method: 'POST', headers: syncHeaders() });
      if (!res.ok) throw new Error(`Clear failed (${res.status})`);
      const { archivedPath } = await res.json();

      STATE.materials = {};
      STATE.transactions = [];
      STATE.engineers = [];
      STATE.settings = { reorderPct: 20, updatedAt: Date.now() };
      lastMaterialsVersion = -1;
      save();
      renderAll();
      toast(`All data cleared — backup saved to ${archivedPath} ✓`, 'ok');
    } catch (err) {
      toast('Clear failed: ' + err.message, 'err');
    }
  };

  // Clear only usage/transactions — keeps materials + engineers
  document.getElementById('adminClearTxnBtn').onclick = async () => {
    if (!confirm('Clear all recorded usage/transactions? Materials and engineers stay. This cannot be undone.')) return;

    if (!syncConfigured()) {
      toast('Cloudflare sync not configured — nothing to clear on the server', 'err');
      return;
    }
    try {
      toast('Archiving and clearing…', 'ok');
      const res = await fetch(`${SYNC_PROXY_URL}/admin/clear-transactions`, { method: 'POST', headers: syncHeaders() });
      if (!res.ok) throw new Error(`Clear failed (${res.status})`);
      const { archivedPath } = await res.json();

      STATE.transactions = [];
      recomputeUsed();
      save();
      renderAll();
      toast(`Transactions cleared — backup saved to ${archivedPath} ✓`, 'ok');
    } catch (err) {
      toast('Clear failed: ' + err.message, 'err');
    }
  };

  // Export full backup as a JSON file
  document.getElementById('adminExportBtn').onclick = () => {
    const backup = {
      materials: STATE.materials,
      transactions: STATE.transactions,
      engineers: STATE.engineers,
      settings: STATE.settings,
      exportedAt: new Date().toISOString(),
    };
    const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `mep-inventory-backup-${new Date().toISOString().slice(0,10)}.json`;
    a.click();
    toast('Backup downloaded', 'ok');
  };

  // Import/restore a previously exported backup — pushes every row back up
  // to the Cloudflare database/R2 so the restore applies to every device.
  document.getElementById('adminImportInput').onchange = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (!confirm('Restoring a backup replaces all current data everywhere. Continue?')) { e.target.value=''; return; }
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const backup = JSON.parse(reader.result);
        STATE.materials = backup.materials || {};
        STATE.transactions = backup.transactions || [];
        STATE.engineers = backup.engineers || [];
        STATE.settings = backup.settings || { reorderPct: 20 };
        recomputeUsed();
        save();
        renderAll();
        toast('Backup restored locally ✓ — pushing to server…', 'ok');

        if (syncConfigured()) {
          for (const eng of STATE.engineers) {
            await pushEngineer({ name: eng.name, designation: eng.designation, deleted: false });
          }
          for (const t of STATE.transactions) {
            await pushTransaction(t);
          }
          await pushSettings(STATE.settings);
          if (Object.keys(STATE.materials).length) {
            await pushMaterials(STATE.materials, 'restored-backup.json', null);
          }
          toast('Backup pushed to server — visible on every device ✓', 'ok');
        }
      } catch (err) {
        toast('Invalid backup file', 'err');
      }
      e.target.value = '';
    };
    reader.readAsText(file);
  };

  // Force a fresh pull from the server (read-only — does not write data.json)
  document.getElementById('adminResyncBtn').onclick = () => ghPullOnly(true);
  document.getElementById('adminImportBtn').onclick = () => document.getElementById('adminImportInput').click();

  // Live sync status text inside admin panel
  const cfgOk = syncConfigured();
  const statusLine = document.getElementById('adminSyncStatus');
  if (statusLine) {
    statusLine.textContent = cfgOk
      ? 'Cross-device sync is configured and automatic.'
      : 'Sync proxy not configured yet — see sync-worker/worker.js. Data is local to this device only.';
  }
}
document.addEventListener('DOMContentLoaded', ()=>{
  load();

  // Date
  document.getElementById('topDate').textContent =
    new Date().toLocaleDateString('en-GB',{weekday:'short',day:'2-digit',month:'short',year:'numeric'});

  // Nav
  document.querySelectorAll('.nav-item').forEach(item=>{
    item.addEventListener('click',e=>{e.preventDefault(); showPage(item.dataset.page);});
  });

  // Burger
  document.getElementById('burger').addEventListener('click',()=>{
    document.getElementById('sidebar').classList.toggle('open');
  });

  // Sidebar drop zone
  const sideZone = document.getElementById('dropZone');
  sideZone.addEventListener('click', ()=> document.getElementById('fileInput').click());
  document.getElementById('fileInput').addEventListener('change', e=>{
    if (e.target.files[0]) handleExcelUpload(e.target.files[0],'loadStatus');
  });

  // Settings drop zone
  const setZone = document.getElementById('settingsDropZone');
  setZone.addEventListener('click',()=>document.getElementById('settingsFileInput').click());
  document.getElementById('settingsFileInput').addEventListener('change', e=>{
    if (e.target.files[0]) handleExcelUpload(e.target.files[0],'loadStatus');
  });

  // Drag-and-drop for both zones
  [sideZone, setZone].forEach(zone=>{
    zone.addEventListener('dragover', e=>{ e.preventDefault(); zone.style.borderColor='var(--accent)'; });
    zone.addEventListener('dragleave', ()=>{ zone.style.borderColor=''; });
    zone.addEventListener('drop', e=>{
      e.preventDefault(); zone.style.borderColor='';
      const f = e.dataTransfer.files[0];
      if (f) handleExcelUpload(f, 'loadStatus');
    });
  });

  // Overview search
  document.getElementById('overviewSearch').addEventListener('input', filterOverview);

  // Usage form
  document.getElementById('usageCategory').addEventListener('change', updateMaterialDropdown);
  document.getElementById('usageMaterial').addEventListener('change', updateSpecDropdown);
  document.getElementById('usageSpec').addEventListener('change', updateUOMAvailFromSpec);
  document.getElementById('submitUsage').addEventListener('click', submitUsage);
  document.getElementById('clearUsage').addEventListener('click', ()=>{
    ['usageEngineer','usageCategory','usageMaterial'].forEach(id=>document.getElementById(id).value='');
    resetSpecDropdown('— Select Material first —');
    ['usageQty','usageRemarks'].forEach(id=>document.getElementById(id).value='');
    document.getElementById('formMsg').textContent='';
  });

  // Engineer reports
  document.getElementById('applyFilter').addEventListener('click', applyEngFilter);
  document.getElementById('repEngineer').addEventListener('change', applyEngFilter);

  // History
  document.getElementById('histSearch').addEventListener('input', filterHistory);
  document.getElementById('exportCSV').addEventListener('click', exportCSV);

  // Settings
  document.getElementById('addEngineerBtn').addEventListener('click', addEngineer);
  document.getElementById('newEngName').addEventListener('keydown', e=>{ if(e.key==='Enter') addEngineer(); });

  document.getElementById('saveSettings').addEventListener('click', ()=>{
    STATE.settings.reorderPct = parseInt(document.getElementById('reorderPct').value) || 20;
    STATE.settings.updatedAt = Date.now();
    save(); renderAll(); toast('Settings saved ✓','ok');
    if (syncConfigured()) {
      pushSettings(STATE.settings).catch(err => toast('Saved locally, but failed to sync: ' + err.message, 'err'));
    }
  });

  // Sync status (fully automatic — nothing for the user to configure)
  document.getElementById('ghSyncNowBtn')?.addEventListener('click', ()=> ghPullOnly(true));

  initAdminPanel();

  // Initial render
  showPage('dashboard');

  // Auto-load Excel from repo, then connect to GitHub data sync (if configured)
  tryAutoLoad().finally(()=> initGitHubSync());
});
