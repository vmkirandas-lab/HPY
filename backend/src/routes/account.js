// Sign-up, login, profile, plans, Swaapo Coins and Women's Circle.
import { Router } from 'express';
import crypto from 'node:crypto';
import { hashPassword, checkPassword, issueToken, requireUser, signTicket, readTicket } from '../auth.js';
import { verifyIdToken } from '../oauth.js';
import { refreshTrust } from './profile.js';
import { fail } from '../errors.js';
import { ageOf, needAdult, needFeature, str, TIER_RANK, PHONE_RE, normPhone, nowIso } from '../rules.js';

export const publicUser = u => u && ({
  id: u.id, handle: u.handle, name: u.name, area: u.area, bio: u.bio, verified: !!u.verified,
  tier: u.tier, trust: u.trust, circle: u.circle_status === 'member', created_at: u.created_at,
});
export const selfUser = u => ({
  ...publicUser(u), email: u.email, email_verified: !!u.email_verified, id_verified: !!u.id_verified, id_last4: u.id_last4, avatar_url: u.avatar_url, phone: u.phone, status: u.status, dob: u.dob, age: u.age, adult: u.adult, role: u.role, tier_until: u.tier_until,
  coins: u.coins, circle_status: u.circle_status, kyc_status: u.kyc_status, guardian_consent: !!u.guardian_consent,
});

