// Business rules shared by the API and the Control Center. The server is the source of truth:
// the app's gates (age, plan, feature flags) are repeated here so they can't be bypassed.
import { fail } from './errors.js';

export const TIER_RANK = { free: 0, pro: 1, plus: 2 };
export const FMT = ['live', 'english', 'reserve', 'sealed', 'dutch', 'buynow', 'swapbid'];
export const PRO_FMTS = ['english', 'reserve', 'buynow'];
export const SCAM_WORDS = /\b(otp|upi|qr|advance|pin|cvv|password)\b/i;

export function ageOf(dob, now = new Date()) {
  const d = new Date(dob + 'T00:00:00Z');
  if (Number.isNaN(d.getTime())) return -1;
  let a = now.getUTCFullYear() - d.getUTCFullYear();
  const m = now.getUTCMonth() - d.getUTCMonth();
  if (m < 0 || (m === 0 && now.getUTCDate() < d.getUTCDate())) a--;
  return a;
}
export const effectiveTier = u => (u.tier !== 'free' && u.tier_until && new Date(u.tier_until) < new Date() ? 'free' : u.tier);
export const hasTier = (u, t) => TIER_RANK[u.tier] >= TIER_RANK[t];

export function needFeature(db, name) {
  if (!db.setting('features')[name]) fail(503, 'This feature is switched off right now.', 'feature_off');
}
export function needAdult(u, msg = 'This is for members 18 and over.') { if (!u.adult) fail(403, msg, 'adult_only'); }
// Auctions: members 18+ can see them; bidding, buying and selling by auction start at bidAge (23 by default).
export function needBidAge(db, u, msg) {
  const { bidAge } = db.setting('limits');
  if (u.age < bidAge) fail(403, msg || `Bidding and selling by auction are for members ${bidAge} and over.`, 'bid_age');
}
export function needAuctionView(req) {
  if (!req.user) fail(401, 'Log in to see auctions.', 'login_required');
  if (!req.user.adult) fail(403, 'Auctions are for members 18 and over.', 'adult_only');
}
export const PHONE_RE = /^\+91[6-9]\d{9}$/;
export const normPhone = v => { const d = String(v || '').replace(/[\s-]/g, ''); return /^[6-9]\d{9}$/.test(d) ? '+91' + d : d.startsWith('91') && d.length === 12 ? '+' + d : d; };
export function needTier(u, t, msg) { if (!hasTier(u, t)) fail(402, msg || `This needs ${t === 'plus' ? 'Pro Plus' : 'Pro'}.`, 'upgrade'); }
// Teens (15-17) need verified parental consent before they can post, offer or chat (DPDP Act 2023).
export function needConsent(u) {
  if (!u.adult && !u.guardian_consent) fail(403, 'A parent or guardian needs to confirm your account first.', 'guardian_consent');
}

export const nowIso = () => new Date().toISOString();
export const addMin = (iso, min) => new Date(new Date(iso).getTime() + min * 60000).toISOString();

export const topBid = bids => bids.reduce((t, b) => (!t || b.amount > t.amount ? b : t), null);
export function minNext(a, bids) {
  const t = topBid(bids);
  return t ? t.amount + a.inc : a.start;
}
export function dutchPrice(a, at = new Date()) {
  if (!a.starts_at) return a.start;
  const steps = Math.floor((at - new Date(a.starts_at)) / ((a.dutch_every_min || 4) * 60000));
  return Math.max(a.dutch_floor ?? a.start, a.start - steps * (a.dutch_step || 0));
}
export const str = (v, max = 500) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
export const int = v => (Number.isFinite(+v) ? Math.round(+v) : NaN);
