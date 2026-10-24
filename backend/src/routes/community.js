// Events, groups, messages, calls, ads serving and reports.
import { Router } from 'express';
import { requireUser } from '../auth.js';
import { fail } from '../errors.js';
import { needAdult, needTier, needFeature, needConsent, SCAM_WORDS, str, int } from '../rules.js';

const REPORTABLE = ['post', 'user', 'message', 'auction', 'promo', 'campaign', 'event', 'group'];

export default function community(db) {
  const r = Router();

  // ---- events
  r.get('/events', (_req, res) => res.json(db.all(`SELECT e.*, (SELECT COUNT(*) FROM event_rsvps r WHERE r.event_id=e.id) going
    FROM events e WHERE status='active' ORDER BY starts_at LIMIT 100`)));
  r.post('/events', (req, res) => {
    needFeature(db, 'events');
    const u = requireUser(req); needConsent(u);
    const title = str(req.body.title, 80), starts = str(req.body.startsAt, 30);
    if (!title || Number.isNaN(Date.parse(starts))) fail(400, 'Add a title and a start date and time.');
    const kind = ['meet', 'fair', 'auction', 'workshop'].includes(req.body.kind) ? req.body.kind : 'meet';
    if (kind === 'auction') needAdult(u, 'Live auction events are hosted by members 18 and over.');
    const { lastInsertRowid: id } = db.run('INSERT INTO events(host_id,title,kind,starts_at,place,online,group_id,about) VALUES(?,?,?,?,?,?,?,?)',
      u.id, title, kind, new Date(starts).toISOString(), str(req.body.place, 120), !!req.body.online, int(req.body.groupId) || null, str(req.body.about, 1000));
    res.status(201).json({ id: Number(id) });
  });
  r.post('/events/:id/rsvp', (req, res) => {
    const u = requireUser(req);
    if (!db.get("SELECT 1 FROM events WHERE id=? AND status='active'", req.params.id)) fail(404, 'Event not found.');
    db.run('INSERT OR IGNORE INTO event_rsvps(event_id,user_id) VALUES(?,?)', req.params.id, u.id);
    res.json({ going: true });
  });

  // ---- groups
  r.get('/groups', (_req, res) => res.json(db.all(`SELECT g.*, (SELECT COUNT(*) FROM group_members m WHERE m.group_id=g.id) members
    FROM groups_ g WHERE status='active' ORDER BY members DESC LIMIT 100`)));
  r.post('/groups', (req, res) => {
    needFeature(db, 'groups');
    const u = requireUser(req); needConsent(u);
    const name = str(req.body.name, 60);
    if (!name) fail(400, 'Name your group.');
    const { lastInsertRowid: id } = db.run('INSERT INTO groups_(owner_id,name,emoji,cat,about) VALUES(?,?,?,?,?)',
      u.id, name, str(req.body.emoji, 8) || '👥', str(req.body.cat, 30) || null, str(req.body.about, 600));
    db.run('INSERT INTO group_members(group_id,user_id) VALUES(?,?)', id, u.id);
    res.status(201).json({ id: Number(id) });
  });
  r.post('/groups/:id/join', (req, res) => {
    const u = requireUser(req);
    if (!db.get("SELECT 1 FROM groups_ WHERE id=? AND status='active'", req.params.id)) fail(404, 'Group not found.');
    db.run('INSERT OR IGNORE INTO group_members(group_id,user_id) VALUES(?,?)', req.params.id, u.id);
    res.json({ joined: true });
  });

  // ---- messages (scam words are flagged for the sender and for moderators)
  r.get('/messages/:userId', (req, res) => {
    const u = requireUser(req), o = int(req.params.userId);
    res.json(db.all('SELECT * FROM messages WHERE (from_id=? AND to_id=?) OR (from_id=? AND to_id=?) ORDER BY id LIMIT 500', u.id, o, o, u.id));
  });
  r.post('/messages', (req, res) => {
    const u = requireUser(req); needConsent(u);
    const to = db.get("SELECT id FROM users WHERE id=? AND banned=0 AND status='active'", int(req.body.to));
    const body = str(req.body.body, 2000);
    if (!to || to.id === u.id) fail(400, 'Pick someone to message.');
    if (!body) fail(400, 'Type a message.');
    const flagged = SCAM_WORDS.test(body);
    const { lastInsertRowid: id } = db.run('INSERT INTO messages(from_id,to_id,body,flagged) VALUES(?,?,?,?)', u.id, to.id, body, flagged);
    res.status(201).json({ id: Number(id), warning: flagged ? 'Careful. Never share OTPs or pay anyone outside the app.' : null });
  });

  // ---- calls (Pro Plus, adults only, and never with a teen). Signalling goes to a WebRTC provider.
  r.post('/calls', (req, res) => {
    needFeature(db, 'calls');
    const u = requireUser(req);
    needAdult(u, 'Voice and video calls are for members 18 and over.');
    needTier(u, 'plus', 'Voice and video calls with your swap partners are part of Pro Plus.');
    const to = db.get("SELECT id,dob FROM users WHERE id=? AND banned=0 AND status='active'", int(req.body.to));
    if (!to || to.id === u.id) fail(400, 'Pick someone to call.');
    const adultAge = db.setting('limits').adultAge;
    const toAge = (Date.now() - Date.parse(to.dob + 'T00:00:00Z')) / (365.2425 * 86400000);
    if (toAge < adultAge) fail(403, "Calls aren't available with this member.", 'callee_teen');
    const kind = req.body.kind === 'video' ? 'video' : 'voice';
    const { lastInsertRowid: id } = db.run('INSERT INTO calls(caller_id,callee_id,kind) VALUES(?,?,?)', u.id, to.id, kind);
    res.status(201).json({ id: Number(id), kind, status: 'ringing' });
  });
  r.post('/calls/:id/end', (req, res) => {
    const u = requireUser(req);
    const c = db.get('SELECT * FROM calls WHERE id=? AND (caller_id=? OR callee_id=?)', req.params.id, u.id, u.id);
    if (!c) fail(404, 'Call not found.');
    if (c.status === 'ended') return res.json({ seconds: c.seconds });
    const secs = Math.max(0, Math.round((Date.now() - Date.parse(c.started_at + 'Z')) / 1000));
    db.run("UPDATE calls SET status='ended', ended_at=datetime('now'), seconds=? WHERE id=?", secs, c.id);
    res.json({ seconds: secs });
  });

  // ---- ads: serving (never to teens), clicks, and advertiser campaigns (reviewed before going live)
  r.get('/ads/next', (req, res) => {
    if (!db.setting('features').ads || (req.user && !req.user.adult)) return res.json({ ad: null });
    const placement = str(req.query.placement, 10);
    const cpm = db.setting('ads').cpm[placement];
    if (!cpm) fail(400, 'Unknown placement.');
    const ad = db.get("SELECT id,business,headline,cta,image_url,link,placement,impressions,budget FROM campaigns WHERE status='active' AND placement=? ORDER BY RANDOM() LIMIT 1", placement);
    if (!ad) return res.json({ ad: null });
    db.run('UPDATE campaigns SET impressions=impressions+1 WHERE id=?', ad.id);
    if (((ad.impressions + 1) * cpm) / 1000 >= ad.budget) db.run("UPDATE campaigns SET status='ended' WHERE id=?", ad.id);
    const { impressions, budget, ...pub } = ad;
    res.json({ ad: { ...pub, label: 'Sponsored' } });
  });
  r.post('/ads/:id/click', (req, res) => { db.run('UPDATE campaigns SET clicks=clicks+1 WHERE id=?', req.params.id); res.json({ ok: true }); });
  r.get('/campaigns', (req, res) => {
    const u = requireUser(req), cpm = db.setting('ads').cpm;
    res.json(db.all('SELECT * FROM campaigns WHERE owner_id=? ORDER BY id DESC', u.id).map(c => ({ ...c, spent: Math.round(c.impressions * cpm[c.placement] / 1000) })));
  });
  r.post('/campaigns', (req, res) => {
    needFeature(db, 'ads');
    const u = requireUser(req);
    needAdult(u, 'Advertising accounts are for members 18 and over.');
    const business = str(req.body.business, 80), headline = str(req.body.headline, 90), budget = int(req.body.budget);
    if (!business || !headline) fail(400, 'Add the business name and a headline.');
    if (!(budget >= 500)) fail(400, 'The minimum budget is ₹500.');
    if (!(req.body.placement in db.setting('ads').cpm)) fail(400, 'Pick a placement: feed, story, side or auction.');
    const { lastInsertRowid: id } = db.run('INSERT INTO campaigns(owner_id,business,headline,cta,image_url,link,placement,area,budget) VALUES(?,?,?,?,?,?,?,?,?)',
      u.id, business, headline, str(req.body.cta, 30) || 'Learn more', str(req.body.imageUrl, 500) || null, str(req.body.link, 500) || null, req.body.placement, str(req.body.area, 60) || null, budget);
    res.status(201).json({ id: Number(id), status: 'pending', note: 'Every ad is reviewed before it runs.' });
  });
  r.patch('/campaigns/:id', (req, res) => {
    const u = requireUser(req);
    const c = db.get('SELECT * FROM campaigns WHERE id=? AND owner_id=?', req.params.id, u.id);
    if (!c) fail(404, 'Campaign not found.');
    const to = req.body.status;
    if (!((c.status === 'active' && to === 'paused') || (c.status === 'paused' && to === 'active'))) fail(409, 'You can pause or resume an approved campaign.');
    db.run('UPDATE campaigns SET status=? WHERE id=?', to, c.id);
    res.json({ status: to });
  });

  // ---- reports
  r.post('/reports', (req, res) => {
    const u = requireUser(req);
    if (!REPORTABLE.includes(req.body.targetType)) fail(400, 'Unknown report target.');
    const reason = str(req.body.reason, 500);
    if (!reason) fail(400, 'Tell us what is wrong.');
    const { lastInsertRowid: id } = db.run('INSERT INTO reports(reporter_id,target_type,target_id,reason) VALUES(?,?,?,?)', u.id, req.body.targetType, int(req.body.targetId), reason);
    res.status(201).json({ id: Number(id), note: "Thanks for reporting. Our team will review it." });
  });

  return r;
}
