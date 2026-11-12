// End-to-end tests: real HTTP against an in-memory database.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { hashPassword } from '../src/auth.js';
import { setOAuthVerifier } from '../src/oauth.js';
import { purgeDeleted } from '../src/routes/account.js';

let server, base, db;
const call = async (method, path, body, token) => {
  const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
};
const dobFor = age => `${new Date().getUTCFullYear() - age - 1}-01-01`;
const T = {};
let phoneN = 9000000000;
async function phoneTicket(phone = String(++phoneN)) {
  const o = (await call('POST', '/api/auth/otp/request', { phone })).body;
  return (await call('POST', '/api/auth/otp/verify', { phone, code: o.devCode })).body.phoneTicket;
}
async function signup(handle, age, extra = {}) {
  const r = await call('POST', '/api/auth/signup', { name: handle, handle, email: `${handle}@t.in`, password: 'password123', dob: dobFor(age), phoneTicket: await phoneTicket(), ...extra });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  T[handle] = r.body.token;
  return r.body.user.id;
}
const id = {};

before(async () => {
  process.env.AUTH_RATE_MAX = '1000';
  ({ app: server, db } = createApp({ dbPath: ':memory:' }));
  server = server.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
  db.run("INSERT INTO users(handle,name,email,pass_hash,dob,role) VALUES('boss','Boss','boss@t.in',?,'1990-01-01','admin')", hashPassword('adminpass123'));
  db.run("INSERT INTO users(handle,name,email,pass_hash,dob,role) VALUES('mod','Mod','mod@t.in',?,'1990-01-01','moderator')", hashPassword('modpass1234'));
  T.boss = (await call('POST', '/api/auth/login', { login: 'boss', password: 'adminpass123' })).body.token;
  T.mod = (await call('POST', '/api/auth/login', { login: 'mod', password: 'modpass1234' })).body.token;
  id.seller = await signup('seller', 30); id.buyer = await signup('buyer', 25); id.rival = await signup('rival', 40);
  id.teen = await signup('teen', 16, { guardianContact: 'parent@t.in' });
  id.woman1 = await signup('woman1', 22); id.woman2 = await signup('woman2', 24);
});
after(() => server.close());

test('sign-up enforces the age rules', async () => {
  assert.equal((await call('POST', '/api/auth/signup', { name: 'Kid', handle: 'kid', email: 'kid@t.in', password: 'password123', dob: dobFor(13), phoneTicket: await phoneTicket() })).status, 403);
  const noGuardian = await call('POST', '/api/auth/signup', { name: 'T2', handle: 'teen2', email: 't2@t.in', password: 'password123', dob: dobFor(16), phoneTicket: await phoneTicket() });
  assert.equal(noGuardian.body.code, 'guardian_required');
  assert.equal((await call('GET', '/api/me', null, T.teen)).body.adult, false);
});

test('teens need guardian consent to post, and can never take paid plans', async () => {
  assert.equal((await call('POST', '/api/posts', { type: 'item', title: 'Cricket bat' }, T.teen)).body.code, 'guardian_consent');
  assert.equal((await call('PATCH', `/api/admin/users/${id.teen}`, { guardian_consent: true }, T.mod)).status, 200);
  assert.equal((await call('POST', '/api/posts', { type: 'item', title: 'Cricket bat', cat: 'Sports' }, T.teen)).status, 201);
  assert.equal((await call('POST', '/api/me/plan', { tier: 'pro' }, T.teen)).body.code, 'adult_only');
  assert.equal((await call('PATCH', `/api/admin/users/${id.teen}`, { tier: 'plus' }, T.boss)).status, 400);
});

