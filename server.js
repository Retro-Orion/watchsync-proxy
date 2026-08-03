/*
 * WatchSync video proxy.
 * Run: node server.js   (listens on http://0.0.0.0:PORT, default 8090)
 *
 * GET /proxy?url=<encoded original video URL>
 *   - Fetches the real video from wherever it's hosted.
 * - Forces the correct Content-Type based on the file extension, instead of
 *   trusting whatever (possibly wrong) type the origin server declares.
 * - Forwards Range requests so seeking/streaming still works.
 * - Understands Google Drive share links and works around Drive's
 *   "can't scan this file for viruses" interstitial page for large files.
 * - Refuses to relay HTML pages (e.g. a Google sign-in page for a Drive file
 *   that isn't shared publicly) — returns a clear error instead of feeding
 *   the player a web page labeled as video.
 */
const http = require('http');
const { URL } = require('url');

const PORT = process.env.PORT || 8090;

const EXT_TO_TYPE = {
  mp4: 'video/mp4',
  m4v: 'video/x-m4v',
  mov: 'video/quicktime',
  mkv: 'video/x-matroska',
  webm: 'video/webm',
  m3u8: 'application/vnd.apple.mpegurl',
  ts: 'video/mp2t',
};

function guessContentType(urlStr) {
  const clean = urlStr.split('?')[0].split('#')[0];
  const m = clean.match(/\.([a-zA-Z0-9]+)$/);
  const ext = m ? m[1].toLowerCase() : '';
  return EXT_TO_TYPE[ext] || 'video/mp4'; // default to mp4 if unknown
}

function isDriveShareLink(urlStr) {
  return /drive\.google\.com\/(file\/d\/|open\?id=|uc\?)/.test(urlStr);
}

function extractDriveFileId(urlStr) {
  let m = urlStr.match(/\/file\/d\/([a-zA-Z0-9_-]+)/);
  if (m) return m[1];
  m = urlStr.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  if (m) return m[1];
  return null;
}

// Follows Google Drive's large-file "virus scan warning" interstitial and
// returns the real, final download URL.
async function resolveDriveUrl(fileId) {
  const direct = `https://drive.google.com/uc?export=download&id=${fileId}`;
  const res1 = await fetch(direct, { redirect: 'follow' });
  const type1 = res1.headers.get('content-type') || '';

  if (!type1.includes('text/html')) {
    // Small file — Drive served it directly, no warning page.
    return res1.url;
  }

  const html = await res1.text();
  const cookie = res1.headers.get('set-cookie') || '';

  // Current Drive flow (2024+): the warning page contains a form that submits
  // to drive.usercontent.google.com/download with hidden inputs (id, export,
  // confirm, uuid, ...). Rebuild that request from the form.
  const formMatch = html.match(/action="(https:\/\/drive\.usercontent\.google\.com\/download[^"]*)"/);
  if (formMatch) {
    const params = new URLSearchParams();
    for (const tag of html.matchAll(/<input[^>]*>/g)) {
      const n = tag[0].match(/name="([^"]+)"/);
      const v = tag[0].match(/value="([^"]*)"/);
      if (n) params.set(n[1], v ? v[1] : '');
    }
    if (!params.has('id')) params.set('id', fileId);
    if (!params.has('export')) params.set('export', 'download');
    if (!params.has('confirm')) params.set('confirm', 't');
    return { url: `${formMatch[1]}?${params.toString()}`, cookie };
  }

  // Older flow: confirm token goes back to drive.google.com/uc.
  const confirmMatch = html.match(/confirm=([0-9A-Za-z_-]+)/);
  const confirm = confirmMatch ? confirmMatch[1] : 't';
  return {
    url: `https://drive.google.com/uc?export=download&confirm=${confirm}&id=${fileId}`,
    cookie,
  };
}

// Some origin hosts (shared cPanel servers especially) occasionally kill the
// first connection ("terminated"). Retry a couple of times before giving up.
async function fetchWithRetry(url, opts, attempts = 3) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try { return await fetch(url, opts); }
    catch (e) {
      lastErr = e;
      console.log(`Origin fetch attempt ${i + 1} failed: ${e.message}`);
      await new Promise((r) => setTimeout(r, 700 * (i + 1)));
    }
  }
  throw lastErr;
}

const server = http.createServer(async (req, res) => {
  try {
    const reqUrl = new URL(req.url, `http://${req.headers.host}`);

    // Accept /proxy and also /proxy/anything.mp4 — iOS's player is happier
    // when the URL path ends in a known video extension, so clients may append
    // a cosmetic filename. Both forms behave identically.
    if (reqUrl.pathname !== '/proxy' && !reqUrl.pathname.startsWith('/proxy/')) {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('WatchSync proxy is running. Use /proxy?url=<video url>');
      return;
    }

    const target = reqUrl.searchParams.get('url');
    if (!target || !/^https?:\/\//i.test(target)) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('Missing or invalid "url" parameter.');
      return;
    }

    let fetchUrl = target;
    let extraHeaders = {};

    if (isDriveShareLink(target)) {
      const fileId = extractDriveFileId(target);
      if (!fileId) {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('Could not parse Google Drive file ID from that link.');
        return;
      }
      const resolved = await resolveDriveUrl(fileId);
      if (typeof resolved === 'string') {
        fetchUrl = resolved;
      } else {
        fetchUrl = resolved.url;
        if (resolved.cookie) extraHeaders['Cookie'] = resolved.cookie;
      }
    }

    // Forward Range header so the player can seek / stream in chunks.
    if (req.headers.range) extraHeaders['Range'] = req.headers.range;

    // A browser-like User-Agent keeps picky shared hosts happy.
    extraHeaders['User-Agent'] =
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

    const originRes = await fetchWithRetry(fetchUrl, { headers: extraHeaders, redirect: 'follow' });

    if (!originRes.ok && originRes.status !== 206) {
      res.writeHead(originRes.status, { 'Content-Type': 'text/plain' });
      res.end(`Origin server returned ${originRes.status}.`);
      return;
    }

    // Never relay an HTML page as if it were video. This happens when a Drive
    // file isn't shared publicly (Google serves its sign-in page) or when a
    // host serves an error/landing page instead of the file.
    const originType = (originRes.headers.get('content-type') || '').toLowerCase();
    if (originType.includes('text/html')) {
      res.writeHead(502, { 'Content-Type': 'text/plain' });
      res.end(
        isDriveShareLink(target)
          ? 'Google Drive returned a web page instead of the video. Make sure the file is shared as "Anyone with the link" (Viewer).'
          : 'The origin server returned a web page instead of a video file.'
      );
      return;
    }

    const headers = {
      'Content-Type': guessContentType(target), // forced, correct type
      'Accept-Ranges': 'bytes',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store',
    };
    const len = originRes.headers.get('content-length');
    if (len) headers['Content-Length'] = len;
    const range = originRes.headers.get('content-range');
    if (range) headers['Content-Range'] = range;

    res.writeHead(originRes.status === 206 ? 206 : 200, headers);

    // Stream the body through without buffering the whole file in memory.
    const reader = originRes.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
    }
    res.end();
  } catch (err) {
    console.error('Proxy error:', err.message);
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'text/plain' });
      res.end('Proxy error: ' + err.message);
    } else {
      res.end();
    }
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`WatchSync proxy listening on http://0.0.0.0:${PORT}`);
});
