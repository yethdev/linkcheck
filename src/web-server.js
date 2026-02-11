import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { LinkChecker } from './link-checker.js';
import { parseBotResponse } from './response-parser.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Manages N browser instances for concurrent Discord checks.
// With POOL_SIZE=1 (default) it acts as a simple mutex.
// For parallel scans, set POOL_SIZE=N and provide N channel IDs via CHANNEL_IDS.

class CheckerPool {
  constructor() {
    this._instances = [];
    this._waiters = [];
    this._recovering = new Set();
  }

  get size()     { return this._instances.length; }
  get allBusy()  { return this._instances.filter(i => i.ready).every(i => i.busy); }
  get pending()  { return this._waiters.length; }
  get anyReady() { return this._instances.some(i => i.ready && !i.busy); }
  get activeScanCount() { return this._instances.filter(i => i.busy).length; }

  addInstance(id, config) {
    this._instances.push({
      id,
      config,
      checker: new LinkChecker(config),
      busy: false,
      ready: false,
      error: null,
      consecutiveFailures: 0,
    });
  }

  // Boot instances sequentially with retry - launching too many browsers at once overloads the system
  async initAll() {
    for (const inst of this._instances) {
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          console.log(`[Pool] Initializing instance ${inst.id}${attempt > 1 ? ` (retry ${attempt - 1})` : ''}…`);
          await inst.checker.init();
          inst.ready = true;
          inst.error = null;
          inst.consecutiveFailures = 0;
          console.log(`[Pool] Instance ${inst.id} ready  (channel ${inst.config.channelId})`);
          break; // success — stop retrying
        } catch (err) {
          inst.ready = false;
          inst.error = err.message;
          console.error(`[Pool] Instance ${inst.id} failed (attempt ${attempt}):`, err.message);
          try { await inst.checker.destroy(); } catch {}
          inst.checker = new LinkChecker(inst.config);
          if (attempt < 2) {
            console.log(`[Pool] Retrying instance ${inst.id} in 3s…`);
            await new Promise(r => setTimeout(r, 3000));
          }
        }
      }
    }
  }

  acquire(onPositionChange) {
    const free = this._instances.find(i => i.ready && !i.busy);
    if (free) {
      free.busy = true;
      return Promise.resolve({
        checker: free.checker,
        release: () => this._releaseInstance(free),
        id: free.id,
      });
    }
    // All busy → queue
    return new Promise(resolve => {
      this._waiters.push({ resolve, onPositionChange });
      this._notifyPositions();
    });
  }

  _releaseInstance(inst) {
    if (this._waiters.length > 0) {
      // Hand the slot straight to the next waiter (stays busy)
      const waiter = this._waiters.shift();
      this._notifyPositions();
      waiter.resolve({
        checker: inst.checker,
        release: () => this._releaseInstance(inst),
        id: inst.id,
      });
    } else {
      inst.busy = false;
    }
  }

  _notifyPositions() {
    for (let i = 0; i < this._waiters.length; i++) {
      const cb = this._waiters[i].onPositionChange;
      if (cb) try { cb(i + 1); } catch {}
    }
  }

  recordSuccess(id) {
    const inst = this._instances.find(i => i.id === id);
    if (inst) inst.consecutiveFailures = 0;
  }

  recordFailure(id) {
    const inst = this._instances.find(i => i.id === id);
    if (!inst) return;
    inst.consecutiveFailures++;
    if (inst.consecutiveFailures >= 3 && !this._recovering.has(id)) {
      console.warn(`[Pool] Instance ${id}: ${inst.consecutiveFailures} consecutive failures — recovering`);
      this.recoverInstance(id);
    }
  }

  // Tear down and rebuild one instance
  async recoverInstance(id) {
    const inst = this._instances.find(i => i.id === id);
    if (!inst || this._recovering.has(id)) return;
    this._recovering.add(id);
    console.warn(`[Pool] Recovering instance ${id}…`);
    inst.ready = false;
    try { await inst.checker.destroy(); } catch {}
    inst.checker = new LinkChecker(inst.config);
    try {
      await inst.checker.init();
      inst.ready = true;
      inst.error = null;
      inst.consecutiveFailures = 0;
      console.log(`[Pool] Instance ${id} recovered.`);
    } catch (err) {
      inst.error = err.message;
      console.error(`[Pool] Instance ${id} recovery failed:`, err.message);
    }
    this._recovering.delete(id);
  }

  async healthCheck() {
    for (const inst of this._instances) {
      if (!inst.ready || inst.busy || this._recovering.has(inst.id)) continue;
      try {
        await inst.checker.discord.page.evaluate(() => document.readyState);
      } catch (err) {
        console.warn(`[Pool] Instance ${inst.id} health-check failed:`, err.message);
        this.recoverInstance(inst.id);
      }
    }
  }

  reset() {
    const waiters = this._waiters.splice(0);
    for (const w of waiters) {
      try { w.resolve({ checker: null, release: () => {}, id: -1 }); } catch {}
    }
    for (const inst of this._instances) inst.busy = false;
  }

  async destroyAll() {
    for (const inst of this._instances) {
      try { await inst.checker.destroy(); } catch {}
    }
  }
}

