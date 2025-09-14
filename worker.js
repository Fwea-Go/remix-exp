// worker.js — Audio backend (R2 + proxy) with playlist endpoint

function corsHeaders(req) {
  const acrh = req.headers.get('Access-Control-Request-Headers');
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, HEAD, POST, OPTIONS',
    'Access-Control-Allow-Headers': acrh || '*',
    'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges, Content-Type, ETag, Last-Modified',
    'Cross-Origin-Resource-Policy': 'cross-origin',
    'Timing-Allow-Origin': '*',
    'Vary': 'Origin, Access-Control-Request-Headers'
  };
}
const json = (req, data, status=200) =>
  new Response(JSON.stringify(data), { status, headers: { ...corsHeaders(req), 'Content-Type': 'application/json' } });

function jsonWithLen(req, data, status=200, noStore=false){
  const body = JSON.stringify(data);
  const base = { ...corsHeaders(req), 'Content-Type': 'application/json' };
  const headers = noStore ? { ...base, 'Cache-Control': 'no-store', 'Content-Length': String(new TextEncoder().encode(body).length) } : { ...base, 'Content-Length': String(new TextEncoder().encode(body).length) };
  return { body, headers, status };
}

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
function extractNum(name = '') {
  // leading number like "18. Something", "02 - Title", "003_Title"
  const m = String(name).match(/^\s*(\d{1,4})[.\-_ ]?/);
  return m ? parseInt(m[1], 10) : null;
}
function normalizeStem(s = '') {
  // strip extension
  s = s.replace(/\.[a-z0-9]{2,5}$/i, '');
  // remove common remix markers and brackets
  s = s.replace(/\bremix\b/ig, '')
       .replace(/\bfwea[-\s]?go\b/ig, '')
       .replace(/\bjit\b/ig, '')
       .replace(/\(.*?\)|\[.*?\]|\{.*?\}/g, '');
  // collapse punctuation/whitespace and diacritics
  s = s.toLowerCase()
       .normalize('NFD').replace(/\p{Diacritic}+/gu,'')
       .replace(/[^a-z0-9]+/g, ' ')
       .trim()
       .replace(/\s+/g, ' ');
  return s;
}
function bestStemKey(key) {
  const base = key.split('/').pop() || key;
  return normalizeStem(base);
}
async function buildAutoPairsFromR2(AUDIO, oPrefix = 'originals/', rPrefix = 'remixes/') {
  const originals = (await listPrefix(AUDIO, oPrefix)).filter(k => !k.endsWith('/')).sort(natSort);
  const remixes   = (await listPrefix(AUDIO, rPrefix)).filter(k => !k.endsWith('/')).sort(natSort);

  // Index by leading number
  const oByNum = new Map();
  const rByNum = new Map();
  for (const k of originals) {
    const n = extractNum(k.split('/').pop() || k);
    if (n != null && !oByNum.has(n)) oByNum.set(n, k);
  }
  for (const k of remixes) {
    const n = extractNum(k.split('/').pop() || k);
    if (n != null && !rByNum.has(n)) rByNum.set(n, k);
  }

  const usedO = new Set();
  const usedR = new Set();
  const pairs = [];

  // 1) Pair by matching leading number
  const nums = new Set([...oByNum.keys(), ...rByNum.keys()]);
  for (const n of [...nums].sort((a,b)=>a-b)) {
    const o = oByNum.get(n);
    const r = rByNum.get(n);
    if (o && r) { pairs.push([o, r]); usedO.add(o); usedR.add(r); }
  }

  // 2) Stem-based fuzzy matching for leftovers
  const oLeft = originals.filter(k => !usedO.has(k));
  const rLeft = remixes.filter(k => !usedR.has(k));
  const rLeftByStem = new Map();
  for (const r of rLeft) rLeftByStem.set(bestStemKey(r), r);
  for (const o of oLeft) {
    const s = bestStemKey(o);
    if (rLeftByStem.has(s)) {
      const r = rLeftByStem.get(s);
      pairs.push([o, r]);
      usedR.add(r);
      rLeftByStem.delete(s);
    }
  }

  // 3) Any remaining: pair in natural order
  const rRemain = remixes.filter(k => !usedR.has(k));
  const oRemain = originals.filter(k => !usedO.has(k));
  const len = Math.min(oRemain.length, rRemain.length);
  for (let i = 0; i < len; i++) pairs.push([oRemain[i], rRemain[i]]);

  return pairs;
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
      return new Response(null, { status: 204, headers: corsHeaders(request) });
    }

    // Health
    if (pathname === '/health') {
      const pack = jsonWithLen(request, { ok: true, r2: !!env.AUDIO });
      if (request.method === 'HEAD') return new Response(null, { status: pack.status, headers: pack.headers });
      return new Response(pack.body, { status: pack.status, headers: pack.headers });
    }

    // 1) Playlist endpoint
    //    Priority A: read /playlist.json from R2 (you control exact order).
    //    Priority B: if not found, auto-build pairs from originals/ & remixes/ by numeric prefix or filename order.
    if (pathname === '/playlist') {
      if (!env.AUDIO) return json(request, { error: 'R2 not configured' }, 500);

      const forceAuto = (searchParams.get('mode') || '').toLowerCase() === 'auto';
      const normalizePair = (p) => {
        const fix = (u) => {
          if (!u) return u;
          // accept already-signed/absolute, /r2/<key>, or raw keys like originals/.. / remixes/..
          try {
            const asUrl = new URL(u);
            return asUrl.toString();
          } catch (_) {
            // not a full URL
          }
          if (u.startsWith('/r2/')) return u; // already worker-proxied path
          if (u.startsWith('originals/') || u.startsWith('remixes/')) {
            return `/r2/${encodeURIComponent(u)}`;
          }
          // fallback: leave as-is
          return u;
        };
        return {
          title: p.title || '',
          originalLabel: p.originalLabel || 'Original',
          remixLabel: p.remixLabel || 'Remix',
          originalUrl: fix(p.originalUrl),
          remixUrl: fix(p.remixUrl),
        };
      };

      // Try playlist.json from R2 root first (source of truth)
      const manifestObj = forceAuto ? null : await env.AUDIO.get('playlist.json');
      if (manifestObj) {
        try {
          const txt = await manifestObj.text();
          const parsed = JSON.parse(txt);
          if (Array.isArray(parsed.pairs) && parsed.pairs.length) {
            // Normalize and return only the pairs (do not auto-list or sort)
            const pairs = parsed.pairs.map((p) => normalizePair(p));
            const doShuffle = ['1','true','yes'].includes((searchParams.get('shuffle')||'').toLowerCase());
            if (doShuffle) {
              for (let i = pairs.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [pairs[i], pairs[j]] = [pairs[j], pairs[i]];
              }
            }
            const pack = jsonWithLen(request, { pairs }, 200, true);
            if (request.method === 'HEAD') return new Response(null, { status: pack.status, headers: pack.headers });
            return new Response(pack.body, { status: pack.status, headers: pack.headers });
          }
          if (Array.isArray(parsed.originals) && Array.isArray(parsed.remixes)) {
            // If a bank-style manifest was saved, pair by index deterministically
            const len = Math.min(parsed.originals.length, parsed.remixes.length);
            const pairs = [];
            for (let i = 0; i < len; i++) {
              const o = parsed.originals[i];
              const r = parsed.remixes[i];
              pairs.push(normalizePair({
                title: `Track ${String(i+1).padStart(2,'0')}`,
                originalLabel: `Original ${String(i+1).padStart(2,'0')}`,
                remixLabel: `Remix ${String(i+1).padStart(2,'0')}`,
                originalUrl: o?.url || o,
                remixUrl: r?.url || r,
              }));
            }
            const doShuffle = ['1','true','yes'].includes((searchParams.get('shuffle')||'').toLowerCase());
            if (doShuffle) {
              for (let i = pairs.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [pairs[i], pairs[j]] = [pairs[j], pairs[i]];
              }
            }
            const pack = jsonWithLen(request, { pairs }, 200, true);
            if (request.method === 'HEAD') return new Response(null, { status: pack.status, headers: pack.headers });
            return new Response(pack.body, { status: pack.status, headers: pack.headers });
          }
          // malformed -> fall through to auto mode
        } catch (_) {
          // parse error -> fall through to auto mode
        }
      }

      // Auto mode (or fallback): build deterministically from R2 using number-then-stem pairing
      const oPrefix = searchParams.get('originals') || 'originals/';
      const rPrefix = searchParams.get('remixes')   || 'remixes/';
      const urlBase = new URL(request.url).origin;
      const autoPairs = await buildAutoPairsFromR2(env.AUDIO, oPrefix, rPrefix);
      const pairs = autoPairs.map(([o, r], i) => {
        const idx = String(i+1).padStart(2,'0');
        return {
          title: `Track ${idx}`,
          originalLabel: `Original ${idx}`,
          remixLabel: `Remix ${idx}`,
          originalUrl: `${urlBase}/r2/${encodeURIComponent(o)}`,
          remixUrl: `${urlBase}/r2/${encodeURIComponent(r)}`
        };
      });
      const doShuffle = ['1','true','yes'].includes((searchParams.get('shuffle')||'').toLowerCase());
      if (doShuffle) {
        for (let i = pairs.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [pairs[i], pairs[j]] = [pairs[j], pairs[i]];
        }
      }
      const pack = jsonWithLen(request, { pairs }, 200, true);
      if (request.method === 'HEAD') return new Response(null, { status: pack.status, headers: pack.headers });
      return new Response(pack.body, { status: pack.status, headers: pack.headers });
    }

    // 2) Serve audio from R2: GET /r2/<key>
    if (pathname.startsWith('/r2/')) {
      if (!env.AUDIO) return json(request, { error: 'R2 not configured' }, 500);

      const key = decodeURIComponent(pathname.slice(4)); // remove leading '/r2/'
      const isHead = request.method === 'HEAD';

      // Respect HTTP Range for partial requests
      const range = parseRange(request.headers.get('Range'));
      const obj = range ? await env.AUDIO.get(key, { range }) : await env.AUDIO.get(key);
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
        headers['Content-Length'] = String(obj.range.length);
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
      const status = upstream.status; // may be 200 or 206
      const headers = {
        ...corsHeaders(request),
        'Content-Type': upstream.headers.get('Content-Type') || 'audio/mpeg',
        'Accept-Ranges': upstream.headers.get('Accept-Ranges') || 'bytes',
        'Content-Range': upstream.headers.get('Content-Range') || '',
        'Content-Length': upstream.headers.get('Content-Length') || '',
        'Cache-Control': 'public, max-age=3600',
        'ETag': upstream.headers.get('ETag') || '',
        'Last-Modified': upstream.headers.get('Last-Modified') || ''
      };
      const isHead = request.method === 'HEAD';
      const isPartial = status === 206 || !!headers['Content-Range'];
      return new Response(isHead ? null : upstream.body, { status: isPartial ? 206 : 200, headers });
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

    const pack = jsonWithLen(request, { ok: true, endpoints: ['/playlist?originals=&remixes=&shuffle=1', '/playlist/generate?dryrun=1', '/r2/<key>', '/audio?src=…', '/health'] });
    if (request.method === 'HEAD') return new Response(null, { status: pack.status, headers: pack.headers });
    return new Response(pack.body, { status: pack.status, headers: pack.headers });
  },
};
