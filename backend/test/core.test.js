// End-to-end tests for Swaapo Core: list, swipe and match, chat, profile and rating.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const uploads = mkdtempSync(join(tmpdir(), 'swaapo-uploads-'));
process.env.UPLOAD_DIR = uploads;
process.env.AUTH_RATE_MAX = '1000';
const { createApp } = await import('../src/app.js');

let server, base, db;
const T = {};
const call = async (method, path, body, who) => {
  const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(who ? { Authorization: 'Bearer ' + T[who] } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  return { status: r.status, body: text ? JSON.parse(text) : null };
};
const dobFor = age => `${new Date().getUTCFullYear() - age - 1}-01-01`;
let phoneN = 9100000000;
async function signup(handle, age = 30, extra = {}) {
  const phone = String(++phoneN);
  const o = (await call('POST', '/api/auth/otp/request', { phone })).body;
  const t = (await call('POST', '/api/auth/otp/verify', { phone, code: o.devCode })).body.phoneTicket;
  const r = await call('POST', '/api/auth/signup', { name: handle[0].toUpperCase() + handle.slice(1), handle, password: 'password123', dob: dobFor(age), phoneTicket: t, area: 'Kochi', ...extra });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  T[handle] = r.body.token;
}
// A tiny but valid-looking JPEG: the server checks the magic bytes and the size.
const JPEG = 'data:image/jpeg;base64,' + Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(300, 7), Buffer.from([0xff, 0xd9])]).toString('base64');
const list = (who, desc, wants) => call('POST', '/api/core/items', { photo: JPEG, desc, wants }, who);

before(async () => {
  ({ app: server, db } = createApp({ dbPath: ':memory:' }));
  server = server.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
  for (const h of ['asha', 'bilal', 'chitra', 'dev']) await signup(h);
  await signup('teen', 16, { guardianContact: 'parent@t.in' });
});
after(() => { server.close(); rmSync(uploads, { recursive: true, force: true }); });

test('1. listing needs a real photo, a short description and what you want; nothing else', async () => {
  assert.equal((await call('POST', '/api/core/items', { desc: 'Guitar', wants: 'Bike' }, 'asha')).body.code, 'photo_required');
  const fake = 'data:image/jpeg;base64,' + Buffer.from('<script>alert(1)</script>'.repeat(10)).toString('base64');
  assert.equal((await call('POST', '/api/core/items', { photo: fake, desc: 'Guitar', wants: 'Bike' }, 'asha')).body.code, 'photo_invalid');
  assert.equal((await list('asha', 'x'.repeat(141), 'Bike')).body.code, 'desc_too_long');
  assert.equal((await list('asha', 'Guitar', '')).body.code, 'wants_required');
  assert.equal((await list('asha', 'Guitar', 'y'.repeat(81))).body.code, 'wants_too_long');
  assert.equal((await call('POST', '/api/core/items', { photo: JPEG, desc: 'Guitar', wants: 'Bike' })).status, 401);
  assert.equal((await list('teen', 'Cricket bat', 'Football')).body.code, 'guardian_consent');

  const ok = await list('asha', 'Yamaha acoustic guitar, new strings', 'A bicycle');
  assert.equal(ok.status, 201);
  assert.match(ok.body.photo, /^\/uploads\/[0-9a-f]{32}\.jpg$/);
  const img = await fetch(base + ok.body.photo);
  assert.equal(img.status, 200);
  assert.equal(img.headers.get('content-security-policy'), "default-src 'none'");
  assert.equal((await fetch(base + '/uploads/../package.json')).status, 404);
  const mine = (await call('GET', '/api/core/items/mine', null, 'asha')).body;
  assert.deepEqual(mine.map(i => [i.desc, i.wants, i.likes]), [['Yamaha acoustic guitar, new strings', 'A bicycle', 0]]);
});

