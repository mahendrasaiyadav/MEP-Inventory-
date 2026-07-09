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
 * ----------------------------------------------------------------
 */

export default {
  async fetch(request, env) {
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,PUT,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type,X-Sync-Key',
    };
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });

    const url = new URL(request.url);
    if (url.pathname !== '/data') {
      return new Response('Not found', { status: 404, headers: cors });
    }

    // Lightweight shared-key check. This is NOT the GitHub token — it's a
    // low-value app key baked into app.js, just to stop random internet
    // traffic from hitting this endpoint. The real secret (GITHUB_TOKEN)
    // stays server-side no matter what.
    const key = request.headers.get('X-Sync-Key');
    if (!env.SYNC_KEY || key !== env.SYNC_KEY) {
      return new Response('Unauthorized', { status: 401, headers: cors });
    }

    const apiUrl = `https://api.github.com/repos/${env.GH_REPO}/contents/${encodeURIComponent(env.GH_PATH)}`;
    const ghHeaders = {
      'Authorization': `token ${env.GITHUB_TOKEN}`,
      'Accept': 'application/vnd.github+json',
      'User-Agent': 'mep-inventory-sync-worker',
    };

    try {
      if (request.method === 'GET') {
        const res = await fetch(`${apiUrl}?ref=${encodeURIComponent(env.GH_BRANCH || 'main')}&t=${Date.now()}`, { headers: ghHeaders });
        if (res.status === 404) {
          return new Response(JSON.stringify({ data: null, sha: null }), { headers: { ...cors, 'Content-Type': 'application/json' } });
        }
        if (!res.ok) throw new Error(`GitHub read failed (${res.status})`);
        const json = await res.json();
        const content = decodeURIComponent(escape(atob((json.content || '').replace(/\n/g, ''))));
        let data = null;
        try { data = JSON.parse(content); } catch (e) { data = null; }
        return new Response(JSON.stringify({ data, sha: json.sha }), { headers: { ...cors, 'Content-Type': 'application/json' } });
      }

      if (request.method === 'PUT') {
        const body = await request.json(); // { data, sha }
        const putBody = {
          message: `Update inventory data — ${new Date().toISOString()}`,
          content: btoa(unescape(encodeURIComponent(JSON.stringify(body.data, null, 2)))),
          branch: env.GH_BRANCH || 'main',
        };
        if (body.sha) putBody.sha = body.sha;
        const res = await fetch(apiUrl, {
          method: 'PUT',
          headers: { ...ghHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify(putBody),
        });
        if (!res.ok) {
          const errText = await res.text();
          return new Response(errText, { status: res.status, headers: cors });
        }
        const json = await res.json();
        return new Response(JSON.stringify({ sha: json.content.sha }), { headers: { ...cors, 'Content-Type': 'application/json' } });
      }

      return new Response('Method not allowed', { status: 405, headers: cors });
    } catch (err) {
      return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: { ...cors, 'Content-Type': 'application/json' } });
    }
  },
};