test('auctions: Pro gate, staff verification, bidding rules, anti-snipe and closing', async () => {
  const body = { item: 'Fujifilm X-T30', cat: 'Electronics', fmt: 'english', start: 30000, inc: 500, durationMin: 60, verify: { bill: true, own: true, serial: 'X1' } };
  assert.equal((await call('POST', '/api/auctions', body, T.seller)).body.code, 'upgrade');
  for (const h of ['seller', 'buyer', 'rival']) await call('POST', '/api/me/plan', { tier: h === 'seller' ? 'pro' : 'plus' }, T[h]);
  assert.equal((await call('POST', '/api/auctions', { ...body, fmt: 'sealed' }, T.seller)).body.code, 'upgrade'); // Pro Plus format
  const a = (await call('POST', '/api/auctions', body, T.seller)).body;
  assert.equal(a.status, 'pending');
  assert.equal((await call('POST', `/api/auctions/${a.id}/bids`, { amount: 30000 }, T.buyer)).status, 409); // not live yet
  assert.equal((await call('POST', `/api/admin/auctions/${a.id}/verify`, { approve: true }, T.mod)).body.status, 'live');
  assert.equal((await call('POST', `/api/auctions/${a.id}/bids`, { amount: 30000 }, T.teen)).body.code, 'bid_age');
  assert.equal((await call('POST', `/api/auctions/${a.id}/bids`, { amount: 30000 }, T.seller)).status, 403);
  assert.equal((await call('POST', `/api/auctions/${a.id}/bids`, { amount: 30000, maxAuto: 33000 }, T.buyer)).status, 201);
  assert.equal((await call('POST', `/api/auctions/${a.id}/bids`, { amount: 30200 }, T.rival)).body.code, 'bid_too_low');
  const r = (await call('POST', `/api/auctions/${a.id}/bids`, { amount: 30500 }, T.rival)).body;
  assert.equal(r.youAreTop, false); // buyer's auto-bid answered at 31,000
  assert.equal((await call('GET', `/api/auctions/${a.id}`, null, T.boss)).body.price, 31000);
  db.run("UPDATE auctions SET ends_at=? WHERE id=?", new Date(Date.now() + 30000).toISOString(), a.id);
  const late = (await call('POST', `/api/auctions/${a.id}/bids`, { amount: 31500 }, T.rival)).body;
  assert.equal(late.extended, true); assert.equal(late.top, 32000); // buyer's auto-bid answers again
  db.run("UPDATE auctions SET ends_at=? WHERE id=?", new Date(Date.now() - 1000).toISOString(), a.id);
  const done = (await call('GET', `/api/auctions/${a.id}`, null, T.boss)).body;
  assert.equal(done.status, 'sold'); assert.equal(done.winner_id, id.buyer); assert.equal(done.final_price, 32000); assert.equal(done.fee_pct, 5);
});

test('reserve and sealed bids stay hidden from buyers', async () => {
  await call('POST', '/api/me/plan', { tier: 'plus' }, T.seller);
  const a = (await call('POST', '/api/auctions', { item: 'Bike', fmt: 'reserve', start: 5000, reserve: 8000, verify: { bill: true, own: true } }, T.seller)).body;
  await call('POST', `/api/admin/auctions/${a.id}/verify`, { approve: true }, T.mod);
  const view = (await call('GET', `/api/auctions/${a.id}`, null, T.boss)).body;
  assert.equal(view.reserve, undefined); assert.equal(view.reserveMet, false);
  const s = (await call('POST', '/api/auctions', { item: 'Lens', fmt: 'sealed', start: 1000, verify: { bill: true, own: true } }, T.seller)).body;
  await call('POST', `/api/admin/auctions/${s.id}/verify`, { approve: true }, T.mod);
  await call('POST', `/api/auctions/${s.id}/bids`, { amount: 2500 }, T.buyer);
  assert.deepEqual((await call('GET', `/api/auctions/${s.id}`, null, T.boss)).body.bids, []);
});

