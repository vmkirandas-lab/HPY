// Password hashing (scrypt) and signed bearer tokens (HMAC-SHA256). No third-party crypto.
import crypto from 'node:crypto';
import { HttpError } from './errors.js';
import { ageOf, effectiveTier } from './rules.js';

let SECRET = process.env.TOKEN_SECRET;
if (!SECRET) {
  SECRET = crypto.randomBytes(32).toString('hex');
  if (process.env.NODE_ENV === 'production') throw new Error('TOKEN_SECRET must be set in production');
}
const TTL_SEC = Number(process.env.TOKEN_TTL_SEC || 7 * 24 * 3600);

export function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  return `scrypt$${salt.toString('hex')}$${crypto.scryptSync(pw, salt, 64).toString('hex')}`;
}
export function checkPassword(pw, stored) {
  const [, salt, hash] = String(stored).split('$');
  if (!salt || !hash) return false;
  const a = crypto.scryptSync(pw, Buffer.from(salt, 'hex'), 64), b = Buffer.from(hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const b64 = s => Buffer.from(s).toString('base64url');
// Short-lived signed tickets (a verified phone number, or a Google/Apple identity waiting to finish sign-up).
export function signTicket(payload, ttlSec = 900) {
  const body = b64(JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + ttlSec, t: 'ticket' }));
  return `${body}.${sign(body)}`;
}
export function readTicket(tok, kind) {
  const p = readToken(tok);
  return p && p.t === 'ticket' && p.kind === kind ? p : null;
}
const sign = data => crypto.createHmac('sha256', SECRET).update(data).digest('base64url');
export function issueToken(user) {
  const body = b64(JSON.stringify({ uid: user.id, exp: Math.floor(Date.now() / 1000) + TTL_SEC }));
  return `${body}.${sign(body)}`;
}
function readToken(tok) {
  const [body, sig] = String(tok).split('.');
  if (!body || !sig) return null;
  const want = sign(body);
  if (want.length !== sig.length || !crypto.timingSafeEqual(Buffer.from(want), Buffer.from(sig))) return null;
  const p = JSON.parse(Buffer.from(body, 'base64url').toString());
  return p.exp > Date.now() / 1000 ? p : null;
}

// Attaches req.user (with computed age, adult flag and current tier) when a valid token is sent.
export const authenticate = db => (req, _res, next) => {
  const h = req.get('authorization') || '';
  const p = h.startsWith('Bearer ') ? readToken(h.slice(7)) : null;
  if (p) {
    const u = db.get('SELECT * FROM users WHERE id=?', p.uid);
    if (u && !u.banned && u.status === 'active' && p.t !== 'ticket') {
      const limits = db.setting('limits');
      u.age = ageOf(u.dob);
      u.adult = u.age >= limits.adultAge;
      u.tier = effectiveTier(u);
      req.user = u;
    }
  }
  next();
};

export function requireUser(req) {
  if (!req.user) throw new HttpError(401, 'Please log in.');
  return req.user;
}
export function requireStaff(req, role = 'moderator') {
  const u = requireUser(req);
  const rank = { user: 0, moderator: 1, admin: 2 };
  if (rank[u.role] < rank[role]) throw new HttpError(403, role === 'admin' ? 'Admins only.' : 'Staff only.');
  return u;
}