test('2. swipe: you see their items, they see yours; both yes makes a match and notifies both', async () => {
  // No item listed yet: the deck asks you to list one first.
  assert.equal((await call('GET', '/api/core/deck', null, 'bilal')).body.needItem, true);
  const bike = (await list('bilal', 'Btwin MTB, 21 gears, serviced', 'Guitar or keyboard')).body;
  const guitar = (await call('GET', '/api/core/items/mine', null, 'asha')).body[0];

  const deckB = (await call('GET', '/api/core/deck', null, 'bilal')).body;
  assert.equal(deckB.needItem, false);
  assert.ok(deckB.items.some(i => i.id === guitar.id && i.owner.handle === 'asha'));
  assert.ok(!deckB.items.some(i => i.id === bike.id), 'your own items are not in your deck');

  assert.equal((await call('POST', '/api/core/swipes', { itemId: bike.id, dir: 'yes' }, 'bilal')).status, 400, "can't swipe your own item");
  const first = await call('POST', '/api/core/swipes', { itemId: guitar.id, dir: 'yes' }, 'bilal');
  assert.equal(first.body.matched, null);
  // Asha's deck puts Bilal's bike first, because Bilal already likes her guitar.
  await list('chitra', 'Study table', 'Books');
  const deckA = (await call('GET', '/api/core/deck', null, 'asha')).body.items;
  assert.equal(deckA[0].id, bike.id);
  assert.ok(!(await call('GET', '/api/core/deck', null, 'bilal')).body.items.some(i => i.id === guitar.id), 'swiped items leave the deck');

  const m = (await call('POST', '/api/core/swipes', { itemId: bike.id, dir: 'yes' }, 'asha')).body.matched;
  assert.ok(m, 'mutual yes is a match');
  assert.equal(m.with.handle, 'bilal');
  assert.equal(m.myItem.id, guitar.id);
  assert.equal(m.theirItem.id, bike.id);
  for (const who of ['asha', 'bilal']) {
    const s = (await call('GET', '/api/core/summary', null, who)).body;
    assert.ok(s.notifications.some(n => n.kind === 'match' && n.matchId === m.id), `${who} is notified`);
  }
  // A "no" never matches, and swiping yes again doesn't create a second match for the same pair of items.
  assert.equal((await call('POST', '/api/core/swipes', { itemId: bike.id, dir: 'yes' }, 'asha')).body.matched, null);
  const chitraItem = (await call('GET', '/api/core/items/mine', null, 'chitra')).body[0];
  assert.equal((await call('POST', '/api/core/swipes', { itemId: chitraItem.id, dir: 'no' }, 'asha')).body.matched, null);
  assert.equal((await call('GET', '/api/core/matches', null, 'asha')).body.length, 1);
});

test('3. chat: only the two matched members; they agree place, time and condition, then both confirm the swap', async () => {
  const [m] = (await call('GET', '/api/core/matches', null, 'asha')).body;
  assert.equal((await call('GET', `/api/core/matches/${m.id}/messages`, null, 'chitra')).status, 404, 'outsiders cannot read the chat');
  assert.equal((await call('POST', `/api/core/matches/${m.id}/messages`, { text: 'hi' }, 'chitra')).status, 404);

  assert.equal((await call('POST', `/api/core/matches/${m.id}/messages`, { text: 'Hi! Is the bike still in good shape?' }, 'asha')).status, 201);
  const warned = await call('POST', `/api/core/matches/${m.id}/messages`, { text: 'Send advance on UPI first' }, 'bilal');
  assert.equal(warned.body.warn, true, 'payment-scam phrases are flagged');
  assert.equal((await call('GET', '/api/core/summary', null, 'asha')).body.unread >= 1, true);
  const msgs = (await call('GET', `/api/core/matches/${m.id}/messages`, null, 'asha')).body;
  assert.ok(msgs[0].system);
  assert.deepEqual(msgs.filter(x => !x.system).map(x => [x.fromMe, x.warn]), [[true, false], [false, true]]);
  assert.equal((await call('GET', `/api/core/matches/${m.id}`, null, 'asha')).body.unread, 0, 'reading marks the chat as read');
  assert.equal((await call('GET', `/api/core/matches/${m.id}/messages?after=${msgs.at(-1).id}`, null, 'asha')).body.length, 0);

  assert.equal((await call('POST', `/api/core/matches/${m.id}/done`, {}, 'asha')).body.code, 'not_agreed');
  assert.equal((await call('POST', `/api/core/matches/${m.id}/plan`, { place: 'Lulu Mall gate 2', time: '2020-01-01T10:00:00Z', condition: 'Good' }, 'asha')).status, 400, 'no plans in the past');
  const when = new Date(Date.now() + 2 * 864e5).toISOString();
  let p = (await call('POST', `/api/core/matches/${m.id}/plan`, { place: 'Lulu Mall gate 2', time: when, condition: 'Guitar: new strings. Bike: serviced last month.' }, 'asha')).body;
  assert.deepEqual([p.plan.place, p.plan.iConfirmed, p.plan.theyConfirmed, p.status], ['Lulu Mall gate 2', true, false, 'open']);
  p = (await call('POST', `/api/core/matches/${m.id}/plan/confirm`, {}, 'bilal')).body;
  assert.equal(p.status, 'agreed');

  p = (await call('POST', `/api/core/matches/${m.id}/done`, {}, 'asha')).body;
  assert.deepEqual([p.status, p.iMarkedDone, p.theyMarkedDone], ['agreed', true, false]);
  p = (await call('POST', `/api/core/matches/${m.id}/done`, {}, 'bilal')).body;
  assert.equal(p.status, 'completed');
  assert.deepEqual((await call('GET', '/api/core/items/mine', null, 'asha')).body.map(i => i.status), ['swapped']);
  assert.ok(!(await call('GET', '/api/core/deck', null, 'chitra')).body.items.some(i => i.id === m.theirItem.id), 'swapped items leave every deck');
});