test('5-star swaps earn coins, Circle members get the bonus, coins unlock at 1,000', async () => {
  const swap = async (from, to) => {
    const o = (await call('POST', '/api/offers', { toUserId: id[to], give: 'Books', get: 'Lamp' }, T[from])).body;
    await call('POST', `/api/offers/${o.id}/accept`, {}, T[to]);
    await call('POST', `/api/offers/${o.id}/complete`, {}, T[from]);
    return o.id;
  };
  let o = await swap('buyer', 'seller');
  assert.equal((await call('POST', `/api/offers/${o}/rate`, { stars: 5 }, T.buyer)).body.coinsAwarded, 100);
  assert.equal((await call('POST', `/api/offers/${o}/rate`, { stars: 5 }, T.buyer)).status, 409);
  for (const w of ['woman1', 'woman2']) { await call('POST', '/api/circle/apply', { confirm: true }, T[w]); await call('PATCH', `/api/admin/users/${id[w]}`, { circle_status: 'member' }, T.mod); }
  o = await swap('woman1', 'woman2');
  assert.equal((await call('POST', `/api/offers/${o}/rate`, { stars: 5 }, T.woman1)).body.coinsAwarded, 150);
  assert.equal((await call('POST', '/api/offers', { toUserId: id.seller, coins: 50, get: 'Lamp' }, T.woman2)).body.code, 'coins_locked');
  await call('POST', `/api/admin/users/${id.woman2}/coins`, { delta: 900, reason: 'test' }, T.boss);
  const ok = (await call('POST', '/api/offers', { toUserId: id.seller, coins: 300, get: 'Lamp' }, T.woman2)).body;
  await call('POST', `/api/offers/${ok.id}/accept`, {}, T.seller); await call('POST', `/api/offers/${ok.id}/complete`, {}, T.seller);
  assert.equal((await call('GET', '/api/coins', null, T.woman2)).body.balance, 750);
  assert.equal((await call('POST', `/api/admin/users/${id.woman2}/coins`, { delta: 5, reason: 'x' }, T.mod)).status, 403);
});

test('studio: Pro Plus only, free entry only, 2-minute videos, audited random draw', async () => {
  assert.equal((await call('POST', '/api/promos', { kind: 'draw', title: 'Earbuds', details: { how: ['follow'] } }, T.woman1)).body.code, 'upgrade');
  assert.equal((await call('POST', '/api/promos', { kind: 'draw', title: 'Earbuds', details: { how: ['follow'], entryFee: 10 } }, T.buyer)).body.code, 'paid_entry');
  assert.equal((await call('POST', '/api/promos', { kind: 'video', title: 'Walkaround', details: { url: 'u', durationSec: 130 } }, T.buyer)).body.code, 'video_too_long');
  assert.equal((await call('POST', '/api/promos', { kind: 'video', title: 'Walkaround', details: { url: 'u', durationSec: 118 } }, T.buyer)).status, 201);
  const p = (await call('POST', '/api/promos', { kind: 'draw', title: 'Earbuds', details: { how: ['follow'], winners: 1 } }, T.buyer)).body;
  assert.equal((await call('POST', `/api/promos/${p.id}/enter`, {}, T.teen)).body.code, 'adult_only');
  assert.equal((await call('POST', `/api/promos/${p.id}/enter`, {}, T.seller)).status, 201);
  assert.equal((await call('POST', `/api/promos/${p.id}/enter`, {}, T.seller)).status, 409);
  await call('POST', `/api/promos/${p.id}/enter`, {}, T.rival);
  const w = (await call('POST', `/api/admin/promos/${p.id}/draw`, {}, T.mod)).body.winners;
  assert.equal(w.length, 1); assert.ok([id.seller, id.rival].includes(w[0].id));
  assert.ok(db.get("SELECT 1 FROM audit_log WHERE action='promo.draw'"));
});

test('calls: Pro Plus adults only, never with a teen', async () => {
  assert.equal((await call('POST', '/api/calls', { to: id.buyer, kind: 'video' }, T.woman1)).body.code, 'upgrade');
  assert.equal((await call('POST', '/api/calls', { to: id.teen }, T.buyer)).body.code, 'callee_teen');
  const c = (await call('POST', '/api/calls', { to: id.rival, kind: 'video' }, T.buyer)).body;
  assert.equal(c.status, 'ringing');
  assert.equal((await call('POST', `/api/calls/${c.id}/end`, {}, T.rival)).status, 200);
});

test('ads are reviewed before running and never served to teens', async () => {
  const c = (await call('POST', '/api/campaigns', { business: 'Cycle Clinic', headline: 'Free check-up', placement: 'feed', budget: 1000 }, T.seller)).body;
  assert.equal((await call('GET', '/api/ads/next?placement=feed')).body.ad, null);
  await call('PATCH', `/api/admin/campaigns/${c.id}`, { status: 'active' }, T.mod);
  assert.equal((await call('GET', '/api/ads/next?placement=feed', null, T.buyer)).body.ad.label, 'Sponsored');
  assert.equal((await call('GET', '/api/ads/next?placement=feed', null, T.teen)).body.ad, null);
});

