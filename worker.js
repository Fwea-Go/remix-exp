export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,HEAD,OPTIONS',
      'Access-Control-Allow-Headers': 'Range, Content-Type',
      'Access-Control-Expose-Headers': 'Content-Range, Accept-Ranges, Content-Length'
    };
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });

    // Public audio: /audio/<key>
    if (url.pathname.startsWith('/audio/')) {
      const key = decodeURIComponent(url.pathname.replace('/audio/',''));
      const range = request.headers.get('Range');
      let obj;
      if (range) {
        const [_, start, end] = /bytes=(\d+)-(\d+)?/.exec(range) || [];
        obj = await env.AUDIO.get(key, end
          ? { range: { offset: +start, length: +end - +start + 1 } }
          : { range: { offset: +start } });
      } else {
        obj = await env.AUDIO.get(key);
      }
      if (!obj) return new Response('Not found', { status: 404, headers: cors });

      const headers = {
        ...cors,
        'Content-Type': obj.httpMetadata?.contentType || 'audio/mpeg',
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'public, max-age=3600'
      };
      if (obj.range) {
        const start = obj.range.offset;
        const len = obj.range.length;
        const total = obj.size;
        headers['Content-Range'] = `bytes ${start}-${start+len-1}/${total}`;
        return new Response(obj.body, { status: 206, headers });
      }
      return new Response(obj.body, { headers });
    }

    return new Response('OK', { headers: cors });
  }
}
