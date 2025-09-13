// worker.js — Audio backend (R2 + proxy) with playlist endpoint

function corsHeaders(req) {
  const origin = req.headers.get('Origin') || '*';
  return {
    'Access-Control-Allow-Origin': origin,
    'Vary': 'Origin',
    'Access-Control-Allow-Methods': 'GET, HEAD, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Range, Cache-Control',
    'Access-Control-Expose-Headers':
      'Content-Length, Content-Range, Accept-Ranges, Content-Type, ETag, Last-Modified',
  };
}
const json = (req, data, status=200) =>
  new Response(JSON.stringify(data), { status, headers: { ...corsHeaders(req), 'Content-Type': 'application/json' } });

function adminOk(req, env) {
  const header = req.headers.get('Authorization') || '';
  const bearer = header.replace(/^Bearer\s+/i, '').trim();
  const url = new URL(req.url);
  const q = url.searchParams.get('token') || '';
  const token = env.PLAYLIST_WRITE_TOKEN || '';
  return token && (bearer === token || q === token);
}

function parseRange(h) {
  if (!h) return undefined;
  const m = /^bytes=(\d+)-(\d+)?$/.exec(h);
  if (!m) return undefined;
  const start = Number(m[1]);
  const end = m[2] ? Number(m[2]) : undefined;
  return end ? { offset: start, length: end - start + 1 } : { offset: start };
}

function natSort(a, b) {
  // Natural sort with numeric compare
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}
function byLeadingNumberThenName(a, b) {
  const re = /(\d+)/;
  const ma = a.match(re), mb = b.match(re);
  if (ma && mb) {
    const da = Number(ma[1]); const db = Number(mb[1]);
    if (da !== db) return da - db;
  }
  return natSort(a, b);
}
function buildPairs(origin, remix, originBase, remixBase, { generic=true } = {}) {
  const len = Math.min(origin.length, remix.length);
  const pairs = [];
  for (let i = 0; i < len; i++) {
    const idx = i + 1;
    const originalLabel = generic ? `Original ${String(idx).padStart(2,'0')}` : origin[i].split('/').pop();
    const remixLabel    = generic ? `Remix ${String(idx).padStart(2,'0')}`    : remix[i].split('/').pop();
    pairs.push({
      index: i,
      title: `Track ${String(idx).padStart(2,'0')}`,
      originalUrl: `${originBase}/${encodeURIComponent(origin[i])}`,
      remixUrl:    `${remixBase}/${encodeURIComponent(remix[i])}`,
      // Labels intended for the UI. We deliberately avoid exposing real file names when generic=true.
      originalLabel,
      remixLabel,
    });
  }
  return pairs;
}

async function listPrefix(AUDIO, prefix) {
  const out = [];
  let cursor;
  do {
    const { objects, truncated, cursor: cur } = await AUDIO.list({ prefix, cursor });
    for (const o of objects) out.push(o.key);
    cursor = truncated ? cur : undefined;
  } while (cursor);
  return out;
}

