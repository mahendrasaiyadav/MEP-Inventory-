/**
 * MEP Inventory — Sync Proxy Worker
 * ----------------------------------------------------------------
 * Deploy this to Cloudflare Workers (free). It holds your GitHub
 * token as a SECRET on Cloudflare's servers — it never ships to
 * any browser, so every device can sync automatically with zero
 * setup and the token can never be stolen from the website.
 *
 * SETUP (one-time, ~5 minutes):
 * 1. Go to https://dash.cloudflare.com → sign up free (no card needed)
 * 2. Workers & Pages → Create → Create Worker → name it e.g. "mep-sync"
 * 3. Paste this whole file into the editor, replacing the default code → Deploy
 * 4. Worker → Settings → Variables and Secrets → add:
 *      GITHUB_TOKEN   = <a NEW token you generate — revoke the old one!>
 *      GH_REPO        = mahendrasaiyadav/MEP-Inventory-
 *      GH_BRANCH      = main
 *      GH_PATH        = data.json
 *      SYNC_KEY       = <make up any random string, e.g. loft45-sync-8823>
 *    Mark GITHUB_TOKEN and SYNC_KEY as "Encrypt" / secret.
 * 5. Copy your worker's URL (looks like https://mep-sync.<you>.workers.dev)
 * 6. Paste that URL into app.js → SYNC_PROXY_URL, and the same SYNC_KEY
 *    into app.js → SYNC_KEY. Push app.js to GitHub Pages. Done —
 *    every device that loads the site from then on auto-syncs.
 *
 * Generate the new GitHub token at:
 *   https://github.com/settings/tokens → Generate new token (classic)
 *   Scope needed: repo (or, for fine-grained tokens: Contents Read & write
 *   on this one repo only — safer, recommended).
 *
 * ENDPOINTS
 *   GET  /data     → read data.json                    → { data, sha }
 *   PUT  /data     → write data.json (needs sha)        → { sha }
 *   POST /archive  → server-side copy of the CURRENT     → { archivedPath, sha }
 *                    data.json into archive/<name>.json,
 *                    used by Admin "Clear All Data" to
 *                    keep a permanent snapshot before wiping.
 *                    body: { path?: "archive/xxx.json" }
 * ----------------------------------------------------------------
 */

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,PUT,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,X-Sync-Key',
  };
}

function ghHeaders(env) {
  return {
    'Authorization': `token ${env.GITHUB_TOKEN}`,
    'Accept': 'application/vnd.github+json',
    'User-Agent': 'mep-inventory-sync-worker',
  };
}

function contentsUrl(env, path) {
  return `https://api.github.com/repos/${env.GH_REPO}/contents/${encodeURIComponent(path)}`;
}

async function ghReadFile(env, path) {
  const res = await fetch(`${contentsUrl(env, path)}?ref=${encodeURIComponent(env.GH_BRANCH || 'main')}&t=${Date.now()}`, {
    headers: ghHeaders(env),
  });
  if (res.status === 404) return { data: null, sha: null };
  if (!res.ok) throw new Error(`GitHub read failed (${res.status})`);
  const json = await res.json();
  const content = decodeURIComponent(escape(atob((json.content || '').replace(/\n/g, ''))));
  let data = null;
  try { data = JSON.parse(content); } catch (e) { data = null; }
  return { data, sha: json.sha };
}

async function ghWriteFile(env, path, dataObj, sha, message) {
  const putBody = {
    message: message || `Update ${path} — ${new Date().toISOString()}`,
    content: btoa(unescape(encodeURIComponent(JSON.stringify(dataObj, null, 2)))),
    branch: env.GH_BRANCH || 'main',
  };
  if (sha) putBody.sha = sha;
  const res = await fetch(contentsUrl(env, path), {
    method: 'PUT',
    headers: { ...ghHeaders(env), 'Content-Type': 'application/json' },
    body: JSON.stringify(putBody),
  });
  if (!res.ok) {
    const err = new Error(`GitHub write failed (${res.status}): ${await res.text()}`);
    err.status = res.status;
    throw err;
  }
  const json = await res.json();
  return json.content.sha;
}

async function handleData(request, env, cors) {
  const key = request.headers.get('X-Sync-Key');
  if (!env.SYNC_KEY || key !== env.SYNC_KEY) {
    return new Response('Unauthorized', { status: 401, headers: cors });
  }

  try {
    if (request.method === 'GET') {
      const { data, sha } = await ghReadFile(env, env.GH_PATH);
      return new Response(JSON.stringify({ data, sha }), { headers: { ...cors, 'Content-Type': 'application/json' } });
    }

    if (request.method === 'PUT') {
      const body = await request.json(); // { data, sha }
      const sha = await ghWriteFile(env, env.GH_PATH, body.data, body.sha, `Update inventory data — ${new Date().toISOString()}`);
      return new Response(JSON.stringify({ sha }), { headers: { ...cors, 'Content-Type': 'application/json' } });
    }

    return new Response('Method not allowed', { status: 405, headers: cors });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: err.status || 500, headers: { ...cors, 'Content-Type': 'application/json' } });
  }
}

// Server-side: read the CURRENT data.json and write a copy of it to a new
// archive file — never touches data.json itself. The caller (Admin "Clear
// All Data") follows this up with a separate PUT /data to actually wipe it,
// so every clear leaves a permanent, timestamped snapshot behind in the repo.
async function handleArchive(request, env, cors) {
  const key = request.headers.get('X-Sync-Key');
  if (!env.SYNC_KEY || key !== env.SYNC_KEY) {
    return new Response('Unauthorized', { status: 401, headers: cors });
  }

  try {
    const body = await request.json().catch(() => ({}));
    let path = body.path || `archive/data-cleared-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    // Keep archives confined to an "archive/" folder in the repo, and never
    // let this endpoint be pointed at data.json or outside the repo.
    if (!path.startsWith('archive/')) path = `archive/${path}`;
    path = path.replace(/\.\./g, '');

    const current = await ghReadFile(env, env.GH_PATH);
    if (!current.data) {
      return new Response(JSON.stringify({ archivedPath: null, sha: current.sha, note: 'Nothing to archive — data.json was empty.' }), { headers: { ...cors, 'Content-Type': 'application/json' } });
    }

    await ghWriteFile(env, path, current.data, null, `Archive inventory data before clear — ${new Date().toISOString()}`);
    return new Response(JSON.stringify({ archivedPath: path, sha: current.sha }), { headers: { ...cors, 'Content-Type': 'application/json' } });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: err.status || 500, headers: { ...cors, 'Content-Type': 'application/json' } });
  }
}

export default {
  async fetch(request, env) {
    const cors = corsHeaders();
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });

    const url = new URL(request.url);
    if (url.pathname === '/archive' && request.method === 'POST') {
      return handleArchive(request, env, cors);
    }
    if (url.pathname === '/data') {
      return handleData(request, env, cors);
    }
    return new Response('Not found', { status: 404, headers: cors });
  },
};