test('4. rating: only after the swap, once each, and hidden until both have rated', async () => {
  const [m] = (await call('GET', '/api/core/matches', null, 'asha')).body;
  assert.equal((await call('POST', `/api/core/matches/${m.id}/rating`, { stars: 6 }, 'asha')).status, 400);
  assert.equal((await call('POST', `/api/core/matches/${m.id}/rating`, { stars: 5, note: 'Bike exactly as described, on time.' }, 'asha')).status, 201);
  assert.equal((await call('POST', `/api/core/matches/${m.id}/rating`, { stars: 4 }, 'asha')).body.code, 'already_rated');

  let bilal = (await call('GET', '/api/core/users/bilal', null, 'chitra')).body;
  assert.deepEqual([bilal.swaps, bilal.rating, bilal.reviews.length], [1, null, 0], "Asha's rating stays hidden until Bilal rates too");
  assert.equal((await call('POST', `/api/core/matches/${m.id}/rating`, { stars: 4, note: 'Friendly, guitar was great.' }, 'bilal')).status, 201);
  bilal = (await call('GET', '/api/core/users/bilal', null, 'chitra')).body;
  assert.deepEqual([bilal.swaps, bilal.rating, bilal.ratings, bilal.reviews[0].by.handle, bilal.reviews[0].stars], [1, 5, 1, 'asha', 5]);
  const asha = (await call('GET', '/api/core/users/asha', null, 'chitra')).body;
  assert.deepEqual([asha.rating, asha.reviews[0].note], [4, 'Friendly, guitar was great.']);
  assert.equal((await call('GET', '/api/core/users/nobody', null, 'chitra')).status, 404);

  // A rating no one answers is revealed after the waiting period.
  await list('chitra', 'Desk lamp', 'Plant');
  await list('dev', 'Football', 'Desk lamp');
  const lamp = (await call('GET', '/api/core/items/mine', null, 'chitra')).body.find(i => i.desc === 'Desk lamp');
  const ball = (await call('GET', '/api/core/items/mine', null, 'dev')).body[0];
  await call('POST', '/api/core/swipes', { itemId: lamp.id, dir: 'yes' }, 'dev');
  const m2 = (await call('POST', '/api/core/swipes', { itemId: ball.id, dir: 'yes' }, 'chitra')).body.matched;
  await call('POST', `/api/core/matches/${m2.id}/plan`, { place: 'Vyttila Hub', time: new Date(Date.now() + 864e5).toISOString(), condition: 'Both good' }, 'dev');
  await call('POST', `/api/core/matches/${m2.id}/plan/confirm`, {}, 'chitra');
  await call('POST', `/api/core/matches/${m2.id}/done`, {}, 'dev');
  await call('POST', `/api/core/matches/${m2.id}/done`, {}, 'chitra');
  await call('POST', `/api/core/matches/${m2.id}/rating`, { stars: 2 }, 'dev');
  assert.equal((await call('GET', '/api/core/users/chitra', null, 'asha')).body.rating, null);
  db.run("UPDATE core_matches SET completed_at=datetime('now','-15 days') WHERE id=?", m2.id);
  assert.equal((await call('GET', '/api/core/users/chitra', null, 'asha')).body.rating, 2);
});

test('cancelling closes the chat; reports reach the moderation queue', async () => {
  const kb = (await list('asha', 'Casio keyboard', 'Camera')).body;
  const cam = (await list('dev', 'Old film camera', 'Keyboard')).body;
  await call('POST', '/api/core/swipes', { itemId: kb.id, dir: 'yes' }, 'dev');
  const m = (await call('POST', '/api/core/swipes', { itemId: cam.id, dir: 'yes' }, 'asha')).body.matched;
  assert.equal((await call('POST', `/api/core/matches/${m.id}/cancel`, { reason: 'Changed my mind' }, 'dev')).body.status, 'cancelled');
  assert.equal((await call('POST', `/api/core/matches/${m.id}/messages`, { text: 'hello?' }, 'asha')).body.code, 'match_closed');
  assert.equal((await call('POST', '/api/core/reports', { type: 'user', id: 'dev', reason: 'No-show' }, 'asha')).status, 201);
  assert.ok(db.get("SELECT 1 FROM reports WHERE target_type='core_user' AND reason='No-show'"));
  assert.equal((await call('DELETE', `/api/core/items/${kb.id}`, null, 'dev')).status, 404, "can't delete someone else's item");
  assert.equal((await call('DELETE', `/api/core/items/${kb.id}`, null, 'asha')).status, 200);
});