test('reports, moderation and suspension', async () => {
  const post = (await call('POST', '/api/posts', { type: 'item', title: 'Phone, pay advance on UPI' }, T.rival)).body;
  const m = (await call('POST', '/api/messages', { to: id.buyer, body: 'send me the OTP' }, T.rival)).body;
  assert.ok(m.warning);
  const rep = (await call('POST', '/api/reports', { targetType: 'post', targetId: post.id, reason: 'Scam' }, T.buyer)).body;
  assert.equal((await call('POST', `/api/admin/reports/${rep.id}/resolve`, { action: 'ban', note: 'Advance-payment scam' }, T.mod)).status, 200);
  assert.equal((await call('GET', '/api/me', null, T.rival)).status, 401);
  assert.equal((await call('POST', '/api/auth/login', { login: 'rival', password: 'password123' })).body.code, 'banned');
  assert.equal((await call('GET', '/api/admin/stats', null, T.buyer)).status, 403);
});

test('settings: admin-only, validated, and feature switches take effect', async () => {
  assert.equal((await call('PUT', '/api/admin/settings/features', { value: {} }, T.mod)).status, 403);
  assert.equal((await call('PUT', '/api/admin/settings/plans', { value: { pro: 'free' } }, T.boss)).status, 400);
  const f = (await call('GET', '/api/admin/settings', null, T.boss)).body.features;
  assert.equal((await call('PUT', '/api/admin/settings/features', { value: { ...f, calls: false } }, T.boss)).status, 200);
  assert.equal((await call('POST', '/api/calls', { to: id.seller }, T.buyer)).body.code, 'feature_off');
  await call('PUT', '/api/admin/settings/maintenance', { value: { on: true, message: 'Back soon' } }, T.boss);
  assert.equal((await call('POST', '/api/posts', { type: 'item', title: 'x' }, T.buyer)).body.code, 'maintenance');
  await call('PUT', '/api/admin/settings/maintenance', { value: { on: false, message: 'Back soon' } }, T.boss);
  assert.ok(db.all("SELECT 1 FROM audit_log WHERE action='settings.update'").length >= 3);
});

test('Swaapo Green: each completed swap pledges a tree, milestones pledge meals, delivery needs proof', async () => {
  await call('PUT', '/api/admin/settings/impact', { value: { treesPerSwap: 1, milestoneSwaps: 5, mealsPerMilestone: 500, cleanupsPerMilestone: 1, co2KgPerSwap: 12, wasteKgPerSwap: 2.5 } }, T.boss);
  const before = (await call('GET', '/api/impact')).body;
  let last;
  for (let i = before.swaps; i < 5; i++) {
    const o = (await call('POST', '/api/offers', { toUserId: id.seller, give: 'Book ' + i, get: 'Pen' }, T.buyer)).body;
    await call('POST', `/api/offers/${o.id}/accept`, {}, T.seller);
    last = (await call('POST', `/api/offers/${o.id}/complete`, {}, T.buyer)).body;
    assert.equal(last.treesPledged, 1);
  }
  assert.deepEqual(last.milestone, { swaps: 5, meals: 500, cleanups: 1 });
  const s = (await call('GET', '/api/impact')).body;
  assert.equal(s.trees.pledged, 5); assert.equal(s.meals.pledged, 500); assert.equal(s.estimates.co2Kg, 60);
  assert.equal((await call('GET', '/api/me/impact', null, T.buyer)).body.trees >= 1, true);
  const batch = { kind: 'planting', qty: 3, partner: 'Green Kerala Trust', location: 'Attappadi', happenedOn: '2026-08-01' };
  assert.equal((await call('POST', '/api/admin/impact/batches', batch, T.boss)).status, 400); // no proof link
  assert.equal((await call('POST', '/api/admin/impact/batches', { ...batch, proofUrl: 'https://example.org/report' }, T.mod)).status, 403);
  assert.equal((await call('POST', '/api/admin/impact/batches', { ...batch, proofUrl: 'https://example.org/report' }, T.boss)).status, 201);
  const a = (await call('GET', '/api/admin/impact', null, T.mod)).body;
  assert.equal(a.trees.planted, 3); assert.equal(a.owed.trees, 2); assert.equal(a.owed.meals, 500);
});

