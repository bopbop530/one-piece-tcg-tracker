/* OPTCG Quant — TCGCSV proxy
   ============================================================================

   Why this exists
   ---------------
   TCGCSV serves TCGplayer's catalogue, including sealed box and case prices,
   but it returns 401 the instant a request carries an Origin header. Their
   docs are explicit that it is meant for back-end use, not browsers. This
   Worker is that back end: it fetches on the app's behalf and adds the CORS
   headers a browser demands.

   Why it is DUMB on purpose
   -------------------------
   The obvious design — one Worker call that assembles the whole catalogue —
   cannot run on the free plan. Free Workers allow 50 subrequests and 10 ms of
   CPU per request; a full sync is 84 fetches and joining 7,200 products blows
   past 10 ms on the JSON work alone.

   So this Worker never parses anything. It proxies ONE upstream file per
   request and streams the body through untouched: 1 subrequest, no JSON, CPU
   near zero. The client does the assembly, where CPU is free. The app makes
   one call per set instead of one call for everything, which is more requests
   but each is trivial, and the free plan allows 100,000 a day.

   Caching
   -------
   TCGCSV rebuilds once a day, around 20:00 UTC, and asks that you not poll
   more often than that. Responses are cached at the edge until just after the
   next build, so opening the app fifty times in a day still costs upstream one
   fetch per file. The app always gets the freshest data that exists; the
   caching is invisible to it.

   Deploy
   ------
   See DEPLOY.md. There are no secrets in here — it proxies public data and
   holds no key, which is why it is safe in a public repo.
*/

const CATEGORY = 68;                       // One Piece Card Game on TCGplayer
const UPSTREAM = 'https://tcgcsv.com';
const UA = 'OPTCGQuant/2.0.0 (personal collection tracker)';

/* Which origins may call this Worker.

   '*' is the default because everything here is public, read-only card data —
   there is no key to steal and no write path to abuse. The only real risk is
   somebody else spending your 100k/day request allowance, which needs them to
   find the URL first. To lock it down, replace '*' with your Pages origin,
   e.g. ['https://yourname.github.io']. Leave localhost in for local work. */
const ALLOWED_ORIGINS = ['*'];

function corsHeaders(origin) {
  const ok = ALLOWED_ORIGINS.includes('*') ? '*'
           : ALLOWED_ORIGINS.includes(origin) ? origin
           : null;
  if (!ok) return null;
  return {
    'Access-Control-Allow-Origin': ok,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin'
  };
}

/* Seconds until shortly after TCGCSV's next daily build.

   Their timestamp lands around 20:00 UTC. Expiring at 20:30 gives the build
   half an hour of slack; if it runs late the cache simply serves yesterday's
   copy a little longer, which is correct behaviour, not a bug. Floored at five
   minutes so a request arriving exactly on the boundary cannot produce a
   zero-length cache entry and hammer upstream. */
function secondsUntilNextBuild() {
  const now = new Date();
  const next = new Date(now);
  next.setUTCHours(20, 30, 0, 0);
  if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
  return Math.max(300, Math.floor((next - now) / 1000));
}

/* Map an incoming path to an upstream URL.

   An allowlist, not a rewrite: without this the Worker would be an open proxy
   that anyone could point at any host, on your quota and your IP's reputation.
   Only these three shapes are reachable, and the group id must be digits. */
function upstreamFor(pathname) {
  // Tolerate a trailing slash. Browsers add one, people type one, and an exact
  // match turned "/updated/" into the same 404 as a genuinely bad path — which
  // reads as "the Worker is broken" rather than "you added a slash".
  const p = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;

  if (p === '/updated') return UPSTREAM + '/last-updated.txt';
  if (p === '/groups')  return `${UPSTREAM}/tcgplayer/${CATEGORY}/groups`;

  const m = p.match(/^\/g\/(\d{1,10})$/);
  if (m) return `${UPSTREAM}/tcgplayer/${CATEGORY}/${m[1]}/ProductsAndPrices.csv`;

  return null;
}

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get('Origin') || '';
    const cors = corsHeaders(origin);
    if (!cors) return new Response('Origin not allowed', { status: 403 });

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (request.method !== 'GET') {
      return new Response('Method not allowed', { status: 405, headers: cors });
    }

    const url = new URL(request.url);
    const target = upstreamFor(url.pathname);
    if (!target) {
      // Hitting the root is the first thing anyone does after deploying, so it
      // should confirm the Worker is alive rather than look like a failure.
      const root = url.pathname === '/' || url.pathname === '';
      return new Response(
        root
          ? [
              'OPTCG Quant data proxy is running.',
              '',
              'This URL is correct — paste it into the app under Settings -> Data source.',
              'To check it by hand, add /updated to this address.',
              '',
              'Paths: /updated, /groups, /g/{groupId}'
            ].join('\n')
          : 'Not found. Valid paths: /updated, /groups, /g/{groupId}',
        { status: root ? 200 : 404, headers: cors });
    }

    // Cache key deliberately ignores the query string and the Origin header, so
    // every caller shares one entry. Without this, an app that appends a
    // cache-buster would miss every time and re-fetch upstream on each open —
    // exactly the polling their guidelines ask us not to do.
    const cacheKey = new Request(url.origin + url.pathname, { method: 'GET' });
    const cache = caches.default;

    let response = await cache.match(cacheKey);
    let hit = true;

    if (!response) {
      hit = false;
      let upstream;
      try {
        upstream = await fetch(target, {
          headers: { 'User-Agent': UA, 'Accept': '*/*' },
          cf: { cacheTtl: 0 }
        });
      } catch (err) {
        return new Response('Upstream fetch failed: ' + err, { status: 502, headers: cors });
      }

      if (!upstream.ok) {
        // Not cached: a 401 or a throttle is transient, and caching it would
        // keep the app broken for a full day after the cause was fixed.
        return new Response(
          `Upstream returned ${upstream.status}`,
          { status: upstream.status === 404 ? 404 : 502, headers: cors });
      }

      const ttl = secondsUntilNextBuild();
      response = new Response(upstream.body, {
        status: 200,
        headers: {
          'Content-Type': upstream.headers.get('Content-Type') || 'text/plain; charset=utf-8',
          'Cache-Control': `public, max-age=${ttl}`
        }
      });

      // Store a clone and let it finish after the response is sent, so the
      // caller never waits on the cache write.
      ctx.waitUntil(cache.put(cacheKey, response.clone()));
    }

    const out = new Response(response.body, response);
    for (const [k, v] of Object.entries(cors)) out.headers.set(k, v);
    out.headers.set('X-Proxy-Cache', hit ? 'HIT' : 'MISS');
    return out;
  }
};
