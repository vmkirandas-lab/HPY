// Pro Plus creator studio: free lucky draws, giveaways, challenges, mystery boxes and videos.
// Draws are always free to enter (Lotteries (Regulation) Act 1998): no price, fee or coins anywhere.
import { Router } from 'express';
import crypto from 'node:crypto';
import { requireUser } from '../auth.js';
import { fail } from '../errors.js';
import { needAdult, needTier, needFeature, str, int } from '../rules.js';

const KINDS = ['draw', 'giveaway', 'challenge', 'box', 'video'];
const PAID_KEYS = /price|fee|cost|coins|ticket|payment|entry_?fee/i;

// Pick winners with a CSPRNG, without replacement. Records how many entries there were.
export function pickWinners(db, promo, actorId) {
  if (!['draw', 'giveaway'].includes(promo.kind)) fail(400, 'Only draws and giveaways are picked at random.');
  if (promo.status !== 'live') fail(409, 'Winners have already been picked.');
  const pool = db.all('SELECT user_id FROM promo_entries WHERE promo_id=?', promo.id).map(e => e.user_id);
  const entries = pool.length, want = Math.min(entries, JSON.parse(promo.details).winners || 1), winners = [];
  while (winners.length < want) winners.push(pool.splice(crypto.randomInt(pool.length), 1)[0]);
  db.run("UPDATE promos SET status='closed', winners=? WHERE id=?", JSON.stringify(winners), promo.id);
  db.audit(actorId, 'promo.draw', `promo:${promo.id}`, { entries, winners });
  return winners;
}

export default function studio(db) {
  const r = Router();

  r.get('/promos', (req, res) => {
    const kind = str(req.query.kind, 20);
    const rows = db.all(`SELECT p.*, u.handle, (SELECT COUNT(*) FROM promo_entries e WHERE e.promo_id=p.id) entries
      FROM promos p JOIN users u ON u.id=p.user_id WHERE p.status<>'removed' AND (?='' OR p.kind=?) ORDER BY p.id DESC LIMIT 100`, kind, kind);
    res.json(rows.map(p => ({ ...p, details: JSON.parse(p.details), winners: p.winners ? JSON.parse(p.winners) : null })));
  });

  r.post('/promos', (req, res) => {
    needFeature(db, 'studio');
    const u = requireUser(req);
    needAdult(u, 'The creator studio is for members 18 and over.');
    needTier(u, 'plus', 'The full creator studio is part of Pro Plus.');
    const kind = req.body.kind, d = req.body.details || {}, limits = db.setting('limits');
    if (!KINDS.includes(kind)) fail(400, 'Unknown studio type.');
    if (kind !== 'video') needFeature(db, 'draws');
    if (Object.keys(d).some(k => PAID_KEYS.test(k))) fail(400, 'Draws, giveaways, challenges and boxes must be free to enter. Remove any price or fee.', 'paid_entry');
    const title = str(req.body.title, 80);
    if (!title) fail(400, kind === 'video' ? 'Add a title.' : 'Add a title or prize.');
    let details;
    if (kind === 'draw') {
      const how = Array.isArray(d.how) ? d.how.filter(h => ['follow', 'comment', 'share'].includes(h)) : [];
      if (!how.length) fail(400, 'Pick at least one free way to enter.');
      details = { winners: Math.min(10, Math.max(1, int(d.winners) || 1)), how };
    } else if (kind === 'giveaway') details = { winners: 1, pick: ['random', 'best_reason', 'first'].includes(d.pick) ? d.pick : 'random' };
    else if (kind === 'challenge') {
      if (!str(d.task) || !str(d.prize, 120)) fail(400, 'Say what people should do and what the prize is.');
      details = { task: str(d.task, 600), prize: str(d.prize, 120), judge: d.judge === 'host' ? 'host' : 'votes' };
    } else if (kind === 'box') {
      if (!(int(d.minValue) >= limits.boxMinValue)) fail(400, `Set a minimum value of at least ₹${limits.boxMinValue}.`);
      if (!(int(d.items) >= 1)) fail(400, 'Say how many items are inside.');
      if (d.confirm !== true) fail(400, 'Please confirm the box contents are legal and worth at least the minimum value.');
      details = { minValue: int(d.minValue), items: int(d.items), left: Math.max(1, int(d.left) || 1), swapFor: str(d.swapFor, 120) || `Any item worth ₹${int(d.minValue)} or more` };
    } else {
      const secs = Number(d.durationSec);
      if (!(secs > 0)) fail(400, 'Video duration is missing.');
      if (secs > limits.videoMaxSeconds) fail(400, `Videos can be up to ${limits.videoMaxSeconds / 60}:00.`, 'video_too_long');
      if (!str(d.url, 500)) fail(400, 'Upload the video first.');
      details = { url: str(d.url, 500), durationSec: Math.round(secs) }; // re-check duration with ffprobe after upload in production
    }
    const days = [1, 3, 7].includes(int(req.body.endsInDays)) ? int(req.body.endsInDays) : 3;
    const { lastInsertRowid: id } = db.run('INSERT INTO promos(user_id,kind,title,cat,caption,details,ends_at) VALUES(?,?,?,?,?,?,?)',
      u.id, kind, title, str(req.body.cat, 30) || null, str(req.body.caption, 1000), JSON.stringify(details),
      kind === 'video' ? null : new Date(Date.now() + days * 86400000).toISOString());
    db.audit(u.id, 'promo.create', `promo:${id}`, { kind });
    res.status(201).json({ id: Number(id) });
  });

  r.post('/promos/:id/enter', (req, res) => {
    needFeature(db, 'draws');
    const u = requireUser(req);
    needAdult(u, 'Draws, giveaways, challenges and the Mystery Box are for members 18 and over.');
    const out = db.tx(() => {
      const p = db.get('SELECT * FROM promos WHERE id=?', req.params.id);
      if (!p || p.kind === 'video' || p.status !== 'live') fail(409, 'This is closed.');
      if (p.ends_at && new Date(p.ends_at) < new Date()) fail(409, 'This has ended.');
      if (p.user_id === u.id) fail(403, "You can't enter your own.");
      if (db.get('SELECT 1 FROM promo_entries WHERE promo_id=? AND user_id=?', p.id, u.id)) fail(409, "You're already in.");
      if (p.kind === 'box') {
        const d = JSON.parse(p.details);
        if (d.left < 1) fail(409, 'No boxes left.');
        if (!str(req.body.note, 200)) fail(400, 'Say which item you will swap for the box.');
        d.left -= 1; db.run('UPDATE promos SET details=? WHERE id=?', JSON.stringify(d), p.id);
      }
      db.run('INSERT INTO promo_entries(promo_id,user_id,note) VALUES(?,?,?)', p.id, u.id, str(req.body.note, 200) || null);
      return { ok: true };
    });
    res.status(201).json(out);
  });

  r.post('/promos/:id/draw', (req, res) => {
    const u = requireUser(req);
    const p = db.get('SELECT * FROM promos WHERE id=?', req.params.id);
    if (!p || p.user_id !== u.id) fail(404, 'Not found.');
    if (p.ends_at && new Date(p.ends_at) > new Date()) fail(409, 'You can pick winners after it ends.');
    res.json({ winners: pickWinners(db, p, u.id) });
  });

  return r;
}
