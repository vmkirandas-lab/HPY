// Verifications, trust score and the profile-completion bonus.
// ID checks: Aadhaar is optional (Aadhaar Act 2016 and the 2018 Puttaswamy judgment), so a passport, driving licence or
// voter ID earns the same trust. Swaapo never stores a full ID number: only the method, the last 4 digits and a keyed hash of
// the provider's reference, used to stop one person verifying several accounts.
import { Router } from 'express';
import crypto from 'node:crypto';
import { requireUser } from '../auth.js';
import { fail } from '../errors.js';
import { str, nowIso } from '../rules.js';

export const ID_METHODS = { aadhaar_digilocker: 'Aadhaar via DigiLocker', aadhaar_offline: 'Aadhaar offline e-KYC', passport: 'Passport', driving_licence: 'Driving licence', voter_id: 'Voter ID' };
const REF_KEY = process.env.ID_HASH_KEY || process.env.TOKEN_SECRET || 'dev-only-key';
const refHash = (method, ref) => crypto.createHmac('sha256', REF_KEY).update(`${method.startsWith('aadhaar') ? 'aadhaar' : method}:${ref}`).digest('hex');

export function verificationTrust(db, u) {
  const t = db.setting('trust');
  return (u.phone ? t.phone : 0) + (u.email_verified ? t.email : 0) + (u.id_verified ? t.id : 0);
}
// Trust never drops because of this: it is raised to at least the verification score.
export function refreshTrust(db, userId) {
  const u = db.get('SELECT * FROM users WHERE id=?', userId);
  const v = verificationTrust(db, u);
  if (u.trust < v) db.run('UPDATE users SET trust=? WHERE id=?', v, userId);
}
export function checklist(u) {
  return [
    ['name', 'Your name', !!u.name], ['handle', 'Username', !!u.handle], ['phone', 'Mobile number verified', !!u.phone],
    ['email', 'Email verified', !!u.email_verified], ['id', 'ID verified (Aadhaar or another ID)', !!u.id_verified],
    ['dob', 'Date of birth', !!u.dob && u.dob !== '1900-01-01'], ['area', 'City or area', !!(u.area || '').trim()],
    ['bio', 'A short bio', !!(u.bio || '').trim()], ['photo', 'Profile photo', !!u.avatar_url],
  ].map(([key, label, done]) => ({ key, label, done }));
}
// One-time bonus once every item is done.
export function maybeWelcomeBonus(db, userId) {
  const u = db.get('SELECT * FROM users WHERE id=?', userId);
  if (u.welcome_bonus || !checklist(u).every(i => i.done)) return 0;
  const amount = db.setting('coins').welcomeBonus;
  db.tx(() => {
    db.run('UPDATE users SET welcome_bonus=1 WHERE id=?', userId);
    db.coin(userId, amount, 'Welcome bonus: profile complete', 'welcome');
  });
  db.audit(userId, 'coins.welcome_bonus', `user:${userId}`, { amount });
  return amount;
}

