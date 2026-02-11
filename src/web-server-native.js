import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { checkAllFilters, PLATFORM_NAMES, warmUp } from './native-checker.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const MAX_BATCH = 20;
const MAX_BODY = '16kb';

class RateLimiter {
  constructor(maxHits, windowMs) {
    this._maxHits = maxHits;
    this._windowMs = windowMs;
    this._hits = new Map();
  }

  check(ip) {
    const now = Date.now();
    const cutoff = now - this._windowMs;
    let timestamps = this._hits.get(ip) || [];
    timestamps = timestamps.filter(t => t > cutoff);
    this._hits.set(ip, timestamps);

    if (timestamps.length >= this._maxHits) {
      const oldest = timestamps[0];
      return { allowed: false, remaining: 0, retryAfterMs: oldest + this._windowMs - now };
    }
    timestamps.push(now);
    return { allowed: true, remaining: this._maxHits - timestamps.length, retryAfterMs: 0 };
  }

  undo(ip) {
    const ts = this._hits.get(ip);
    if (ts) ts.pop();
  }

  cleanup() {
    const cutoff = Date.now() - this._windowMs;
    for (const [ip, ts] of this._hits) {
      const fresh = ts.filter(t => t > cutoff);
      if (fresh.length === 0) this._hits.delete(ip);
      else this._hits.set(ip, fresh);
    }
  }
}

let activeScans = 0;

function sanitizeUrl(raw) {
  if (typeof raw !== 'string') return null;
  let cleaned = raw.trim();
  if (!cleaned) return null;
  if (cleaned.length > 2048) return null;
  cleaned = cleaned.replace(/^https?:\/\//i, '').replace(/\/$/, '');
  if (!cleaned || cleaned.includes(' ') || cleaned.includes('<') || cleaned.includes('>')) return null;
  if (!/[a-zA-Z0-9]/.test(cleaned)) return null;
  return cleaned;
}

const ALLOWED_ORIGINS = [
  'http://localhost:3002',
];

function isAllowedOrigin(req) {
  const origin = req.get('origin') || '';
  const referer = req.get('referer') || '';
  if (ALLOWED_ORIGINS.some(o => origin === o)) return true;
  if (ALLOWED_ORIGINS.some(o => referer.startsWith(o + '/'))) return true;
  if (!origin && !referer) return false;
  return false;
}

export async function startWebServer(port = 3000) {
  const rateLimitEnabled = process.env.WEB_RATE_LIMIT !== 'false';
  const rateLimitMax = Number(process.env.WEB_RATE_LIMIT_MAX || 100);
  const rateLimitWindowMs = 60_000;

  const app = express();
  app.set('trust proxy', true);
  app.disable('x-powered-by');
  app.use(express.json({ limit: MAX_BODY }));
  app.use(express.urlencoded({ limit: MAX_BODY, extended: false }));

  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    next();
  });

  app.use(express.static(join(__dirname, '..', 'public'), { maxAge: '10m' }));

  app.use('/api', (req, res, next) => {
    if (!isAllowedOrigin(req)) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    next();
  });

  const singleLimiter = new RateLimiter(rateLimitEnabled ? rateLimitMax : Infinity, rateLimitWindowMs);
  const batchLimiter = new RateLimiter(rateLimitEnabled ? Math.max(1, Math.floor(rateLimitMax / 20)) : Infinity, rateLimitWindowMs);
  setInterval(() => { singleLimiter.cleanup(); batchLimiter.cleanup(); }, 60_000);

  app.get('/api/status', (req, res) => {
    const rl = singleLimiter.check(req.ip);
    singleLimiter.undo(req.ip);
    res.json({
      ready: true,
      busy: activeScans > 0,
      platforms: PLATFORM_NAMES.length,
      rateLimit: { remaining: rl.remaining },
    });
  });

  app.get('/api/check-stream', async (req, res) => {
    const url = sanitizeUrl(req.query.url);
    if (!url) return res.status(400).json({ error: 'Invalid URL' });

    const rl = singleLimiter.check(req.ip);
    if (!rl.allowed) {
      return res.status(429).json({
        error: 'Rate limited',
        retryAfter: Math.ceil(rl.retryAfterMs / 1000),
      });
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
      'CDN-Cache-Control': 'no-store',
      'Pragma': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      'Content-Encoding': 'identity',
    });
    res.flushHeaders();
    if (res.socket) res.socket.setNoDelay(true);

    const send = (event, data) => {
      res.write('event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n');
      if (typeof res.flush === 'function') res.flush();
    };

    let closed = false;
    req.on('close', () => { closed = true; });

    activeScans++;
    let platformCount = 0;

    try {
      await checkAllFilters(url, (result) => {
        if (closed) return;
        platformCount++;
        send('platform', result);
      });
    } catch (err) {
      if (!closed) send('error', { error: 'Check failed' });
    }

    activeScans--;
    if (!closed) {
      send('done', { url, count: platformCount });
      res.end();
    }
  });

  app.get('/api/batch', async (req, res) => {
    const rawParam = req.query.urls;
    if (!rawParam) {
      return res.status(400).json({ error: 'Provide a urls query parameter' });
    }

    let rawUrls;
    try { rawUrls = JSON.parse(rawParam); } catch (_) {
      return res.status(400).json({ error: 'Invalid urls parameter' });
    }
    if (!Array.isArray(rawUrls) || rawUrls.length === 0) {
      return res.status(400).json({ error: 'Provide a urls array' });
    }
    if (rawUrls.length > MAX_BATCH) {
      return res.status(400).json({ error: 'Maximum ' + MAX_BATCH + ' URLs per batch' });
    }

    const rl = batchLimiter.check(req.ip);
    if (!rl.allowed) {
      return res.status(429).json({
        error: 'Rate limited',
        retryAfter: Math.ceil(rl.retryAfterMs / 1000),
      });
    }

    const urls = [];
    for (const raw of rawUrls) {
      const cleaned = sanitizeUrl(raw);
      if (cleaned) urls.push(cleaned);
    }
    if (urls.length === 0) {
      return res.status(400).json({ error: 'No valid URLs provided' });
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      'Content-Encoding': 'identity',
    });
    res.flushHeaders();
    if (res.socket) res.socket.setNoDelay(true);

    const send = (event, data) => {
      res.write('event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n');
      if (typeof res.flush === 'function') res.flush();
    };

    let closed = false;
    req.on('close', () => { closed = true; });

    send('start', { total: urls.length });

    let completed = 0;
    const pending = urls.map((url, i) => {
      const platforms = [];
      return checkAllFilters(url, (result) => {
        platforms.push({ name: result.name, status: result.status, category: result.category });
      }).catch(() => {}).then(() => {
        if (closed) return;
        const blocked = platforms.filter(p => p.status === 'blocked').length;
        const unblocked = platforms.filter(p => p.status === 'unblocked').length;
        completed++;
        send('progress', { index: i, completed, total: urls.length, result: { url, platforms, blocked, unblocked, total: platforms.length } });
      });
    });

    await Promise.all(pending);

    if (!closed) {
      send('done', { count: urls.length });
      res.end();
    }
  });

  warmUp().catch(() => {});

  const server = app.listen(port, () => {
    console.log('linkcheck by yeth.dev — running on port ' + port);
  });

  const shutdown = () => {
    server.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  return { app, server };
}