test('Swaapo Exclusive: verified brands list 1-of-1 pieces, only verified bidders can bid', async () => {
  const brandOwner = await signup('loomco', 45);
  const app = { name: 'Malabar Loom', legalName: 'Malabar Loom Co-op', gstin: '32AAAAM5678D1Z2', trademark: 'TM 123', genuine: true, invoices: true };
  assert.equal((await call('POST', '/api/brands', { ...app, gstin: 'BAD' }, T.loomco)).status, 400);
  const b = (await call('POST', '/api/brands', app, T.loomco)).body;
  assert.equal(b.status, 'pending');
  assert.equal((await call('POST', '/api/brands', app, T.loomco)).status, 409);
  const piece = { brandId: b.id, item: 'Kasavu heirloom saree', fmt: 'english', start: 40000, inc: 1000, verify: { bill: true, own: true } };
  assert.equal((await call('POST', '/api/auctions', piece, T.loomco)).body.code, 'brand_unverified');
  assert.equal((await call('PATCH', `/api/admin/brands/${b.id}`, { status: 'rejected' }, T.mod)).status, 400); // needs a reason
  await call('PATCH', `/api/admin/brands/${b.id}`, { status: 'verified' }, T.mod);
  assert.equal((await call('GET', `/api/brands/${b.slug}`)).status, 200);
  const a = (await call('POST', '/api/auctions', piece, T.loomco)).body; // no member plan needed for a verified brand
  assert.match(a.cert, /^SWX-MAL-0001$/);
  await call('POST', `/api/admin/auctions/${a.id}/verify`, { approve: true }, T.mod);
  const view = (await call('GET', `/api/auctions/${a.id}`, null, T.boss)).body;
  assert.equal(view.exclusive, true); assert.equal(view.edition, '1 of 1'); assert.equal(view.brand.gstin, app.gstin);
  assert.equal((await call('POST', `/api/auctions/${a.id}/bids`, { amount: 40000 }, T.buyer)).body.code, 'kyc_required');
  assert.equal((await call('POST', '/api/me/kyc', { pan: 'ABCDE1234F', confirm: true }, T.teen)).body.code, 'bid_age');
  assert.equal((await call('POST', '/api/me/kyc', { pan: 'ABCDE1234F', confirm: true }, T.buyer)).body.kyc_status, 'pending');
  assert.equal((await call('POST', `/api/auctions/${a.id}/bids`, { amount: 40000 }, T.buyer)).body.code, 'kyc_required');
  await call('PATCH', `/api/admin/users/${id.buyer}`, { kyc_status: 'verified' }, T.mod);
  assert.equal((await call('POST', `/api/auctions/${a.id}/bids`, { amount: 40000 }, T.buyer)).status, 201);
  db.run('UPDATE auctions SET ends_at=? WHERE id=?', new Date(Date.now() - 1000).toISOString(), a.id);
  assert.equal((await call('GET', `/api/auctions/${a.id}`, null, T.boss)).body.fee_pct, 8);
  await call('PATCH', `/api/admin/brands/${b.id}`, { status: 'suspended', note: 'Counterfeit report upheld' }, T.mod);
  assert.equal((await call('GET', `/api/brands/${b.slug}`)).status, 404);
});