class RateLimiter {
  constructor(maxHits = 5, windowMs = 120_000) {
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

  cleanup() {
    const cutoff = Date.now() - this._windowMs;
    for (const [ip, ts] of this._hits) {
      const fresh = ts.filter(t => t > cutoff);
      if (fresh.length === 0) this._hits.delete(ip);
      else this._hits.set(ip, fresh);
    }
  }
}

export async function startWebServer(config, port = 3000) {
  const app = express();
  app.set('trust proxy', true);
  app.use(express.json());
  app.use(express.static(join(__dirname, '..', 'public')));

  /* ---------- Build the checker pool ---------- */
  const poolSize = Number(process.env.POOL_SIZE || 1);
  const channelIds = process.env.CHANNEL_IDS
    ? process.env.CHANNEL_IDS.split(',').map(s => s.trim()).filter(Boolean)
    : [config.channelId];

  const pool = new CheckerPool();
  for (let i = 0; i < poolSize; i++) {
    pool.addInstance(i, {
      ...config,
      channelId: channelIds[i % channelIds.length],
    });
  }

  console.log(`[Pool] Creating ${poolSize} checker instance(s) across ${channelIds.length} channel(s)`);

  const limiter = new RateLimiter(15, 120_000);
  setInterval(() => limiter.cleanup(), 60_000);

  await pool.initAll();

  const anyReady = () => pool._instances.some(i => i.ready);
  const firstError = () => {
    const bad = pool._instances.find(i => i.error);
    return bad ? bad.error : null;
  };

  setInterval(() => pool.healthCheck(), 60_000);

  app.get('/api/status', (req, res) => {
    const rl = limiter.check(req.ip);
    const timestamps = limiter._hits.get(req.ip);
    if (timestamps) timestamps.pop();
    res.json({
      ready: anyReady(),
      error: firstError(),
      queue: pool.pending,
      busy: pool.allBusy,
      poolSize: pool.size,
      activeScans: pool.activeScanCount,
      rateLimit: { remaining: rl.remaining, retryAfter: rl.allowed ? 0 : Math.ceil(rl.retryAfterMs / 1000) },
    });
  });

  app.post('/api/check', async (req, res) => {
    const { url } = req.body;

    if (!url) {
      return res.status(400).json({ error: 'URL is required' });
    }
    if (!anyReady()) {
      return res.status(503).json({ error: 'Discord bot not connected' });
    }

    const rl = limiter.check(req.ip);
    if (!rl.allowed) {
      return res.status(429).json({
        error: 'Rate limited — try again in ' + Math.ceil(rl.retryAfterMs / 1000) + 's',
        retryAfter: Math.ceil(rl.retryAfterMs / 1000),
      });
    }

    const { checker, release, id } = await pool.acquire();
    if (!checker) {
      return res.status(503).json({ error: 'Server is reinitializing — try again' });
    }
    try {
      const message = `/check all ${url}`;
      const reply = await checker.sendRaw(message);
      const parsed = parseBotResponse(reply);
      release();
      pool.recordSuccess(id);

      res.json({
        url,
        platforms: parsed.platforms,
        note: parsed.note,
        raw: parsed.raw,
        blocked: parsed.platforms.filter((p) => p.status === 'blocked').length,
        unblocked: parsed.platforms.filter((p) => p.status === 'unblocked').length,
        loading: parsed.platforms.filter((p) => p.status === 'loading').length,
        errors: parsed.platforms.filter((p) => p.status === 'error').length,
        total: parsed.platforms.length,
      });
    } catch (err) {
      release();
      pool.recordFailure(id);
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/check-stream', async (req, res) => {
    const url = req.query.url;

    if (!url) {
      res.status(400).json({ error: 'URL is required' });
      return;
    }
    if (!anyReady()) {
      res.status(503).json({ error: 'Discord bot not connected' });
      return;
    }

    const rl = limiter.check(req.ip);
    if (!rl.allowed) {
      res.status(429).json({
        error: 'Rate limited — try again in ' + Math.ceil(rl.retryAfterMs / 1000) + 's',
        retryAfter: Math.ceil(rl.retryAfterMs / 1000),
      });
      return;
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      'Content-Encoding': 'identity',
    });
    res.flushHeaders();

    if (res.socket) res.socket.setNoDelay(true);

    const send = (event, data) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      if (typeof res.flush === 'function') res.flush();
    };

    let closed = false;
    req.on('close', () => { closed = true; });

    const sentPlatforms = new Set();
    const message = `/check all ${url}`;
    const MAX_ATTEMPTS = 2;
    const ATTEMPT_TIMEOUTS = [15_000, 25_000]; // first try fast, second try longer
    let lastError = null;
    let success = false;

    for (let attempt = 0; attempt < MAX_ATTEMPTS && !closed; attempt++) {
      // Acquire a checker — queue events only fire if user is ACTUALLY waiting
      const { checker, release, id } = await pool.acquire((position) => {
        if (!closed) send('queued', { position });
      });

      // Pool reset while we were waiting
      if (!checker) {
        send('error', { error: 'Server is reinitializing — try again' });
        res.end();
        return;
      }

      // Client left while we were queued
      if (closed) {
        release();
        return;
      }

      const attemptTimeout = ATTEMPT_TIMEOUTS[attempt] ?? 25_000;

      let sawNote = false;
      try {
        const finalReply = await checker.sendRawStreaming(message, (partial) => {
          const parsed = parseBotResponse(partial);
          for (const p of parsed.platforms) {
            if (p.status === 'loading') continue;
            if (!sentPlatforms.has(p.name)) {
              sentPlatforms.add(p.name);
              send('platform', p);
            }
          }
          if (parsed.note) {
            send('note', { note: parsed.note });
            sawNote = true;
          }

          const hasLoading = parsed.platforms.some(p => p.status === 'loading');
          const finishedCount = parsed.platforms.filter(p => p.status !== 'loading').length;

          // Content is only "complete" when:
          //   - no platforms are still loading, AND
          //   - we've seen the disclaimer note (bot sends it last), AND
          //   - we have a reasonable number of results (>=10)
          // This prevents the stability detector from cutting off early
          // when the bot pauses between progressive edits.
          const looksComplete = !hasLoading && sawNote && finishedCount >= 10;
          return looksComplete;
        }, attemptTimeout);

        release();
        pool.recordSuccess(id);

        const finalParsed = parseBotResponse(finalReply);
        for (const p of finalParsed.platforms) {
          if (p.status === 'loading') continue;
          if (!sentPlatforms.has(p.name)) {
            sentPlatforms.add(p.name);
            send('platform', p);
          }
        }
        if (finalParsed.note) send('note', { note: finalParsed.note });

        // If we got real results, we're done
        if (sentPlatforms.size > 0) {
          success = true;
          break;
        }

        // Zero platforms — the bot probably never saw our message.
        // Retry on a different instance if we have attempts left.
        if (attempt < MAX_ATTEMPTS - 1) {
          console.warn(`[Scan] Attempt ${attempt + 1} returned 0 platforms — retrying on different instance`);
          continue;
        }
        // Last attempt, still 0 — send done anyway
        success = true;
        break;

      } catch (err) {
        release();
        pool.recordFailure(id);
        lastError = err;

        if (attempt < MAX_ATTEMPTS - 1) {
          console.warn(`[Scan] Attempt ${attempt + 1} failed (${err.message}) — retrying on different instance`);
          continue;
        }
      }
    }

    if (success) {
      send('done', { url, count: sentPlatforms.size });
      res.end();
    } else {
      send('error', { error: lastError?.message || 'Scan failed after retries' });
      res.end();
    }
  });

  const server = app.listen(port, () => {
    console.log('Link Checker UI running at http://localhost:' + port);
    console.log(pool.size + ' checker instance(s), ' + channelIds.length + ' channel(s)');
  });

  const shutdown = async () => {
    console.log('Shutting down...');
    server.close();
    await pool.destroyAll();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  return { app, server, pool };
}
