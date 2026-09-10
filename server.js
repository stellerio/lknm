const express = require('express');
const path = require('path');
const dns = require('dns').promises;
const net = require('net');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname)));

function isPrivateHost(hostname) {
  const h = hostname.toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (net.isIP(h) === 4) {
    const p = h.split('.').map(Number);
    return p[0] === 10 || p[0] === 127 ||
      (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
      (p[0] === 192 && p[1] === 168 || p[0] === 169 && p[1] === 254);
  }
  if (net.isIP(h) === 6) return h === '::1' || h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe80:');
  return false;
}

async function safeUrl(raw) {
  const u = new URL(raw);
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error('Only HTTP and HTTPS URLs are supported.');
  if (isPrivateHost(u.hostname)) throw new Error('Private network addresses are not allowed.');
  try {
    const records = await dns.lookup(u.hostname, { all: true });
    if (records.some(r => isPrivateHost(r.address))) throw new Error('Private network addresses are not allowed.');
  } catch (e) {
    if (e.message.includes('Private network')) throw e;
  }
  return u;
}

app.get('/api/search', async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) return res.status(400).json({ error: 'Missing search query.' });
  if (q.length > 300) return res.status(400).json({ error: 'Search query is too long.' });

  try {
    const target = 'https://www.google.com/search?q=' + encodeURIComponent(q);
    const response = await fetch(target, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; Steller/1.0)',
        'Accept': 'text/html,application/xhtml+xml'
      },
      redirect: 'follow'
    });
    const html = await response.text();
    res.status(response.status).type('html').send(html);
  } catch (err) {
    res.status(502).json({ error: 'Search backend failed.' });
  }
});

app.get('/api/proxy', async (req, res) => {
  const raw = String(req.query.url || '').trim();
  if (!raw) return res.status(400).json({ error: 'Missing URL.' });

  try {
    const target = await safeUrl(raw);
    const response = await fetch(target, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Steller/1.0)' },
      redirect: 'follow'
    });
    const type = response.headers.get('content-type') || '';
    if (!type.includes('text/html')) {
      res.status(415).send('Steller proxy only displays HTML pages.');
      return;
    }
    let html = await response.text();
    const base = target.origin + target.pathname.replace(/[^/]*$/, '');
    html = html.replace(/<head([^>]*)>/i, `<head$1><base href="${base}">`);
    res.status(response.status).type('html').send(html);
  } catch (err) {
    res.status(400).json({ error: err.message || 'Proxy request failed.' });
  }
});

app.listen(PORT, () => console.log(`Steller backend running on port ${PORT}`));