test('auctions: 18+ can watch, bidding and selling start at 23', async () => {
  id.young = await signup('young21', 21);
  await call('POST', '/api/me/plan', { tier: 'plus' }, T.young21);
  const live = (await call('GET', '/api/auctions', null, T.young21));
  assert.equal(live.status, 200);
  assert.equal((await call('GET', '/api/auctions', null, T.teen)).body.code, 'adult_only');
  assert.equal((await call('GET', '/api/auctions')).body.code, 'login_required');
  const a = live.body[0] || (await call('GET', '/api/auctions', null, T.boss)).body[0];
  if (a) assert.equal((await call('POST', `/api/auctions/${a.id}/bids`, { amount: 9e6 }, T.young21)).body.code, 'bid_age');
  assert.equal((await call('POST', '/api/auctions', { item: 'Lamp', fmt: 'english', start: 500, verify: { bill: true, own: true } }, T.young21)).body.code, 'bid_age');
  await call('PUT', '/api/admin/settings/limits', { value: { ...(await call('GET', '/api/admin/settings', null, T.boss)).body.limits, bidAge: 21 } }, T.boss);
  assert.equal((await call('POST', '/api/auctions', { item: 'Lamp', fmt: 'english', start: 500, verify: { bill: true, own: true } }, T.young21)).status, 201);
  await call('PUT', '/api/admin/settings/limits', { value: { ...(await call('GET', '/api/admin/settings', null, T.boss)).body.limits, bidAge: 23 } }, T.boss);
});

test('login with username, mobile OTP or email; wrong codes lock out', async () => {
  const phone = '9876543210';
  const pt = await phoneTicket(phone);
  const r = await call('POST', '/api/auth/signup', { name: 'Anu', handle: 'anu.k', password: 'password123', dob: dobFor(26), phoneTicket: pt });
  assert.equal(r.status, 201);
  assert.equal((await call('POST', '/api/auth/signup', { name: 'Anu2', handle: 'anu.k2', password: 'password123', dob: dobFor(26), phoneTicket: pt })).body.code, 'phone_taken');
  assert.equal((await call('POST', '/api/auth/signup', { name: 'X', handle: 'x.y', password: 'password123', dob: dobFor(26) })).body.code, 'phone_unverified');
  assert.equal((await call('GET', '/api/auth/handle/anu.k')).body.available, false);
  assert.ok((await call('POST', '/api/auth/login', { login: '@anu.k', password: 'password123' })).body.token);
  assert.ok((await call('POST', '/api/auth/login', { login: '98765 43210', password: 'password123' })).body.token);
  assert.equal((await call('POST', '/api/auth/otp/request', { phone })).status, 429); // 30-second resend limit
  db.run('UPDATE otps SET sent_at=? WHERE phone=?', '2000-01-01T00:00:00Z', '+91' + phone);
  const o = (await call('POST', '/api/auth/otp/request', { phone })).body;
  for (let i = 0; i < 5; i++) assert.equal((await call('POST', '/api/auth/otp/verify', { phone, code: '000000' === o.devCode ? '111111' : '000000' })).body.code, 'otp_wrong');
  assert.equal((await call('POST', '/api/auth/otp/verify', { phone, code: o.devCode })).body.code, 'otp_locked');
  db.run('UPDATE otps SET sent_at=? WHERE phone=?', '2000-01-01T00:00:00Z', '+91' + phone);
  const o2 = (await call('POST', '/api/auth/otp/request', { phone })).body;
  const login = (await call('POST', '/api/auth/otp/verify', { phone, code: o2.devCode, purpose: 'login' })).body;
  assert.ok(login.token);
  assert.equal((await call('GET', '/api/me', null, login.token)).body.handle, 'anu.k');
});

test('Google and Apple: verified identity logs in, new identity finishes sign-up', async () => {
  setOAuthVerifier(async (provider, tok) => {
    if (tok === 'bad') { const e = new Error('Sign-in could not be verified.'); e.status = 401; e.code = 'oauth_invalid'; throw e; }
    return { sub: provider + ':' + tok, email: tok + '@gmail.com', emailVerified: true, name: 'Gauri' };
  });
  assert.equal((await call('POST', '/api/auth/oauth/google', { idToken: 'bad' })).body.code, 'oauth_invalid');
  const first = (await call('POST', '/api/auth/oauth/google', { idToken: 'gauri' })).body;
  assert.equal(first.needsSignup, true); assert.equal(first.email, 'gauri@gmail.com');
  const made = await call('POST', '/api/auth/signup', { name: 'Gauri', handle: 'gauri', dob: dobFor(29), phoneTicket: await phoneTicket(), oauthTicket: first.oauthTicket });
  assert.equal(made.status, 201); // no password needed with Google
  assert.ok((await call('POST', '/api/auth/oauth/google', { idToken: 'gauri' })).body.token);
  // an existing account with the same verified email is linked, not duplicated
  const apple = (await call('POST', '/api/auth/oauth/apple', { idToken: 'buyer' })).body;
  assert.equal(apple.needsSignup, true); // buyer@t.in != buyer@gmail.com
  db.run("UPDATE users SET email='buyer@gmail.com' WHERE id=?", id.buyer);
  assert.ok((await call('POST', '/api/auth/oauth/apple', { idToken: 'buyer' })).body.token);
  setOAuthVerifier(null);
  assert.equal((await call('POST', '/api/auth/oauth/google', { idToken: 'x.y.z' })).body.code, 'oauth_unconfigured');
});

