const express = require('express');
const path = require('path');
const dns = require('dns').promises;
const net = require('net');

const app = express();
const PORT = process.env.PORT || 3000;
const MAX_HTML = 8 * 1024 * 1024;

app.use(express.static(path.join(__dirname)));

function isPrivateHost(hostname) {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local')) return true;
  if (net.isIP(h) === 4) {
    const p = h.split('.').map(Number);
    return p[0] === 10 || p[0] === 127 ||
      (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
      (p[0] === 192 && p[1] === 168) ||
      (p[0] === 169 && p[1] === 254) ||
      (p[0] === 100 && p[1] >= 64 && p[1] <= 127);
  }
  if (net.isIP(h) === 6) {
    const v = h.toLowerCase();
    return v === '::1' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80:') || v.startsWith('::ffff:127.');
  }
  return false;
}

async function safeUrl(raw) {
  const u = new URL(raw);
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error('Only HTTP and HTTPS websites are supported.');
  if (isPrivateHost(u.hostname)) throw new Error('Private network addresses are not allowed.');
  try {
    const records = await dns.lookup(u.hostname, { all: true });
    if (records.some(r => isPrivateHost(r.address))) throw new Error('Private network addresses are not allowed.');
  } catch (e) {
    if (e.message.includes('Private network')) throw e;
  }
  return u;
}

async function readLimited(response) {
  const reader = response.body?.getReader();
  if (!reader) return await response.text();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_HTML) throw new Error('The page is too large for Steller.');
    chunks.push(value);
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return new TextDecoder().decode(merged);
}

function absoluteUrl(value, base) {
  try { return new URL(value, base).href; } catch { return null; }
}

function proxyUrl(value, base) {
  const absolute = absoluteUrl(value, base);
  if (!absolute) return value;
  if (!/^https?:$/i.test(new URL(absolute).protocol)) return value;
  return '/api/proxy?url=' + encodeURIComponent(absolute);
}

function rewritePage(html, target) {
  const base = target.href;
  html = html.replace(/<base[^>]*>/gi, '');
  html = html.replace(/<head([^>]*)>/i, '<head$1><base href="' + target.origin + '/">');

  html = html.replace(/\s(href|action)\s*=\s*(["'])(.*?)\2/gi, (all, attr, quote, value) => {
    if (/^(#|javascript:|mailto:|tel:|data:|blob:)/i.test(value.trim())) return all;
    const absolute = absoluteUrl(value.trim(), base);
    if (!absolute) return all;
    if (!/^https?:$/i.test(new URL(absolute).protocol)) return all;
    return ' ' + attr + '=' + quote + proxyUrl(value.trim(), base) + quote;
  });

  // A proxied page is already inside Steller, so links must not create new browser tabs.
  html = html.replace(/\s(target)\s*=\s*(["'])(?:_blank|_parent|_top)\2/gi, '');
  html = html.replace(/<head([^>]*)>/i, '<head$1><style>html{scroll-behavior:smooth}</style>');

  // Stop common page scripts from intentionally opening a separate top-level window.
  html = html.replace(/<head([^>]*)>/i, '<head$1><script>try{window.open=function(url){if(url)location.href=url;return window};}catch(e){}</script>');
  return html;
}

app.get('/api/search', async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) return res.status(400).json({ error: 'Missing search query.' });
  if (q.length > 300) return res.status(400).json({ error: 'Search query is too long.' });

  try {
    const target = 'https://www.google.com/search?udm=14&q=' + encodeURIComponent(q);
    const response = await fetch(target, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/140 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml'
      },
      redirect: 'follow'
    });
    const html = await readLimited(response);
    const results = [];
    const seen = new Set();
    const linkRegex = /<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
    let match;
    while ((match = linkRegex.exec(html)) && results.length < 30) {
      let href = match[1].replace(/&amp;/g, '&');
      const text = match[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      if (href.startsWith('/url?')) {
        try { href = new URL('https://www.google.com' + href).searchParams.get('q') || href; } catch {}
      }
      if (!/^https?:\/\//i.test(href)) continue;
      let u;
      try { u = new URL(href); } catch { continue; }
      if (u.hostname.endsWith('google.com')) continue;
      if (!text || text.length < 2 || seen.has(href)) continue;
      seen.add(href);
      results.push({ title: text.slice(0, 180), url: href, displayUrl: u.hostname + u.pathname });
    }
    res.json({ query: q, results });
  } catch (err) {
    res.status(502).json({ error: 'Search backend failed. Try again in a moment.' });
  }
});

app.get('/api/proxy', async (req, res) => {
  const raw = String(req.query.url || '').trim();
  if (!raw) return res.status(400).send('Missing URL.');
  try {
    const target = await safeUrl(raw);
    const response = await fetch(target.href, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/140 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,image/avif,image/webp,*/*;q=0.8'
      },
      redirect: 'follow'
    });
    const finalTarget = await safeUrl(response.url);
    const type = response.headers.get('content-type') || '';
    if (!type.includes('text/html') && !type.includes('application/xhtml+xml')) {
      res.status(415).send('<!doctype html><body style="font-family:system-ui;padding:40px">Steller can currently render HTML pages here. This URL returned a non-HTML resource.</body>');
      return;
    }
    const html = rewritePage(await readLimited(response), finalTarget);
    res.status(response.status).set('Content-Type', 'text/html; charset=utf-8').send(html);
  } catch (err) {
    res.status(400).send('<!doctype html><body style="font-family:system-ui;padding:40px"><h2>Steller could not load this page</h2><p>' + String(err.message || 'Request failed').replace(/[<>]/g, '') + '</p></body>');
  }
});

app.get(/.*/, (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.listen(PORT, () => console.log(`Steller running on port ${PORT}`));