export default function account(db) {
  const r = Router();

  // ---- shared helpers
  const otpHash = (phone, code) => crypto.createHash('sha256').update(`${phone}:${code}`).digest('hex');
  const devOtp = process.env.NODE_ENV !== 'production';
  // Logging in again undoes a deactivation, or cancels a deletion that is still in its grace period.
  function finishLogin(u) {
    if (u.banned) fail(403, `This account is suspended${u.ban_reason ? ': ' + u.ban_reason : '.'}`, 'banned');
    if (u.status === 'deleted') fail(401, 'This account has been deleted.', 'deleted');
    let restored = null;
    if (u.status === 'deactivated') restored = 'reactivated';
    if (u.status === 'pending_deletion') restored = 'deletion_cancelled';
    if (restored) {
      db.run("UPDATE users SET status='active', deactivated_at=NULL, delete_after=NULL WHERE id=?", u.id);
      db.audit(u.id, `user.${restored}`, `user:${u.id}`);
    }
    return { token: issueToken(u), user: publicUser(u), restored };
  }
  const findLogin = login => {
    const v = str(login, 120).toLowerCase(), ph = normPhone(login);
    return db.get('SELECT * FROM users WHERE handle=? OR email=? OR phone=?', v.replace(/^@/, ''), v, ph);
  };

  // ---- mobile number: one-time code (SMS through a DLT-registered provider in production)
  r.post('/auth/otp/request', (req, res) => {
    const phone = normPhone(req.body.phone);
    if (!PHONE_RE.test(phone)) fail(400, 'Enter a 10-digit Indian mobile number.');
    const last = db.get('SELECT sent_at FROM otps WHERE phone=?', phone);
    if (last && Date.now() - Date.parse(last.sent_at) < 30000) fail(429, 'Wait 30 seconds before asking for a new code.');
    const code = String(crypto.randomInt(0, 1e6)).padStart(6, '0');
    db.run('INSERT INTO otps(phone,code_hash,expires_at,attempts,sent_at) VALUES(?,?,?,0,?) ON CONFLICT(phone) DO UPDATE SET code_hash=excluded.code_hash, expires_at=excluded.expires_at, attempts=0, sent_at=excluded.sent_at',
      phone, otpHash(phone, code), new Date(Date.now() + 10 * 60000).toISOString(), nowIso());
    if (!devOtp) { /* send `code` with your SMS provider here */ }
    res.json({ sent: true, phone, ...(devOtp ? { devCode: code } : {}) });
  });
  r.post('/auth/otp/verify', (req, res) => {
    const phone = normPhone(req.body.phone), code = str(req.body.code, 6);
    const o = db.get('SELECT * FROM otps WHERE phone=?', phone);
    if (!o || o.code_hash === 'used' || Date.parse(o.expires_at) < Date.now()) fail(400, 'That code has expired. Ask for a new one.', 'otp_expired');
    if (o.attempts >= 5) fail(429, 'Too many wrong codes. Ask for a new one.', 'otp_locked');
    if (o.code_hash !== otpHash(phone, code)) { db.run('UPDATE otps SET attempts=attempts+1 WHERE phone=?', phone); fail(400, "That code isn't right.", 'otp_wrong'); }
    db.run("UPDATE otps SET code_hash='used', expires_at=? WHERE phone=?", nowIso(), phone); // keep sent_at so the resend limit still applies
    const phoneTicket = signTicket({ kind: 'phone', phone });
    const u = db.get('SELECT * FROM users WHERE phone=?', phone);
    if (req.body.purpose === 'login' && u) return res.json(finishLogin(u));
    res.json({ phoneTicket, existing: !!u });
  });

  // ---- Google / Apple
  r.post('/auth/oauth/:provider', async (req, res) => {
    const provider = req.params.provider;
    const id = await verifyIdToken(provider, req.body.idToken);
    let u = db.get('SELECT u.* FROM identities i JOIN users u ON u.id=i.user_id WHERE i.provider=? AND i.sub=?', provider, id.sub);
    if (!u && id.email && id.emailVerified) {
      u = db.get('SELECT * FROM users WHERE email=?', id.email.toLowerCase());
      if (u) db.run('INSERT OR IGNORE INTO identities(provider,sub,user_id,email) VALUES(?,?,?,?)', provider, id.sub, u.id, id.email);
    }
    if (u) return res.json(finishLogin(u));
    res.json({ needsSignup: true, oauthTicket: signTicket({ kind: 'oauth', provider, sub: id.sub, email: id.emailVerified ? id.email : null }, 1800), email: id.emailVerified ? id.email : null, name: id.name });
  });

  // ---- sign-up: username + verified mobile, plus a password or a Google/Apple identity
  r.post('/auth/signup', (req, res) => {
    needFeature(db, 'signups');
    const { minAge, adultAge } = db.setting('limits');
    const name = str(req.body.name, 60), handle = str(req.body.handle, 30).toLowerCase().replace(/^@/, ''), dob = str(req.body.dob, 10);
    const pt = readTicket(req.body.phoneTicket, 'phone');
    if (!pt) fail(400, 'Verify your mobile number first.', 'phone_unverified');
    const ot = req.body.oauthTicket ? readTicket(req.body.oauthTicket, 'oauth') : null;
    if (req.body.oauthTicket && !ot) fail(400, 'Your Google or Apple sign-in expired. Try again.', 'oauth_expired');
    const email = (str(req.body.email, 120) || ot?.email || '').toLowerCase() || null;
    const password = String(req.body.password || '');
    if (!name) fail(400, 'Enter your name.');
    if (!/^[a-z0-9._]{3,30}$/.test(handle)) fail(400, 'Usernames use 3–30 letters, numbers, dots or underscores.');
    if (email && !/^\S+@\S+\.\S+$/.test(email)) fail(400, 'Enter a valid email or leave it blank.');
    if (!ot && password.length < 8) fail(400, 'Use a password of at least 8 characters.');
    const age = ageOf(dob);
    if (age < 0) fail(400, 'Enter your date of birth as YYYY-MM-DD.');
    if (age < minAge) fail(403, `You need to be ${minAge} or older to join Swaapo.`, 'too_young');
    const guardian = str(req.body.guardianContact, 120);
    if (age < adultAge && !guardian) fail(400, 'Members under 18 need a parent or guardian contact for consent.', 'guardian_required');
    if (db.get('SELECT 1 FROM users WHERE handle=?', handle)) fail(409, 'That username is taken.', 'handle_taken');
    if (db.get('SELECT 1 FROM users WHERE phone=?', pt.phone)) fail(409, 'That mobile number already has an account. Log in instead.', 'phone_taken');
    if (email && db.get('SELECT 1 FROM users WHERE email=?', email)) fail(409, 'That email already has an account. Log in instead.', 'email_taken');
    const id = db.tx(() => {
      const { lastInsertRowid } = db.run('INSERT INTO users(handle,name,email,phone,pass_hash,dob,gender,area,guardian_contact) VALUES(?,?,?,?,?,?,?,?,?)',
        handle, name, email, pt.phone, password ? hashPassword(password) : '', dob, str(req.body.gender, 20) || null, str(req.body.area, 60), age < adultAge ? guardian : null);
      if (ot) db.run('INSERT INTO identities(provider,sub,user_id,email) VALUES(?,?,?,?)', ot.provider, ot.sub, lastInsertRowid, ot.email);
      // Google/Apple already confirmed this email address.
      db.run('UPDATE users SET trust=0, email_verified=? WHERE id=?', ot && ot.email && ot.email === email ? 1 : 0, lastInsertRowid);
      return Number(lastInsertRowid);
    });
    refreshTrust(db, id);
    db.audit(id, 'user.signup', `user:${id}`, { teen: age < adultAge, via: ot ? ot.provider : 'password' });
    const u = db.get('SELECT * FROM users WHERE id=?', id);
    res.status(201).json({ token: issueToken(u), user: { id, handle, name, teen: age < adultAge, guardianConsentNeeded: age < adultAge } });
  });
  r.get('/auth/handle/:handle', (req, res) => {
    const h = str(req.params.handle, 30).toLowerCase();
    res.json({ available: /^[a-z0-9._]{3,30}$/.test(h) && !db.get('SELECT 1 FROM users WHERE handle=?', h) });
  });

  r.post('/auth/login', (req, res) => {
    const u = findLogin(req.body.login);
    if (!u || u.status === 'deleted' || !checkPassword(String(req.body.password || ''), u.pass_hash)) fail(401, 'Wrong username, mobile, email or password.');
    res.json(finishLogin(u));
  });

  // ---- deactivate / delete (DPDP Act 2023: right to erasure, with a grace period to change your mind)
  function confirmIdentity(u, body) {
    if (u.pass_hash) { if (!checkPassword(String(body.password || ''), u.pass_hash)) fail(401, 'Enter your password to confirm.', 'password_required'); }
    else if (body.confirm !== true && body.confirm !== 'DELETE') fail(400, 'Please confirm.');
  }
  function openObligations(u) {
    const n = (sql, ...p) => db.get(sql, ...p).n;
    const out = [];
    if (n("SELECT COUNT(*) n FROM auctions WHERE seller_id=? AND status IN ('pending','live')", u.id)) out.push('auctions you are selling');
    if (n("SELECT COUNT(*) n FROM auctions WHERE (seller_id=? OR winner_id=?) AND status='sold' AND escrow IN ('awaiting_payment','paid','disputed')", u.id, u.id)) out.push('auction payments in SwaapoSafe escrow');
    if (n("SELECT COUNT(*) n FROM offers WHERE (from_id=? OR to_id=?) AND status='accepted'", u.id, u.id)) out.push('swaps you have agreed but not completed');
    return out;
  }
  r.get('/me/account-status', (req, res) => { const u = requireUser(req); res.json({ status: u.status, blockers: openObligations(u), hasPassword: !!u.pass_hash,
    methods: { password: !!u.pass_hash, phone: !!u.phone, google: !!db.get("SELECT 1 FROM identities WHERE user_id=? AND provider='google'", u.id), apple: !!db.get("SELECT 1 FROM identities WHERE user_id=? AND provider='apple'", u.id) } }); });
  r.post('/me/deactivate', (req, res) => {
    const u = requireUser(req);
    confirmIdentity(u, req.body);
    const b = openObligations(u);
    if (b.length) fail(409, `Finish these first: ${b.join(', ')}.`, 'open_obligations');
    db.run("UPDATE users SET status='deactivated', deactivated_at=? WHERE id=?", nowIso(), u.id);
    db.audit(u.id, 'user.deactivate', `user:${u.id}`, { reason: str(req.body.reason, 200) || null });
    res.json({ status: 'deactivated', note: 'Your profile and listings are hidden. Log in any time to reactivate.' });
  });
  r.post('/me/delete', (req, res) => {
    const u = requireUser(req);
    if (req.body.confirm !== 'DELETE') fail(400, 'Type DELETE to confirm.', 'confirm_required');
    confirmIdentity(u, req.body);
    const b = openObligations(u);
    if (b.length) fail(409, `Finish these first: ${b.join(', ')}.`, 'open_obligations');
    const days = db.setting('limits').deleteGraceDays;
    const after = new Date(Date.now() + days * 86400000).toISOString();
    db.run("UPDATE users SET status='pending_deletion', delete_after=? WHERE id=?", after, u.id);
    db.audit(u.id, 'user.delete_requested', `user:${u.id}`, { delete_after: after });
    res.json({ status: 'pending_deletion', delete_after: after, note: `Your account will be deleted on ${after.slice(0, 10)}. Log in before then to cancel.` });
  });

  r.get('/me', (req, res) => res.json(selfUser(requireUser(req))));
  r.patch('/me', (req, res) => {
    const u = requireUser(req);
    db.run('UPDATE users SET name=COALESCE(?,name), area=COALESCE(?,area), bio=COALESCE(?,bio) WHERE id=?',
      str(req.body.name, 60) || null, req.body.area != null ? str(req.body.area, 60) : null, req.body.bio != null ? str(req.body.bio, 300) : null, u.id);
    res.json({ ok: true });
  });
  r.get('/users/:handle', (req, res) => {
    const u = db.get("SELECT * FROM users WHERE handle=? AND banned=0 AND status='active'", req.params.handle);
    if (!u) fail(404, 'No member with that handle.');
    const stats = db.get('SELECT COUNT(*) n, ROUND(AVG(stars),1) avg FROM ratings WHERE ratee_id=?', u.id);
    res.json({ ...publicUser(u), swaps: stats.n, rating: stats.avg });
  });

  // Plans. Payment is mocked: wire a licensed payment gateway's webhook to set tier_until in production.
  r.get('/plans', (_req, res) => res.json({ prices: db.setting('plans'), fees: db.setting('fees') }));
  r.post('/me/plan', (req, res) => {
    const u = requireUser(req), tier = req.body.tier;
    if (!(tier in TIER_RANK)) fail(400, 'Pick free, pro or plus.');
    if (tier !== 'free') needAdult(u, 'Paid plans are for members 18 and over.');
    const until = tier === 'free' ? null : new Date(Date.now() + 30 * 86400000).toISOString();
    db.run('UPDATE users SET tier=?, tier_until=? WHERE id=?', tier, until, u.id);
    db.audit(u.id, 'plan.change', `user:${u.id}`, { tier, price: tier === 'free' ? 0 : db.setting('plans')[tier] });
    res.json({ tier, tier_until: until });
  });

  r.get('/coins', (req, res) => {
    const u = requireUser(req), c = db.setting('coins');
    res.json({ balance: u.coins, unlocked: u.coins >= c.unlockAt, unlockAt: c.unlockAt, perFiveStar: c.perFiveStar,
      circleBonus: c.circleBonus, ledger: db.all('SELECT delta,reason,ref,created_at FROM coin_ledger WHERE user_id=? ORDER BY id DESC LIMIT 100', u.id),
      note: 'Swaapo Coins are rewards inside Swaapo. They have no cash value and can\'t be bought or sold.' });
  });

  // Women's Circle: the member confirms, then staff verify a selfie against ID and approve.
  // Store only the outcome; delete the ID image after checking.
  r.post('/circle/apply', (req, res) => {
    needFeature(db, 'circle');
    const u = requireUser(req);
    if (req.body.confirm !== true) fail(400, 'Please confirm you are a woman or girl and the details are your own.');
    if (u.circle_status === 'member') fail(409, "You're already in Women's Circle.");
    db.run("UPDATE users SET circle_status='pending' WHERE id=?", u.id);
    db.audit(u.id, 'circle.apply', `user:${u.id}`);
    res.json({ circle_status: 'pending' });
  });
  r.patch('/circle/badge', (req, res) => { requireUser(req); res.json({ ok: true, note: 'Badge visibility is a client preference.' }); });

  return r;
}