test('deactivate hides the account until the next login; delete has a 30-day grace period', async () => {
  id.leaver = await signup('leaver', 30);
  await call('POST', '/api/posts', { type: 'item', title: 'Old lamp' }, T.leaver);
  assert.equal((await call('POST', '/api/me/deactivate', { password: 'nope' }, T.leaver)).body.code, 'password_required');
  assert.equal((await call('POST', '/api/me/deactivate', { password: 'password123' }, T.leaver)).body.status, 'deactivated');
  assert.equal((await call('GET', '/api/me', null, T.leaver)).status, 401);
  assert.equal((await call('GET', '/api/users/leaver')).status, 404);
  assert.ok(!(await call('GET', '/api/feed?q=Old%20lamp')).body.length);
  let back = (await call('POST', '/api/auth/login', { login: 'leaver', password: 'password123' })).body;
  assert.equal(back.restored, 'reactivated'); T.leaver = back.token;
  assert.equal((await call('POST', '/api/me/delete', { password: 'password123' }, T.leaver)).body.code, 'confirm_required');
  const del = (await call('POST', '/api/me/delete', { confirm: 'DELETE', password: 'password123' }, T.leaver)).body;
  assert.equal(del.status, 'pending_deletion');
  back = (await call('POST', '/api/auth/login', { login: 'leaver', password: 'password123' })).body;
  assert.equal(back.restored, 'deletion_cancelled'); T.leaver = back.token;
  await call('POST', '/api/me/delete', { confirm: 'DELETE', password: 'password123' }, T.leaver);
  db.run('UPDATE users SET delete_after=? WHERE id=?', '2000-01-01T00:00:00Z', id.leaver);
  assert.equal(purgeDeleted(db), 1);
  const gone = db.get('SELECT * FROM users WHERE id=?', id.leaver);
  assert.equal(gone.status, 'deleted'); assert.equal(gone.email, null); assert.equal(gone.phone, null); assert.equal(gone.name, 'Deleted member');
  assert.equal((await call('POST', '/api/auth/login', { login: 'leaver', password: 'password123' })).status, 401);
  // members with an auction still running can't leave until it's done
  const s = (await call('POST', '/api/auctions', { item: 'Watch', fmt: 'english', start: 1000, verify: { bill: true, own: true } }, T.seller)).body;
  assert.ok(s.id);
  assert.equal((await call('POST', '/api/me/delete', { confirm: 'DELETE', password: 'password123' }, T.seller)).body.code, 'open_obligations');
});

