// Posts, swap offers, completion, 5-star ratings and coin rewards.
import { Router } from 'express';
import { requireUser } from '../auth.js';
import { fail } from '../errors.js';
import { needConsent, needFeature, str, int } from '../rules.js';
import { onSwapCompleted } from './impact.js';

const MEDICAL = 'Medical & Care';
const MED_BANNED = /\b(medicines?|tablets?|capsules?|syrups?|injections?|syringes?|needles?|insulin|strips?|ointments?|drugs?|vials?|ampoules?|cannulas?|catheters?)\b/i;

export default function market(db) {
  const r = Router();

  r.get('/feed', (req, res) => {
    const cat = str(req.query.cat, 30), q = str(req.query.q, 60);
    const rows = db.all(`SELECT p.*, u.handle, u.name, u.verified, u.tier FROM posts p JOIN users u ON u.id=p.user_id
      WHERE p.status='active' AND u.banned=0 AND u.status='active' AND (?='' OR p.cat=?) AND (?='' OR p.title LIKE ? OR p.want LIKE ? OR p.body LIKE ?)
      ORDER BY p.id DESC LIMIT ?`, cat, cat, q, `%${q}%`, `%${q}%`, `%${q}%`, Math.min(100, int(req.query.limit) || 30));
    res.json(rows);
  });
  r.get('/posts/:id', (req, res) => {
    const p = db.get("SELECT * FROM posts WHERE id=? AND status='active'", req.params.id);
    if (!p) fail(404, 'Post not found.');
    res.json(p);
  });
  r.post('/posts', (req, res) => {
    const u = requireUser(req); needConsent(u);
    const cats = db.setting('categories'), donate = req.body.type === 'donate';
    const type = donate ? 'item' : req.body.type;
    if (!['item', 'iso', 'done'].includes(type)) fail(400, 'Post type must be item, iso, done or donate.');
    const title = str(req.body.title, 80);
    if (!title) fail(400, 'Say what the item is.');
    const cat = req.body.cat ? str(req.body.cat, 30) : null;
    if (cat && !cats.includes(cat)) fail(400, 'Unknown category.');
    const body = str(req.body.body, 2000), careOk = cat === MEDICAL;
    if (careOk) {
      if (MED_BANNED.test(`${title} ${body}`)) fail(400, "Medicines, injections, needles, test strips and opened consumables can't be listed.", 'medical_banned');
      if (req.body.careConfirmed !== true) fail(400, 'Confirm the item is cleaned, disinfected and safe to use.', 'care_unconfirmed');
    }
    const { lastInsertRowid: id } = db.run('INSERT INTO posts(user_id,type,cat,title,body,want,cond,value,media_url,donate,care_ok) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
      u.id, type, cat, title, body, str(req.body.want, 200) || null, str(req.body.cond, 20) || null,
      donate ? null : Number.isFinite(int(req.body.value)) ? int(req.body.value) : null, str(req.body.mediaUrl, 500) || null, donate ? 1 : 0, careOk ? 1 : 0);
    res.status(201).json({ id: Number(id) });
  });
  r.delete('/posts/:id', (req, res) => {
    const u = requireUser(req);
    const p = db.get('SELECT * FROM posts WHERE id=?', req.params.id);
    if (!p || p.user_id !== u.id) fail(404, 'Post not found.');
    db.run("UPDATE posts SET status='removed' WHERE id=?", p.id);
    res.json({ ok: true });
  });

  // Offers. Coins can be added once the sender has at least `unlockAt` coins.
  r.post('/offers', (req, res) => {
    const u = requireUser(req); needConsent(u);
    const to = db.get("SELECT * FROM users WHERE id=? AND banned=0 AND status='active'", int(req.body.toUserId));
    if (!to || to.id === u.id) fail(400, 'Pick someone else to swap with.');
    const give = str(req.body.give, 120), get = str(req.body.get, 120), coins = int(req.body.coins) || 0;
    if (!give && !coins) fail(400, 'Say what you will give.');
    if (!get) fail(400, 'Say what you want in return.');
    if (coins < 0) fail(400, 'Coins must be positive.');
    if (coins) {
      needFeature(db, 'coins');
      const { unlockAt } = db.setting('coins');
      if (u.coins < unlockAt) fail(403, `You can add coins to deals once you have ${unlockAt.toLocaleString('en-IN')}.`, 'coins_locked');
      if (coins > u.coins) fail(400, "You don't have that many coins.");
    }
    const { lastInsertRowid: id } = db.run('INSERT INTO offers(from_id,to_id,post_id,give,get,coins) VALUES(?,?,?,?,?,?)',
      u.id, to.id, int(req.body.postId) || null, give || `${coins} coins`, get, coins);
    res.status(201).json({ id: Number(id), status: 'pending' });
  });
  r.get('/offers', (req, res) => {
    const u = requireUser(req);
    res.json(db.all('SELECT * FROM offers WHERE from_id=? OR to_id=? ORDER BY id DESC LIMIT 100', u.id, u.id));
  });
  const myOffer = (req, field) => {
    const u = requireUser(req);
    const o = db.get('SELECT * FROM offers WHERE id=?', req.params.id);
    if (!o || (field ? o[field] !== u.id : o.from_id !== u.id && o.to_id !== u.id)) fail(404, 'Offer not found.');
    return [u, o];
  };
  r.post('/offers/:id/accept', (req, res) => {
    const [, o] = myOffer(req, 'to_id');
    if (o.status !== 'pending') fail(409, 'This offer is no longer pending.');
    db.run("UPDATE offers SET status='accepted' WHERE id=?", o.id);
    res.json({ status: 'accepted' });
  });
  r.post('/offers/:id/decline', (req, res) => {
    const [, o] = myOffer(req, 'to_id');
    if (o.status !== 'pending') fail(409, 'This offer is no longer pending.');
    db.run("UPDATE offers SET status='declined' WHERE id=?", o.id);
    res.json({ status: 'declined' });
  });
  r.post('/offers/:id/complete', (req, res) => {
    const [, o] = myOffer(req);
    if (o.status !== 'accepted') fail(409, 'Only accepted offers can be completed.');
    const milestone = db.tx(() => {
      if (o.coins) {
        const from = db.get('SELECT coins FROM users WHERE id=?', o.from_id);
        if (from.coins < o.coins) fail(409, "The sender doesn't have enough coins any more.");
        db.coin(o.from_id, -o.coins, 'Used in a swap', `offer:${o.id}`);
        db.coin(o.to_id, o.coins, 'Received in a swap', `offer:${o.id}`);
      }
      db.run("UPDATE offers SET status='completed', completed_at=datetime('now') WHERE id=?", o.id);
      return onSwapCompleted(db, o.id);
    });
    const cfg = db.setting('impact');
    res.json({ status: 'completed', treesPledged: cfg.treesPerSwap, milestone: milestone ? { swaps: milestone, meals: cfg.mealsPerMilestone, cleanups: cfg.cleanupsPerMilestone } : null });
  });

  // A 5-star rating earns the rated member coins; +bonus when both are verified Women's Circle members.
  r.post('/offers/:id/rate', (req, res) => {
    const [u, o] = myOffer(req);
    if (o.status !== 'completed') fail(409, 'You can rate a swap once it is completed.');
    const stars = int(req.body.stars);
    if (!(stars >= 1 && stars <= 5)) fail(400, 'Stars must be 1 to 5.');
    const ratee = o.from_id === u.id ? o.to_id : o.from_id;
    if (db.get('SELECT 1 FROM ratings WHERE offer_id=? AND rater_id=?', o.id, u.id)) fail(409, "You've already rated this swap.");
    let earned = 0;
    db.tx(() => {
      db.run('INSERT INTO ratings(offer_id,rater_id,ratee_id,stars,note) VALUES(?,?,?,?,?)', o.id, u.id, ratee, stars, str(req.body.note, 300));
      if (stars === 5 && db.setting('features').coins) {
        const c = db.setting('coins');
        const other = db.get('SELECT circle_status FROM users WHERE id=?', ratee);
        db.coin(ratee, c.perFiveStar, `5-star swap with ${u.name}`, `offer:${o.id}`); earned = c.perFiveStar;
        if (db.setting('features').circle && other.circle_status === 'member' && u.circle_status === 'member') {
          db.coin(ratee, c.circleBonus, "Women's Circle bonus", `offer:${o.id}`); earned += c.circleBonus;
        }
      }
    });
    res.json({ ok: true, coinsAwarded: earned });
  });

  return r;
}