async function buildManifest(url, AUDIO, oPrefix='originals/', rPrefix='remixes/') {
  const originals = (await listPrefix(AUDIO, oPrefix)).filter(k => !k.endsWith('/'));
  const remixes   = (await listPrefix(AUDIO, rPrefix)).filter(k => !k.endsWith('/'));
  originals.sort(byLeadingNumberThenName);
  remixes.sort(byLeadingNumberThenName);

  const toArr = (keys, label) => keys.map((k, i) => ({
    name: `${label} ${String(i+1).padStart(2,'0')}`,
    url: `${url.origin}/r2/${encodeURIComponent(k)}`
  }));

  const pairs = [];
  const len = Math.min(originals.length, remixes.length);
  for (let i = 0; i < len; i++) {
    pairs.push({
      index: i,
      title: `Track ${String(i+1).padStart(2,'0')}`,
      originalUrl: `${url.origin}/r2/${encodeURIComponent(originals[i])}`,
      remixUrl: `${url.origin}/r2/${encodeURIComponent(remixes[i])}`
    });
  }

  return {
    originals: toArr(originals, 'Original'),
    remixes: toArr(remixes, 'Remix'),
    pairs
  };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname, searchParams } = url;

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders(request) });
    }

    // Health
    if (pathname === '/health') {
      return json(request, { ok: true, r2: !!env.AUDIO });
    }

    // 1) Playlist endpoint
    //    Priority A: read /playlist.json from R2 (you control exact order).
    //    Priority B: if not found, auto-build pairs from originals/ & remixes/ by numeric prefix or filename order.
    if (pathname === '/playlist') {
      if (!env.AUDIO) return json(request, { error: 'R2 not configured' }, 500);

      // Optional query params:
      const oPrefix = searchParams.get('originals') || 'originals/';
      const rPrefix = searchParams.get('remixes')   || 'remixes/';
      const shuffle = ['1','true','yes'].includes((searchParams.get('shuffle')||'').toLowerCase());

      // Try playlist.json first (supports two shapes):
      //  A) { pairs: [{ originalUrl, remixUrl, title? }...] }
      //  B) { originals: [{name,url}...], remixes: [{name,url}...], pairs?: [...] }
      const manifestObj = await env.AUDIO.get('playlist.json');
      if (manifestObj) {
        try {
          const txt = await manifestObj.text();
          const parsed = JSON.parse(txt);
          // Pass-through if pairs provided
          if (Array.isArray(parsed.pairs) && parsed.pairs.length) {
            return json(request, parsed);
          }
          if (Array.isArray(parsed.originals) || Array.isArray(parsed.remixes)) {
            // Ensure arrays exist even if one side missing
            return json(request, {
              originals: parsed.originals || [],
              remixes: parsed.remixes || [],
              pairs: Array.isArray(parsed.pairs) ? parsed.pairs : [],
            });
          }
          // If malformed, fall through to auto mode
        } catch {
          // ignore and fall through
        }
      }

      // Auto mode
      const originals = (await listPrefix(env.AUDIO, oPrefix)).filter(k => !k.endsWith('/'));
      const remixes   = (await listPrefix(env.AUDIO, rPrefix)).filter(k => !k.endsWith('/'));

      originals.sort(byLeadingNumberThenName);
      remixes.sort(byLeadingNumberThenName);

      const originBase = `${url.origin}/r2`;
      const remixBase  = `${url.origin}/r2`;

      const pairs = buildPairs(originals, remixes, originBase, remixBase, { generic: true });

      // Build bank arrays for the UI. Use generic labels so real track names are not exposed on the frontend.
      const toArr = (keys, label) => keys.map((k, i) => ({
        name: `${label} ${String(i+1).padStart(2,'0')}`,
        url: `${url.origin}/r2/${encodeURIComponent(k)}`,
      }));
      const payload = {
        originals: toArr(originals, 'Original'),
        remixes: toArr(remixes, 'Remix'),
        pairs,
      };

      if (shuffle && pairs.length > 1) {
        // Simple deterministic shuffle by day to keep caching stable
        const d = new Date();
        const seed = Number(`${d.getFullYear()}${d.getMonth()+1}${d.getDate()}`);
        payload.pairs = [...pairs].sort((a,b) => ((a.index * 9301 + seed) % 233280) - ((b.index * 9301 + seed) % 233280));
      }

      return json(request, payload);
    }

    // 2) Serve audio from R2: GET /r2/<key>
    if (pathname.startsWith('/r2/')) {
      if (!env.AUDIO) return json(request, { error: 'R2 not configured' }, 500);

      const key = decodeURIComponent(pathname.replace('/r2/', ''));
      const isHead = request.method === 'HEAD';
      const range = parseRange(request.headers.get('Range'));
      const obj = range
        ? await env.AUDIO.get(key, { range })
        : await env.AUDIO.get(key);

      if (!obj) return new Response('Not found', { status: 404, headers: corsHeaders(request) });

      const headers = {
        ...corsHeaders(request),
        'Content-Type': obj.httpMetadata?.contentType || 'audio/mpeg',
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'public, max-age=3600',
        'Content-Length': String(obj.size),
        'ETag': obj.httpEtag || obj.etag || '',
      };
      if (obj.uploaded) headers['Last-Modified'] = new Date(obj.uploaded).toUTCString();
      headers['Content-Disposition'] = `inline; filename="${key.split('/').pop()}"`;

      if (obj.range) {
        const start = obj.range.offset;
        const end = start + obj.range.length - 1;
        headers['Content-Range'] = `bytes ${start}-${end}/${obj.size}`;
        return new Response(isHead ? null : obj.body, { status: 206, headers });
      }
      return new Response(isHead ? null : obj.body, { status: 200, headers });
    }

    // 3) Optional proxy for remote audio: /audio?src=<https://...mp3>
    if (pathname === '/audio') {
      const src = searchParams.get('src');
      if (!src) return json(request, { error: 'Missing src' }, 400);
      const range = request.headers.get('Range') || undefined;
      const upstream = await fetch(src, { headers: range ? { Range: range } : undefined });
      const headers = {
        ...corsHeaders(request),
        'Content-Type': upstream.headers.get('Content-Type') || 'audio/mpeg',
        'Accept-Ranges': upstream.headers.get('Accept-Ranges') || 'bytes',
        'Content-Range': upstream.headers.get('Content-Range') || '',
        'Content-Length': upstream.headers.get('Content-Length') || '',
        'Cache-Control': 'public, max-age=3600',
      };
      const body = (request.method === 'HEAD') ? null : upstream.body;
      return new Response(body, { status: upstream.status, statusText: upstream.statusText, headers });
    }

    // 4) Generate playlist.json from current R2 contents.
    //    Use Authorization: Bearer <PLAYLIST_WRITE_TOKEN> header or ?token=...
    if (pathname === '/playlist/generate') {
      if (!env.AUDIO) return json(request, { error: 'R2 not configured' }, 500);
      const oPrefix = searchParams.get('originals') || 'originals/';
      const rPrefix = searchParams.get('remixes')   || 'remixes/';
      const dryrun = (searchParams.get('dryrun') || '').toLowerCase() === '1';

      const manifest = await buildManifest(url, env.AUDIO, oPrefix, rPrefix);

      // If dryrun or no token, just preview without writing.
      if (!adminOk(request, env) || dryrun) {
        return json(request, { wrote: false, dryrun: dryrun, manifest });
      }

      await env.AUDIO.put('playlist.json', JSON.stringify(manifest, null, 2), {
        httpMetadata: { contentType: 'application/json', cacheControl: 'no-store' }
      });
      return json(request, { wrote: true, key: 'playlist.json', bytes: JSON.stringify(manifest).length, manifest });
    }

    return json(request, { ok: true, endpoints: ['/playlist?originals=&remixes=&shuffle=1', '/playlist/generate?dryrun=1', '/r2/<key>', '/audio?src=…', '/health'] });
  },
};
