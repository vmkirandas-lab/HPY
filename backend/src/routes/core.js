// Swaapo Core: the four things the product is built on.
// 1. List an item: a photo, a short description and what you want in exchange.
// 2. Match and swipe: you say yes or no to other people's items; when both sides say yes, it's a match.
// 3. Chat: matched members talk and fix the exchange (place, time, condition).
// 4. Profile and rating: after a swap both sides rate each other, which builds trust.
import { Router } from 'express';
import crypto from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { requireUser } from '../auth.js';
import { fail } from '../errors.js';
import { needConsent, str, int, SCAM_WORDS } from '../rules.js';

export const DESC_MAX = 140;
export const WANTS_MAX = 80;
export const MSG_MAX = 1000;
export const ITEMS_MAX = 20;
export const PHOTO_MAX_BYTES = 1.5 * 1024 * 1024;
// A rating is hidden until the other side has rated too, or until this many days pass, so nobody rates in retaliation.
export const REVEAL_DAYS = 14;

export const CORE_SCHEMA = `
CREATE TABLE IF NOT EXISTS core_items(
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), photo TEXT NOT NULL,
  descr TEXT NOT NULL, wants TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','removed','swapped')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS core_swipes(
  user_id INTEGER NOT NULL REFERENCES users(id), item_id INTEGER NOT NULL REFERENCES core_items(id),
  dir TEXT NOT NULL CHECK(dir IN ('yes','no')), created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY(user_id, item_id));
CREATE TABLE IF NOT EXISTS core_matches(
  id INTEGER PRIMARY KEY, a_id INTEGER NOT NULL REFERENCES users(id), b_id INTEGER NOT NULL REFERENCES users(id),
  a_item INTEGER NOT NULL REFERENCES core_items(id), b_item INTEGER NOT NULL REFERENCES core_items(id),
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','agreed','completed','cancelled')),
  plan TEXT, plan_by INTEGER, plan_ok_a INTEGER NOT NULL DEFAULT 0, plan_ok_b INTEGER NOT NULL DEFAULT 0,
  done_a INTEGER NOT NULL DEFAULT 0, done_b INTEGER NOT NULL DEFAULT 0, cancelled_by INTEGER,
  read_a INTEGER NOT NULL DEFAULT 0, read_b INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')), completed_at TEXT);
CREATE TABLE IF NOT EXISTS core_messages(
  id INTEGER PRIMARY KEY, match_id INTEGER NOT NULL REFERENCES core_matches(id), sender_id INTEGER,
  body TEXT NOT NULL, warn INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS core_ratings(
  match_id INTEGER NOT NULL REFERENCES core_matches(id), rater_id INTEGER NOT NULL, ratee_id INTEGER NOT NULL,
  stars INTEGER NOT NULL CHECK(stars BETWEEN 1 AND 5), note TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY(match_id, rater_id));
CREATE TABLE IF NOT EXISTS core_notifs(
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), kind TEXT NOT NULL, match_id INTEGER,
  body TEXT NOT NULL, seen INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE INDEX IF NOT EXISTS ix_core_items_user ON core_items(user_id, status);
CREATE INDEX IF NOT EXISTS ix_core_matches_a ON core_matches(a_id);
CREATE INDEX IF NOT EXISTS ix_core_matches_b ON core_matches(b_id);
CREATE INDEX IF NOT EXISTS ix_core_messages ON core_messages(match_id, id);
CREATE INDEX IF NOT EXISTS ix_core_notifs ON core_notifs(user_id, seen);
`;

const IMAGE_TYPES = { 'image/jpeg': ['jpg', b => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff],
  'image/png': ['png', b => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))],
  'image/webp': ['webp', b => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP'] };

export const uploadDir = () => process.env.UPLOAD_DIR || 'data/uploads';

// Accepts a data URL, checks the file really is the image type it claims, and stores it under a random name.
function savePhoto(dataUrl) {
  const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
  if (!m) fail(400, 'Add a photo of the item (JPEG, PNG or WebP).', 'photo_required');
  const buf = Buffer.from(m[2], 'base64'), [ext, isType] = IMAGE_TYPES[m[1]];
  if (buf.length > PHOTO_MAX_BYTES) fail(413, 'That photo is too large. Use one under 1.5 MB.', 'photo_too_large');
  if (buf.length < 100 || !isType(buf)) fail(400, "That file isn't a valid photo.", 'photo_invalid');
  const dir = uploadDir(), name = `${crypto.randomBytes(16).toString('hex')}.${ext}`;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), buf);
  return `/uploads/${name}`;
}