export default function profile(db) {
  const r = Router();
  const otpHash = (key, code) => crypto.createHash('sha256').update(`${key}:${code}`).digest('hex');
  const devCodes = process.env.NODE_ENV !== 'production';

  r.get('/me/profile', (req, res) => {
    const u = requireUser(req), items = checklist(u);
    res.json({ trust: u.trust, trustFromVerifications: verificationTrust(db, u), trustRules: db.setting('trust'),
      checklist: items, complete: items.filter(i => i.done).length, total: items.length,
      welcomeBonus: { amount: db.setting('coins').welcomeBonus, claimed: !!u.welcome_bonus },
      id: u.id_verified ? { method: ID_METHODS[u.id_method] || u.id_method, last4: u.id_last4 } : null });
  });

  r.patch('/me/profile', (req, res) => {
    const u = requireUser(req), b = req.body;
    const avatar = b.avatarUrl != null ? str(b.avatarUrl, 500) : null;
    if (avatar && !/^https:\/\//.test(avatar)) fail(400, 'Upload the photo first, then send its https link.');
    db.run('UPDATE users SET name=COALESCE(?,name), area=COALESCE(?,area), bio=COALESCE(?,bio), avatar_url=COALESCE(?,avatar_url) WHERE id=?',
      str(b.name, 60) || null, b.area != null ? str(b.area, 60) : null, b.bio != null ? str(b.bio, 300) : null, avatar, u.id);
    res.json({ ok: true, coinsAwarded: maybeWelcomeBonus(db, u.id) });
  });

  // Email: a 6-digit code to the address (send with your email provider in production).
  r.post('/me/email/request', (req, res) => {
    const u = requireUser(req), email = str(req.body.email, 120).toLowerCase();
    if (!/^\S+@\S+\.\S+$/.test(email)) fail(400, 'Enter a valid email.');
    if (db.get('SELECT 1 FROM users WHERE email=? AND id<>?', email, u.id)) fail(409, 'That email already has an account.', 'email_taken');
    const key = `email:${u.id}:${email}`, code = String(crypto.randomInt(0, 1e6)).padStart(6, '0');
    db.run("DELETE FROM otps WHERE phone LIKE ?", `email:${u.id}:%`);
    db.run('INSERT INTO otps(phone,code_hash,expires_at,attempts,sent_at) VALUES(?,?,?,0,?)', key, otpHash(key, code), new Date(Date.now() + 30 * 60000).toISOString(), nowIso());
    res.json({ sent: true, ...(devCodes ? { devCode: code } : {}) });
  });
  r.post('/me/email/verify', (req, res) => {
    const u = requireUser(req), email = str(req.body.email, 120).toLowerCase(), key = `email:${u.id}:${email}`;
    const o = db.get('SELECT * FROM otps WHERE phone=?', key);
    if (!o || Date.parse(o.expires_at) < Date.now()) fail(400, 'That code has expired. Ask for a new one.', 'otp_expired');
    if (o.attempts >= 5) fail(429, 'Too many wrong codes. Ask for a new one.', 'otp_locked');
    if (o.code_hash !== otpHash(key, str(req.body.code, 6))) { db.run('UPDATE otps SET attempts=attempts+1 WHERE phone=?', key); fail(400, "That code isn't right.", 'otp_wrong'); }
    db.run('DELETE FROM otps WHERE phone=?', key);
    db.run('UPDATE users SET email=?, email_verified=1 WHERE id=?', email, u.id);
    refreshTrust(db, u.id);
    res.json({ email, email_verified: true, coinsAwarded: maybeWelcomeBonus(db, u.id) });
  });

  // ID: the result of a DigiLocker / UIDAI offline e-KYC / document check by your KYC provider.
  // Outside production the server accepts the result from the client so the flow can be tested end to end.
  r.post('/me/id/verify', (req, res) => {
    const u = requireUser(req), b = req.body;
    if (process.env.NODE_ENV === 'production' && !process.env.KYC_PROVIDER) fail(503, "ID verification isn't set up on this server yet.", 'kyc_unconfigured');
    if (u.id_verified) fail(409, 'Your ID is already verified.');
    if (!(b.method in ID_METHODS)) fail(400, 'Pick Aadhaar, passport, driving licence or voter ID.');
    if (b.consent !== true) fail(400, 'We need your consent to verify your ID.', 'consent_required');
    const ref = str(b.reference, 64), last4 = str(b.last4, 4);
    if (!ref || !/^[0-9A-Z]{4}$/i.test(last4)) fail(400, 'The ID check did not return a reference.');
    if (/^\d{12}$/.test(str(b.idNumber, 20))) fail(400, "Don't send a full Aadhaar number. Verify through DigiLocker or offline e-KYC.", 'no_full_aadhaar');
    const norm = s => String(s || '').toLowerCase().replace(/[^a-z]/g, '');
    if (norm(b.nameOnId) !== norm(u.name) || str(b.dobOnId, 10) !== u.dob) fail(409, "The name or date of birth on your ID doesn't match your account. Update your profile, then try again.", 'id_mismatch');
    const h = refHash(b.method, ref);
    if (db.get('SELECT 1 FROM users WHERE id_ref_hash=? AND id<>?', h, u.id)) fail(409, 'This ID is already verified on another Swaapo account.', 'id_used');
    db.run('UPDATE users SET id_verified=1, id_method=?, id_last4=?, id_ref_hash=?, verified=1 WHERE id=?', b.method, last4.toUpperCase(), h, u.id);
    db.audit(u.id, 'user.id_verified', `user:${u.id}`, { method: b.method });
    refreshTrust(db, u.id);
    res.json({ id_verified: true, method: ID_METHODS[b.method], last4: last4.toUpperCase(), coinsAwarded: maybeWelcomeBonus(db, u.id) });
  });
  return r;
}
