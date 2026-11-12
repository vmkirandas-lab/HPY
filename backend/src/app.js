// Builds the Express app. Kept separate from server.js so tests can run it on a random port.
import express from 'express';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.js';
import { authenticate } from './auth.js';
import { HttpError } from './errors.js';
import account, { purgeDeleted } from './routes/account.js';
import market from './routes/market.js';
import auctions, { closeExpired } from './routes/auctions.js';
import studio from './routes/studio.js';
import community from './routes/community.js';
import admin from './routes/admin.js';
import impact from './routes/impact.js';
import brands from './routes/brands.js';
import profile from './routes/profile.js';

export function createApp({ dbPath } = {}) {
  const db = openDb(dbPath);
  const app = express();
  const origins = (process.env.CORS_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);

  app.disable('x-powered-by');
  app.set('trust proxy', process.env.TRUST_PROXY === '1');
  app.use(express.json({ limit: '200kb' }));
  app.use((req, res, next) => {
    res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY' });
    const o = req.get('origin');
    if (o && (origins.includes('*') || origins.includes(o))) {
      res.set({ 'Access-Control-Allow-Origin': o, 'Vary': 'Origin', 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Allow-Methods': 'GET,POST,PATCH,PUT,DELETE' });
      if (req.method === 'OPTIONS') return res.sendStatus(204);
    }
    next();
  });

  // Simple per-IP limiter for login and sign-up. Use a shared store (e.g. Redis) when running several servers.
  const hits = new Map();
  const limiter = (max, windowMs) => (req, _res, next) => {
    const key = req.ip + req.path, now = Date.now(), h = hits.get(key) || { n: 0, t: now };
    if (now - h.t > windowMs) { h.n = 0; h.t = now; }
    if (++h.n > max) return next(new HttpError(429, 'Too many attempts. Try again in a few minutes.'));
    hits.set(key, h); next();
  };
  app.use(['/api/auth/login', '/api/auth/signup'], limiter(Number(process.env.AUTH_RATE_MAX || 20), 10 * 60000));

  app.use('/api', authenticate(db));
  app.get('/api/health', (_req, res) => res.json({ ok: true, name: 'Swaapo API', time: new Date().toISOString() }));
  // Maintenance mode blocks every write except for staff.
  app.use('/api', (req, _res, next) => {
    const m = db.setting('maintenance');
    if (m.on && req.method !== 'GET' && !req.path.startsWith('/auth/login') && !(req.user && req.user.role !== 'user')) return next(new HttpError(503, m.message, 'maintenance'));
    next();
  });
  app.get('/api/config', (_req, res) => res.json({ features: db.setting('features'), maintenance: db.setting('maintenance'),
    plans: db.setting('plans'), coins: db.setting('coins'), impact: db.setting('impact'), categories: db.setting('categories'), limits: db.setting('limits') }));
  for (const mod of [account, market, auctions, studio, community, impact, brands, profile]) app.use('/api', mod(db));
  app.use('/api/admin', admin(db));

  app.use('/admin', express.static(fileURLToPath(new URL('../admin', import.meta.url))));
  app.get('/', (_req, res) => res.redirect('/admin/'));

  app.use('/api', (_req, _res, next) => next(new HttpError(404, 'Not found.')));
  app.use((err, _req, res, _next) => {
    const status = err.status || (err.type === 'entity.parse.failed' ? 400 : 500);
    if (!err.status && status >= 500) console.error(err);
    res.status(status).json({ error: err.status || status < 500 ? err.message : 'Something went wrong on our side.', code: err.code });
  });

  const timer = setInterval(() => { closeExpired(db); purgeDeleted(db); }, 5000);
  timer.unref();
  return { app, db };
}