test('trust: phone 20 + email 10 + ID 20 = 50; full profile earns 1,000 coins once; Aadhaar stays optional', async () => {
  const uid = await signup('nisha', 27); const tk = T.nisha;
  db.run("UPDATE users SET name='Nisha Menon', email=NULL WHERE id=?", uid);
  let p = (await call('GET', '/api/me/profile', null, tk)).body;
  assert.equal(p.trust, 20); assert.equal(p.complete, 4); assert.equal(p.total, 9);
  const er = (await call('POST', '/api/me/email/request', { email: 'nisha@gmail.com' }, tk)).body;
  assert.equal((await call('POST', '/api/me/email/verify', { email: 'nisha@gmail.com', code: '000000' === er.devCode ? '111111' : '000000' }, tk)).body.code, 'otp_wrong');
  await call('POST', '/api/me/email/verify', { email: 'nisha@gmail.com', code: er.devCode }, tk);
  assert.equal((await call('GET', '/api/me/profile', null, tk)).body.trust, 30);
  const dob = db.get('SELECT dob FROM users WHERE id=?', uid).dob;
  const idBody = { method: 'aadhaar_digilocker', consent: true, reference: 'DL-REF-77', last4: '4321', nameOnId: 'NISHA MENON', dobOnId: dob };
  assert.equal((await call('POST', '/api/me/id/verify', { ...idBody, consent: false }, tk)).body.code, 'consent_required');
  assert.equal((await call('POST', '/api/me/id/verify', { ...idBody, idNumber: '123412344321' }, tk)).body.code, 'no_full_aadhaar');
  assert.equal((await call('POST', '/api/me/id/verify', { ...idBody, nameOnId: 'Someone Else' }, tk)).body.code, 'id_mismatch');
  const ok = (await call('POST', '/api/me/id/verify', idBody, tk)).body;
  assert.equal(ok.last4, '4321'); assert.equal(ok.coinsAwarded, 0); // profile not complete yet
  p = (await call('GET', '/api/me/profile', null, tk)).body;
  assert.equal(p.trust, 50); assert.equal(p.id.method, 'Aadhaar via DigiLocker');
  assert.ok(!JSON.stringify(db.get('SELECT * FROM users WHERE id=?', uid)).includes('123412344321'));
  // the same ID can't verify a second account
  const other = await signup('nisha2', 27); db.run("UPDATE users SET name='Nisha Menon' WHERE id=?", other);
  assert.equal((await call('POST', '/api/me/id/verify', { ...idBody, dobOnId: db.get('SELECT dob FROM users WHERE id=?', other).dob }, T.nisha2)).body.code, 'id_used');
  // a passport earns the same trust as Aadhaar
  const pp = await call('POST', '/api/me/id/verify', { ...idBody, method: 'passport', reference: 'P1234567', last4: '4567', dobOnId: db.get('SELECT dob FROM users WHERE id=?', other).dob }, T.nisha2);
  assert.equal(pp.status, 200);
  // finishing the profile pays the welcome bonus exactly once
  assert.equal((await call('PATCH', '/api/me/profile', { area: 'Kakkanad', bio: 'Books and plants' }, tk)).body.coinsAwarded, 0);
  assert.equal((await call('PATCH', '/api/me/profile', { avatarUrl: 'http://x' }, tk)).status, 400);
  assert.equal((await call('PATCH', '/api/me/profile', { avatarUrl: 'https://cdn.example.org/n.jpg' }, tk)).body.coinsAwarded, 1000);
  assert.equal((await call('PATCH', '/api/me/profile', { bio: 'Books, plants and tea' }, tk)).body.coinsAwarded, 0);
  assert.equal((await call('GET', '/api/coins', null, tk)).body.balance, 1000);
  assert.equal((await call('GET', '/api/me/profile', null, tk)).body.complete, 9);
});

test('Medical & Care: no medicines or needles, cleaning must be confirmed; donations are free item posts', async () => {
  const bad = await call('POST', '/api/posts', { type: 'item', cat: 'Medical & Care', title: 'Insulin pens and test strips', careConfirmed: true }, T.seller);
  assert.equal(bad.body.code, 'medical_banned');
  const unconfirmed = await call('POST', '/api/posts', { type: 'item', cat: 'Medical & Care', title: 'Folding wheelchair' }, T.seller);
  assert.equal(unconfirmed.body.code, 'care_unconfirmed');
  const ok = await call('POST', '/api/posts', { type: 'item', cat: 'Medical & Care', title: 'Folding wheelchair', careConfirmed: true, want: 'Walker' }, T.seller);
  assert.equal(ok.status, 201);
  const gift = await call('POST', '/api/posts', { type: 'donate', cat: 'Fashion', title: "Bag of kids' clothes", value: 900 }, T.buyer);
  assert.equal(gift.status, 201);
  const row = db.get('SELECT type, donate, value FROM posts WHERE id=?', gift.body.id);
  assert.deepEqual({ ...row }, { type: 'item', donate: 1, value: null });
  assert.equal(db.get('SELECT care_ok FROM posts WHERE id=?', ok.body.id).care_ok, 1);
});