// Runs on a timer: accounts whose deletion grace period has ended are anonymised. Records the law requires us to keep
// (auction sales, escrow and tax records) stay, but no longer point to a person.
export function purgeDeleted(db) {
  const due = db.all("SELECT id FROM users WHERE status='pending_deletion' AND delete_after<=?", new Date().toISOString());
  for (const { id } of due) db.tx(() => {
    db.run(`UPDATE users SET name='Deleted member', handle=?, email=NULL, phone=NULL, pass_hash='', dob='1900-01-01', gender=NULL, area='', bio='',
      guardian_contact=NULL, email_verified=0, id_verified=0, id_method=NULL, id_last4=NULL, id_ref_hash=NULL, avatar_url=NULL, circle_status='none', kyc_status='none', coins=0, tier='free', tier_until=NULL, status='deleted', delete_after=NULL WHERE id=?`, `deleted-${id}`, id);
    db.run('DELETE FROM identities WHERE user_id=?', id);
    db.run("UPDATE posts SET status='removed' WHERE user_id=?", id);
    db.run("UPDATE promos SET status='removed' WHERE user_id=?", id);
    db.run("UPDATE campaigns SET status='ended' WHERE owner_id=? AND status IN ('pending','active','paused')", id);
    db.run("UPDATE messages SET body='Message deleted' WHERE from_id=?", id);
    db.run('DELETE FROM group_members WHERE user_id=?', id);
    db.run('DELETE FROM event_rsvps WHERE user_id=?', id);
    db.audit(null, 'user.deleted', `user:${id}`);
  });
  return due.length;
}