export default function core(db) {
  db.raw.exec(CORE_SCHEMA);
  const r = Router();
  const me = req => { const u = requireUser(req); needConsent(u); return u; };
  const side = (m, uid) => (m.a_id === uid ? 'a' : m.b_id === uid ? 'b' : null);
  const other = (m, uid) => (m.a_id === uid ? m.b_id : m.a_id);
  const notify = (userId, kind, matchId, body) => db.run('INSERT INTO core_notifs(user_id,kind,match_id,body) VALUES(?,?,?,?)', userId, kind, matchId, body);
  const system = (matchId, body) => db.run('INSERT INTO core_messages(match_id,sender_id,body) VALUES(?,NULL,?)', matchId, body);

  function stats(userId) {
    const swaps = db.get("SELECT COUNT(*) n FROM core_matches WHERE status='completed' AND (a_id=? OR b_id=?)", userId, userId).n;
    const rt = db.get(`SELECT COUNT(*) n, AVG(r.stars) avg FROM core_ratings r JOIN core_matches m ON m.id=r.match_id
      WHERE r.ratee_id=? AND (EXISTS(SELECT 1 FROM core_ratings o WHERE o.match_id=r.match_id AND o.rater_id=r.ratee_id)
        OR m.completed_at <= datetime('now', ?))`, userId, `-${REVEAL_DAYS} days`);
    return { swaps, rating: rt.n ? Math.round(rt.avg * 10) / 10 : null, ratings: rt.n };
  }
  const person = id => {
    const u = db.get('SELECT id, handle, name, area, created_at FROM users WHERE id=?', id);
    return u && { handle: u.handle, name: u.name, area: u.area || '', joined: u.created_at, ...stats(u.id) };
  };
  const itemOut = i => i && { id: i.id, photo: i.photo, desc: i.descr, wants: i.wants, status: i.status, createdAt: i.created_at };
  function getMatch(req) {
    const u = me(req), m = db.get('SELECT * FROM core_matches WHERE id=?', int(req.params.id));
    if (!m || !side(m, u.id)) fail(404, 'Chat not found.');
    return { u, m, s: side(m, u.id) };
  }
  function matchOut(m, uid) {
    const s = side(m, uid), o = s === 'a' ? 'b' : 'a';
    const last = db.get('SELECT id, sender_id, body, created_at FROM core_messages WHERE match_id=? ORDER BY id DESC LIMIT 1', m.id);
    const unread = db.get('SELECT COUNT(*) n FROM core_messages WHERE match_id=? AND id>? AND (sender_id IS NULL OR sender_id<>?)', m.id, m[`read_${s}`], uid).n;
    const myRating = db.get('SELECT stars, note FROM core_ratings WHERE match_id=? AND rater_id=?', m.id, uid);
    return {
      id: m.id, status: m.status, createdAt: m.created_at, completedAt: m.completed_at,
      with: person(other(m, uid)),
      myItem: itemOut(db.get('SELECT * FROM core_items WHERE id=?', m[`${s}_item`])),
      theirItem: itemOut(db.get('SELECT * FROM core_items WHERE id=?', m[`${o}_item`])),
      plan: m.plan ? { ...JSON.parse(m.plan), proposedByMe: m.plan_by === uid, iConfirmed: !!m[`plan_ok_${s}`], theyConfirmed: !!m[`plan_ok_${o}`] } : null,
      iMarkedDone: !!m[`done_${s}`], theyMarkedDone: !!m[`done_${o}`],
      myRating: myRating ? { stars: myRating.stars, note: myRating.note } : null,
      lastMessage: last ? { body: last.body, fromMe: last.sender_id === uid, system: last.sender_id === null, at: last.created_at } : null,
      unread,
    };
  }

  // ---- 1. List an item
  r.post('/core/items', (req, res) => {
    const u = me(req);
    const desc = str(req.body.desc, DESC_MAX + 1), wants = str(req.body.wants, WANTS_MAX + 1);
    if (!desc) fail(400, 'Add a short description.', 'desc_required');
    if (desc.length > DESC_MAX) fail(400, `Keep the description to ${DESC_MAX} characters.`, 'desc_too_long');
    if (!wants) fail(400, 'Say what you want in exchange.', 'wants_required');
    if (wants.length > WANTS_MAX) fail(400, `Keep what you want to ${WANTS_MAX} characters.`, 'wants_too_long');
    if (db.get("SELECT COUNT(*) n FROM core_items WHERE user_id=? AND status='active'", u.id).n >= ITEMS_MAX) fail(400, `You can list up to ${ITEMS_MAX} items at a time.`, 'items_limit');
    const photo = savePhoto(req.body.photo);
    const { lastInsertRowid } = db.run('INSERT INTO core_items(user_id,photo,descr,wants) VALUES(?,?,?,?)', u.id, photo, desc, wants);
    res.status(201).json(itemOut(db.get('SELECT * FROM core_items WHERE id=?', lastInsertRowid)));
  });
  r.get('/core/items/mine', (req, res) => {
    const u = me(req);
    const rows = db.all("SELECT i.*, (SELECT COUNT(*) FROM core_swipes s WHERE s.item_id=i.id AND s.dir='yes') likes FROM core_items i WHERE user_id=? AND status<>'removed' ORDER BY id DESC", u.id);
    res.json(rows.map(i => ({ ...itemOut(i), likes: i.likes })));
  });
  r.delete('/core/items/:id', (req, res) => {
    const u = me(req), i = db.get('SELECT * FROM core_items WHERE id=?', int(req.params.id));
    if (!i || i.user_id !== u.id || i.status === 'removed') fail(404, 'Item not found.');
    if (i.status === 'swapped') fail(400, "This item has been swapped, so it stays on your profile's history.");
    db.run("UPDATE core_items SET status='removed' WHERE id=?", i.id);
    res.json({ ok: true });
  });

  // ---- 2. Match and swipe
  r.get('/core/deck', (req, res) => {
    const u = me(req);
    const hasItem = !!db.get("SELECT 1 FROM core_items WHERE user_id=? AND status='active'", u.id);
    if (!hasItem) return res.json({ needItem: true, items: [] });
    // Items whose owners already said yes to one of yours come first: a yes from you is an instant match.
    const rows = db.all(`SELECT i.*, EXISTS(SELECT 1 FROM core_swipes s JOIN core_items mine ON mine.id=s.item_id
        WHERE s.user_id=i.user_id AND s.dir='yes' AND mine.user_id=? AND mine.status='active') likes_you
      FROM core_items i JOIN users o ON o.id=i.user_id
      WHERE i.status='active' AND i.user_id<>? AND o.banned=0 AND o.status='active'
        AND NOT EXISTS(SELECT 1 FROM core_swipes s WHERE s.user_id=? AND s.item_id=i.id)
      ORDER BY likes_you DESC, i.id DESC LIMIT ?`, u.id, u.id, u.id, Math.min(50, int(req.query.limit) || 20));
    res.json({ needItem: false, items: rows.map(i => ({ ...itemOut(i), likesYou: !!i.likes_you, owner: person(i.user_id) })) });
  });
  r.post('/core/swipes', (req, res) => {
    const u = me(req), dir = req.body.dir;
    if (!['yes', 'no'].includes(dir)) fail(400, 'Swipe yes or no.');
    const item = db.get('SELECT * FROM core_items WHERE id=?', int(req.body.itemId));
    if (!item || item.status !== 'active') fail(404, 'That item is no longer available.', 'item_gone');
    if (item.user_id === u.id) fail(400, "You can't swipe on your own item.");
    if (!db.get("SELECT 1 FROM core_items WHERE user_id=? AND status='active'", u.id)) fail(400, 'List an item first so others can see yours too.', 'need_item');
    const out = db.tx(() => {
      db.run('INSERT INTO core_swipes(user_id,item_id,dir) VALUES(?,?,?) ON CONFLICT(user_id,item_id) DO UPDATE SET dir=excluded.dir, created_at=datetime(\'now\')', u.id, item.id, dir);
      if (dir !== 'yes') return { matched: null };
      // Did the owner already say yes to one of my items?
      const theirYes = db.get(`SELECT s.item_id FROM core_swipes s JOIN core_items mine ON mine.id=s.item_id
        WHERE s.user_id=? AND s.dir='yes' AND mine.user_id=? AND mine.status='active'
          AND NOT EXISTS(SELECT 1 FROM core_matches m WHERE m.status<>'cancelled' AND
            ((m.a_item=mine.id AND m.b_item=?) OR (m.b_item=mine.id AND m.a_item=?)))
        ORDER BY s.created_at DESC LIMIT 1`, item.user_id, u.id, item.id, item.id);
      if (!theirYes) return { matched: null };
      const { lastInsertRowid: mid } = db.run('INSERT INTO core_matches(a_id,b_id,a_item,b_item) VALUES(?,?,?,?)', u.id, item.user_id, theirYes.item_id, item.id);
      system(mid, "It's a match! You both said yes. Agree a place, a time and the condition of the items here.");
      notify(u.id, 'match', mid, `You matched with ${db.get('SELECT name FROM users WHERE id=?', item.user_id).name}.`);
      notify(item.user_id, 'match', mid, `You matched with ${u.name}.`);
      return { matched: matchOut(db.get('SELECT * FROM core_matches WHERE id=?', mid), u.id) };
    });
    res.json(out);
  });

  // ---- 3. Chat
  r.get('/core/matches', (req, res) => {
    const u = me(req);
    const rows = db.all('SELECT m.* FROM core_matches m WHERE a_id=? OR b_id=? ORDER BY COALESCE((SELECT MAX(id) FROM core_messages WHERE match_id=m.id),0) DESC, m.id DESC', u.id, u.id);
    res.json(rows.map(m => matchOut(m, u.id)));
  });
  r.get('/core/matches/:id', (req, res) => { const { u, m } = getMatch(req); res.json(matchOut(m, u.id)); });
  r.get('/core/matches/:id/messages', (req, res) => {
    const { u, m, s } = getMatch(req);
    const after = int(req.query.after) || 0;
    const rows = db.all('SELECT * FROM core_messages WHERE match_id=? AND id>? ORDER BY id LIMIT 200', m.id, after);
    if (rows.length) db.run(`UPDATE core_matches SET read_${s}=MAX(read_${s}, ?) WHERE id=?`, rows[rows.length - 1].id, m.id);
    res.json(rows.map(x => ({ id: x.id, body: x.body, fromMe: x.sender_id === u.id, system: x.sender_id === null, warn: !!x.warn, at: x.created_at })));
  });
  r.post('/core/matches/:id/messages', (req, res) => {
    const { u, m } = getMatch(req);
    if (m.status === 'cancelled') fail(400, 'This swap was cancelled, so the chat is closed.', 'match_closed');
    const body = str(req.body.text, MSG_MAX + 1);
    if (!body) fail(400, 'Type a message.');
    if (body.length > MSG_MAX) fail(400, `Keep messages under ${MSG_MAX} characters.`);
    const warn = SCAM_WORDS.test(body) ? 1 : 0;
    const { lastInsertRowid } = db.run('INSERT INTO core_messages(match_id,sender_id,body,warn) VALUES(?,?,?,?)', m.id, u.id, body, warn);
    res.status(201).json({ id: Number(lastInsertRowid), warn: !!warn });
  });
  // The swap plan: where, when, and what condition the items are in. Both sides must confirm the same plan.
  r.post('/core/matches/:id/plan', (req, res) => {
    const { u, m, s } = getMatch(req);
    if (!['open', 'agreed'].includes(m.status)) fail(400, 'This swap is already closed.', 'match_closed');
    const place = str(req.body.place, 120), time = str(req.body.time, 40), condition = str(req.body.condition, 200);
    if (!place) fail(400, 'Add a public place to meet.');
    const t = Date.parse(time);
    if (!time || Number.isNaN(t)) fail(400, 'Pick a date and time.');
    if (t < Date.now() - 60000) fail(400, 'Pick a time in the future.');
    if (!condition) fail(400, 'Describe the condition of the items.');
    db.run(`UPDATE core_matches SET plan=?, plan_by=?, plan_ok_a=?, plan_ok_b=?, status='open' WHERE id=?`,
      JSON.stringify({ place, time: new Date(t).toISOString(), condition }), u.id, s === 'a' ? 1 : 0, s === 'b' ? 1 : 0, m.id);
    system(m.id, `${u.name} proposed: ${place}, ${new Date(t).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata' })}. Condition: ${condition}`);
    notify(other(m, u.id), 'plan', m.id, `${u.name} proposed a time and place to swap.`);
    res.json(matchOut(db.get('SELECT * FROM core_matches WHERE id=?', m.id), u.id));
  });
  r.post('/core/matches/:id/plan/confirm', (req, res) => {
    const { u, m, s } = getMatch(req);
    if (!m.plan) fail(400, 'There is no plan to confirm yet.');
    if (m.status !== 'open') fail(400, m.status === 'agreed' ? 'The plan is already agreed.' : 'This swap is already closed.');
    db.run(`UPDATE core_matches SET plan_ok_${s}=1 WHERE id=?`, m.id);
    const n = db.get('SELECT * FROM core_matches WHERE id=?', m.id);
    if (n.plan_ok_a && n.plan_ok_b) {
      db.run("UPDATE core_matches SET status='agreed' WHERE id=?", m.id);
      system(m.id, 'Plan agreed by both of you. Meet in a public place and check the items before you swap.');
      notify(other(m, u.id), 'agreed', m.id, `${u.name} confirmed the swap plan.`);
    }
    res.json(matchOut(db.get('SELECT * FROM core_matches WHERE id=?', m.id), u.id));
  });
  r.post('/core/matches/:id/done', (req, res) => {
    const { u, m, s } = getMatch(req);
    if (m.status !== 'agreed') fail(400, m.status === 'completed' ? 'This swap is already complete.' : 'Agree a plan before marking the swap as done.', 'not_agreed');
    db.tx(() => {
      db.run(`UPDATE core_matches SET done_${s}=1 WHERE id=?`, m.id);
      const n = db.get('SELECT * FROM core_matches WHERE id=?', m.id);
      if (n.done_a && n.done_b) {
        db.run("UPDATE core_matches SET status='completed', completed_at=datetime('now') WHERE id=?", m.id);
        db.run("UPDATE core_items SET status='swapped' WHERE id IN (?,?)", m.a_item, m.b_item);
        system(m.id, 'Swap complete. Rate each other to build trust on Swaapo.');
        notify(m.a_id, 'completed', m.id, 'Your swap is complete. Rate your swap partner.');
        notify(m.b_id, 'completed', m.id, 'Your swap is complete. Rate your swap partner.');
      } else {
        system(m.id, `${u.name} marked the swap as done.`);
        notify(other(m, u.id), 'done', m.id, `${u.name} marked the swap as done. Confirm when you have the item.`);
      }
    });
    res.json(matchOut(db.get('SELECT * FROM core_matches WHERE id=?', m.id), u.id));
  });
  r.post('/core/matches/:id/cancel', (req, res) => {
    const { u, m } = getMatch(req);
    if (['completed', 'cancelled'].includes(m.status)) fail(400, 'This swap is already closed.');
    db.run("UPDATE core_matches SET status='cancelled', cancelled_by=? WHERE id=?", u.id, m.id);
    system(m.id, `${u.name} cancelled this swap.${str(req.body.reason, 200) ? ` Reason: ${str(req.body.reason, 200)}` : ''}`);
    notify(other(m, u.id), 'cancelled', m.id, `${u.name} cancelled the swap.`);
    res.json(matchOut(db.get('SELECT * FROM core_matches WHERE id=?', m.id), u.id));
  });

  // ---- 4. Profile and rating
  r.post('/core/matches/:id/rating', (req, res) => {
    const { u, m } = getMatch(req);
    if (m.status !== 'completed') fail(400, 'You can rate once the swap is complete.', 'not_completed');
    const stars = int(req.body.stars);
    if (!(stars >= 1 && stars <= 5)) fail(400, 'Choose 1 to 5 stars.');
    if (db.get('SELECT 1 FROM core_ratings WHERE match_id=? AND rater_id=?', m.id, u.id)) fail(409, 'You have already rated this swap.', 'already_rated');
    db.run('INSERT INTO core_ratings(match_id,rater_id,ratee_id,stars,note) VALUES(?,?,?,?,?)', m.id, u.id, other(m, u.id), stars, str(req.body.note, 300) || null);
    notify(other(m, u.id), 'rated', m.id, `${u.name} rated your swap.`);
    res.status(201).json(matchOut(db.get('SELECT * FROM core_matches WHERE id=?', m.id), u.id));
  });
  r.get('/core/users/:handle', (req, res) => {
    requireUser(req);
    const u = db.get("SELECT id, handle, name, area, bio, created_at FROM users WHERE handle=? AND status='active' AND banned=0", str(req.params.handle, 30).toLowerCase());
    if (!u) fail(404, 'Member not found.');
    const reviews = db.all(`SELECT r.stars, r.note, r.created_at, w.handle, w.name FROM core_ratings r JOIN core_matches m ON m.id=r.match_id JOIN users w ON w.id=r.rater_id
      WHERE r.ratee_id=? AND (EXISTS(SELECT 1 FROM core_ratings o WHERE o.match_id=r.match_id AND o.rater_id=r.ratee_id) OR m.completed_at <= datetime('now', ?))
      ORDER BY r.created_at DESC LIMIT 20`, u.id, `-${REVEAL_DAYS} days`);
    res.json({ handle: u.handle, name: u.name, area: u.area || '', bio: u.bio || '', joined: u.created_at, ...stats(u.id),
      reviews: reviews.map(x => ({ stars: x.stars, note: x.note, at: x.created_at, by: { handle: x.handle, name: x.name } })),
      items: db.all("SELECT * FROM core_items WHERE user_id=? AND status='active' ORDER BY id DESC", u.id).map(itemOut) });
  });

  // ---- Notifications and safety
  r.get('/core/summary', (req, res) => {
    const u = me(req);
    const unread = db.all('SELECT * FROM core_matches WHERE a_id=? OR b_id=?', u.id, u.id).reduce((n, m) => n + matchOut(m, u.id).unread, 0);
    const notifs = db.all('SELECT id, kind, match_id, body, created_at FROM core_notifs WHERE user_id=? AND seen=0 ORDER BY id', u.id);
    res.json({ unread, notifications: notifs.map(n => ({ id: n.id, kind: n.kind, matchId: n.match_id, body: n.body, at: n.created_at })) });
  });
  r.post('/core/notifications/seen', (req, res) => {
    const u = me(req), upTo = int(req.body.upTo) || Number.MAX_SAFE_INTEGER;
    db.run('UPDATE core_notifs SET seen=1 WHERE user_id=? AND id<=?', u.id, upTo);
    res.json({ ok: true });
  });
  r.post('/core/reports', (req, res) => {
    const u = me(req), type = req.body.type, reason = str(req.body.reason, 300);
    if (!['item', 'user', 'match'].includes(type)) fail(400, 'Choose what you are reporting.');
    if (!reason) fail(400, 'Tell us what is wrong.');
    let id = int(req.body.id);
    if (type === 'user') id = db.get('SELECT id FROM users WHERE handle=?', str(req.body.id, 30).toLowerCase())?.id;
    if (!id) fail(404, 'Not found.');
    db.run('INSERT INTO reports(reporter_id,target_type,target_id,reason) VALUES(?,?,?,?)', u.id, `core_${type}`, id, reason);
    res.status(201).json({ ok: true });
  });
  return r;
}
