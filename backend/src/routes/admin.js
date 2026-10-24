// Control Center API. Moderators handle trust & safety; admins also control money, roles and settings.
// Every change is written to the audit log.
import { Router } from 'express';
import { requireStaff } from '../auth.js';
import { fail } from '../errors.js';
import { DEFAULT_SETTINGS } from '../db.js';
import { ageOf, str, int, nowIso, addMin } from '../rules.js';
import { closeExpired, auctionView } from './auctions.js';
import { pickWinners } from './studio.js';
import { impactSummary } from './impact.js';

const TARGET = { // report target → table, owner column, value that removes it
  post: ['posts', 'user_id', 'removed'], auction: ['auctions', 'seller_id', 'cancelled'], promo: ['promos', 'user_id', 'removed'],
  campaign: ['campaigns', 'owner_id', 'rejected'], event: ['events', 'host_id', 'removed'], group: ['groups_', 'owner_id', 'removed'],
  message: ['messages', 'from_id', null], user: ['users', 'id', null],
};
const page = req => [Math.min(200, int(req.query.limit) || 50), Math.max(0, int(req.query.offset) || 0)];

export default function admin(db) {
  const r = Router();
  r.use((req, _res, next) => { requireStaff(req); next(); });

  r.get('/stats', (_req, res) => {
    closeExpired(db);
    const n = sql => db.get(sql).n;
    const cpm = db.setting('ads').cpm;
    const adRev = db.all('SELECT placement, impressions FROM campaigns').reduce((s, c) => s + c.impressions * cpm[c.placement] / 1000, 0);
    const plans = db.setting('plans');
    res.json({
      users: n('SELECT COUNT(*) n FROM users'), teens: db.all('SELECT dob FROM users').filter(u => ageOf(u.dob) < 18).length,
      banned: n('SELECT COUNT(*) n FROM users WHERE banned=1'), pro: n("SELECT COUNT(*) n FROM users WHERE tier='pro'"), plus: n("SELECT COUNT(*) n FROM users WHERE tier='plus'"),
      mrr: n("SELECT COUNT(*) n FROM users WHERE tier='pro'") * plans.pro + n("SELECT COUNT(*) n FROM users WHERE tier='plus'") * plans.plus,
      posts: n("SELECT COUNT(*) n FROM posts WHERE status='active'"), swapsCompleted: n("SELECT COUNT(*) n FROM offers WHERE status='completed'"),
      auctionsLive: n("SELECT COUNT(*) n FROM auctions WHERE status='live'"), auctionsPending: n("SELECT COUNT(*) n FROM auctions WHERE status='pending'"),
      auctionsSold: n("SELECT COUNT(*) n FROM auctions WHERE status='sold'"), gmv: db.get("SELECT COALESCE(SUM(final_price),0) n FROM auctions WHERE status='sold'").n,
      coinsInCirculation: db.get('SELECT COALESCE(SUM(coins),0) n FROM users').n, coinsIssued: db.get('SELECT COALESCE(SUM(delta),0) n FROM coin_ledger WHERE delta>0').n,
      circlePending: n("SELECT COUNT(*) n FROM users WHERE circle_status='pending'"), circleMembers: n("SELECT COUNT(*) n FROM users WHERE circle_status='member'"),
      consentPending: db.all('SELECT dob,guardian_consent FROM users').filter(u => ageOf(u.dob) < 18 && !u.guardian_consent).length,
      reportsOpen: n("SELECT COUNT(*) n FROM reports WHERE status='open'"), flaggedMessages: n('SELECT COUNT(*) n FROM messages WHERE flagged=1'),
      promosLive: n("SELECT COUNT(*) n FROM promos WHERE status='live'"), campaignsPending: n("SELECT COUNT(*) n FROM campaigns WHERE status='pending'"),
      campaignsActive: n("SELECT COUNT(*) n FROM campaigns WHERE status='active'"), adRevenue: Math.round(adRev),
      events: n("SELECT COUNT(*) n FROM events WHERE status='active'"), groups: n("SELECT COUNT(*) n FROM groups_ WHERE status='active'"),
      calls: n('SELECT COUNT(*) n FROM calls'),
      brandsPending: n("SELECT COUNT(*) n FROM brands WHERE status='pending'"), brandsVerified: n("SELECT COUNT(*) n FROM brands WHERE status='verified'"),
      kycPending: n("SELECT COUNT(*) n FROM users WHERE kyc_status='pending'"), exclusiveLive: n("SELECT COUNT(*) n FROM auctions WHERE status='live' AND brand_id IS NOT NULL"),
      treesOwed: (() => { const s = impactSummary(db); return Math.max(0, s.trees.pledged - s.trees.planted); })(),
    });
  });

  // ---- users
  r.get('/users', (req, res) => {
    const q = `%${str(req.query.q, 60)}%`, f = str(req.query.filter, 20), [lim, off] = page(req);
    const where = { closing: "status<>'active'", banned: 'banned=1', staff: "role<>'user'", circle: "circle_status='pending'", kyc: "kyc_status='pending'", paid: "tier<>'free'" }[f] || '1=1';
    const rows = db.all(`SELECT id,handle,name,email,email_verified,phone,id_verified,id_method,id_last4,welcome_bonus,status,delete_after,dob,role,tier,tier_until,verified,banned,ban_reason,guardian_contact,guardian_consent,circle_status,kyc_status,coins,trust,strikes,created_at
      FROM users WHERE ${where} AND (handle LIKE ? OR name LIKE ? OR email LIKE ?) ORDER BY id DESC LIMIT ? OFFSET ?`, q, q, q, lim, off);
    res.json(rows.map(u => ({ ...u, age: ageOf(u.dob) })));
  });
  r.get('/users/:id', (req, res) => {
    const u = db.get('SELECT * FROM users WHERE id=?', req.params.id);
    if (!u) fail(404, 'User not found.');
    delete u.pass_hash;
    res.json({ ...u, age: ageOf(u.dob),
      ledger: db.all('SELECT * FROM coin_ledger WHERE user_id=? ORDER BY id DESC LIMIT 50', u.id),
      reports: db.all("SELECT * FROM reports WHERE target_type='user' AND target_id=? ORDER BY id DESC", u.id),
      posts: db.all('SELECT id,type,title,status,created_at FROM posts WHERE user_id=? ORDER BY id DESC LIMIT 50', u.id),
      auctions: db.all('SELECT id,item,fmt,status FROM auctions WHERE seller_id=? ORDER BY id DESC LIMIT 50', u.id) });
  });
  r.patch('/users/:id', (req, res) => {
    const staff = req.user, u = db.get('SELECT * FROM users WHERE id=?', req.params.id);
    if (!u) fail(404, 'User not found.');
    const b = req.body, set = {};
    const MOD = ['verified', 'banned', 'ban_reason', 'guardian_consent', 'circle_status', 'kyc_status'];
    const ADMIN = [...MOD, 'role', 'tier', 'tier_until', 'trust', 'strikes'];
    for (const k of Object.keys(b)) {
      if (!ADMIN.includes(k)) fail(400, `Unknown field: ${k}`);
      if (!MOD.includes(k) && staff.role !== 'admin') fail(403, `Only admins can change ${k}.`);
      set[k] = b[k];
    }
    if (u.id === staff.id && ('role' in set || set.banned)) fail(400, "You can't change your own role or ban yourself.");
    if (set.tier && set.tier !== 'free' && ageOf(u.dob) < 18) fail(400, 'Paid plans are for members 18 and over.');
    if (set.tier && set.tier !== 'free' && !('tier_until' in set)) set.tier_until = addMin(nowIso(), 30 * 1440);
    if ('role' in set && !['user', 'moderator', 'admin'].includes(set.role)) fail(400, 'Bad role.');
    if ('circle_status' in set && !['none', 'pending', 'member', 'rejected'].includes(set.circle_status)) fail(400, 'Bad Circle status.');
    if ('kyc_status' in set && !['none', 'pending', 'verified', 'rejected'].includes(set.kyc_status)) fail(400, 'Bad KYC status.');
    if (set.kyc_status === 'verified' && ageOf(u.dob) < db.setting('limits').bidAge) fail(400, `Verified bidders must be ${db.setting('limits').bidAge} or over.`);
    if ('trust' in set) set.trust = Math.max(0, Math.min(100, int(set.trust)));
    if (set.banned === false || set.banned === 0) set.ban_reason = null;
    const keys = Object.keys(set);
    if (!keys.length) fail(400, 'Nothing to change.');
    db.run(`UPDATE users SET ${keys.map(k => `${k}=?`).join(',')} WHERE id=?`, ...keys.map(k => set[k]), u.id);
    db.audit(staff.id, 'user.update', `user:${u.id}`, set);
    res.json({ ok: true });
  });
  r.post('/users/:id/coins', (req, res) => {
    requireStaff(req, 'admin');
    const u = db.get('SELECT id,coins FROM users WHERE id=?', req.params.id), delta = int(req.body.delta), reason = str(req.body.reason, 200);
    if (!u) fail(404, 'User not found.');
    if (!delta || !reason) fail(400, 'Give a non-zero amount and a reason.');
    if (u.coins + delta < 0) fail(400, "Balance can't go below zero.");
    db.tx(() => db.coin(u.id, delta, `Adjustment: ${reason}`, 'admin', req.user.id));
    db.audit(req.user.id, 'coins.adjust', `user:${u.id}`, { delta, reason });
    res.json({ balance: u.coins + delta });
  });

  // ---- reports & moderation
  r.get('/reports', (req, res) => {
    const st = str(req.query.status, 12) || 'open';
    res.json(db.all(`SELECT r.*, u.handle reporter FROM reports r JOIN users u ON u.id=r.reporter_id WHERE r.status=? ORDER BY r.id DESC LIMIT 200`, st));
  });
  r.post('/reports/:id/resolve', (req, res) => {
    const rep = db.get('SELECT * FROM reports WHERE id=?', req.params.id);
    if (!rep) fail(404, 'Report not found.');
    if (rep.status !== 'open') fail(409, 'This report is already handled.');
    const action = req.body.action, note = str(req.body.note, 300);
    if (!['dismiss', 'remove', 'ban', 'warn'].includes(action)) fail(400, 'Action must be dismiss, remove, warn or ban.');
    const [table, ownerCol, removed] = TARGET[rep.target_type] || [];
    db.tx(() => {
      const target = table && db.get(`SELECT * FROM ${table} WHERE id=?`, rep.target_id);
      if (action !== 'dismiss' && !target) fail(404, 'The reported item no longer exists.');
      if (action === 'remove') {
        if (!removed) fail(400, rep.target_type === 'user' ? 'Use ban for accounts.' : 'This item type can only be dismissed, warned or banned.');
        db.run(`UPDATE ${table} SET status=? WHERE id=?`, removed, rep.target_id);
      }
      if (action === 'ban') db.run('UPDATE users SET banned=1, ban_reason=? WHERE id=?', note || 'Community Guidelines', target[ownerCol]);
      if (action === 'warn') db.run('UPDATE users SET trust=MAX(0,trust-10) WHERE id=?', target[ownerCol]);
      db.run("UPDATE reports SET status=?, resolution=?, handled_by=?, handled_at=datetime('now') WHERE id=?",
        action === 'dismiss' ? 'dismissed' : 'resolved', `${action}${note ? ': ' + note : ''}`, req.user.id, rep.id);
    });
    db.audit(req.user.id, `report.${action}`, `${rep.target_type}:${rep.target_id}`, { report: rep.id, note });
    res.json({ ok: true });
  });
  r.get('/messages/flagged', (_req, res) => res.json(db.all(`SELECT m.*, f.handle from_handle, t.handle to_handle FROM messages m
    JOIN users f ON f.id=m.from_id JOIN users t ON t.id=m.to_id WHERE flagged=1 ORDER BY m.id DESC LIMIT 200`)));

  // ---- content lists with status changes (posts, promos, events, groups, campaigns)
  const lists = {
    posts: ['SELECT p.id,p.type,p.title,p.cat,p.status,p.created_at,u.handle FROM posts p JOIN users u ON u.id=p.user_id', ['active', 'removed']],
    promos: [`SELECT p.id,p.kind,p.title,p.status,p.ends_at,p.winners,p.details,u.handle,(SELECT COUNT(*) FROM promo_entries e WHERE e.promo_id=p.id) entries
      FROM promos p JOIN users u ON u.id=p.user_id`, ['live', 'closed', 'removed']],
    events: ['SELECT e.id,e.title,e.kind,e.starts_at,e.status,u.handle FROM events e JOIN users u ON u.id=e.host_id', ['active', 'cancelled', 'removed']],
    groups: [`SELECT g.id,g.name,g.cat,g.status,u.handle,(SELECT COUNT(*) FROM group_members m WHERE m.group_id=g.id) members FROM groups_ g JOIN users u ON u.id=g.owner_id`, ['active', 'removed']],
    campaigns: ['SELECT c.*, u.handle FROM campaigns c JOIN users u ON u.id=c.owner_id', ['pending', 'active', 'paused', 'rejected', 'ended']],
  };
  const tableOf = { posts: 'posts', promos: 'promos', events: 'events', groups: 'groups_', campaigns: 'campaigns' };
  for (const [name, [sql, statuses]] of Object.entries(lists)) {
    const alias = name[0] === 'g' ? 'g' : name[0] === 'c' ? 'c' : name[0] === 'e' ? 'e' : 'p';
    r.get(`/${name}`, (req, res) => {
      const st = str(req.query.status, 12), [lim, off] = page(req);
      res.json(db.all(`${sql} WHERE (?='' OR ${alias}.status=?) ORDER BY ${alias}.id DESC LIMIT ? OFFSET ?`, st, st, lim, off));
    });
    r.patch(`/${name}/:id`, (req, res) => {
      const st = req.body.status;
      if (!statuses.includes(st)) fail(400, `Status must be one of: ${statuses.join(', ')}`);
      const { changes } = db.run(`UPDATE ${tableOf[name]} SET status=?${name === 'campaigns' ? ', review_note=COALESCE(?,review_note)' : ''} WHERE id=?`,
        ...(name === 'campaigns' ? [st, str(req.body.note, 300) || null] : [st]), req.params.id);
      if (!changes) fail(404, 'Not found.');
      db.audit(req.user.id, `${name.slice(0, -1)}.status`, `${name}:${req.params.id}`, { status: st });
      res.json({ ok: true });
    });
  }
  r.post('/promos/:id/draw', (req, res) => {
    const p = db.get('SELECT * FROM promos WHERE id=?', req.params.id);
    if (!p) fail(404, 'Not found.');
    const ids = pickWinners(db, p, req.user.id);
    res.json({ winners: ids.map(id => db.get('SELECT id,handle,name FROM users WHERE id=?', id)) });
  });

  // ---- auctions: verification queue, cancel, escrow status
  r.get('/auctions', (req, res) => {
    closeExpired(db);
    const st = str(req.query.status, 12) || 'pending';
    res.json(db.all(`SELECT a.*, u.handle seller FROM auctions a JOIN users u ON u.id=a.seller_id WHERE a.status=? ORDER BY a.id DESC LIMIT 200`, st)
      .map(a => ({ ...auctionView(db, a, null), reserve: a.reserve, seller: a.seller })));
  });
  r.post('/auctions/:id/verify', (req, res) => {
    const a = db.get('SELECT * FROM auctions WHERE id=?', req.params.id);
    if (!a) fail(404, 'Not found.');
    if (a.status !== 'pending') fail(409, 'Only pending auctions can be verified.');
    const ok = req.body.approve === true, note = str(req.body.note, 300);
    if (!ok && !note) fail(400, 'Give the seller a reason for rejecting.');
    const start = nowIso();
    db.run('UPDATE auctions SET status=?, verify_note=?, starts_at=?, ends_at=? WHERE id=?', ok ? 'live' : 'rejected', note || null,
      ok ? start : null, ok ? addMin(start, a.duration_min) : null, a.id);
    db.audit(req.user.id, ok ? 'auction.approve' : 'auction.reject', `auction:${a.id}`, { note });
    res.json({ status: ok ? 'live' : 'rejected' });
  });
  r.post('/auctions/:id/cancel', (req, res) => {
    const reason = str(req.body.reason, 300);
    if (!reason) fail(400, 'Give a reason.');
    const { changes } = db.run("UPDATE auctions SET status='cancelled', verify_note=? WHERE id=? AND status IN ('pending','live')", reason, req.params.id);
    if (!changes) fail(409, 'Only pending or live auctions can be cancelled.');
    db.audit(req.user.id, 'auction.cancel', `auction:${req.params.id}`, { reason });
    res.json({ ok: true });
  });
  r.post('/auctions/:id/escrow', (req, res) => {
    requireStaff(req, 'admin');
    const st = req.body.escrow;
    if (!['awaiting_payment', 'paid', 'released', 'refunded', 'disputed'].includes(st)) fail(400, 'Bad escrow status.');
    const a = db.get("SELECT * FROM auctions WHERE id=? AND status='sold'", req.params.id);
    if (!a) fail(404, 'Sold auction not found.');
    db.run('UPDATE auctions SET escrow=? WHERE id=?', st, a.id);
    if (st === 'refunded' && req.body.strike) db.run('UPDATE users SET strikes=strikes+1 WHERE id=?', a.winner_id);
    db.audit(req.user.id, 'auction.escrow', `auction:${a.id}`, { escrow: st });
    res.json({ ok: true });
  });

  // ---- Swap Exclusive brands: verification queue and status changes
  r.get('/brands', (req, res) => {
    const st = str(req.query.status, 12) || 'pending';
    res.json(db.all(`SELECT b.*, u.handle owner, (SELECT COUNT(*) FROM auctions a WHERE a.brand_id=b.id) auctions,
      (SELECT COALESCE(SUM(final_price),0) FROM auctions a WHERE a.brand_id=b.id AND a.status='sold') sales FROM brands b JOIN users u ON u.id=b.owner_id WHERE b.status=? ORDER BY b.id DESC`, st));
  });
  r.patch('/brands/:id', (req, res) => {
    const b = db.get('SELECT * FROM brands WHERE id=?', req.params.id);
    if (!b) fail(404, 'Brand not found.');
    const st = req.body.status, note = str(req.body.note, 300);
    if (!['verified', 'rejected', 'suspended', 'pending'].includes(st)) fail(400, 'Status must be verified, rejected, suspended or pending.');
    if ((st === 'rejected' || st === 'suspended') && !note) fail(400, 'Give the brand a reason.');
    db.tx(() => {
      db.run("UPDATE brands SET status=?, review_note=?, verified_at=CASE WHEN ?='verified' THEN datetime('now') ELSE verified_at END WHERE id=?", st, note || null, st, b.id);
      if (st === 'suspended') db.run("UPDATE auctions SET status='cancelled', verify_note=? WHERE brand_id=? AND status IN ('pending','live')", 'Brand suspended: ' + note, b.id);
    });
    db.audit(req.user.id, `brand.${st}`, `brand:${b.id}`, { note });
    res.json({ ok: true });
  });

  // ---- Swap Green: what's pledged vs delivered, and recording delivered batches with proof
  r.get('/impact', (_req, res) => {
    const s = impactSummary(db);
    res.json({ ...s, owed: { trees: Math.max(0, s.trees.pledged - s.trees.planted), meals: Math.max(0, s.meals.pledged - s.meals.funded), cleanups: Math.max(0, s.cleanups.pledged - s.cleanups.done) },
      batches: db.all('SELECT b.*, u.handle recorded_by FROM impact_batches b LEFT JOIN users u ON u.id=b.created_by ORDER BY b.happened_on DESC, b.id DESC LIMIT 200') });
  });
  r.post('/impact/batches', (req, res) => {
    requireStaff(req, 'admin');
    const kind = req.body.kind, qty = int(req.body.qty), partner = str(req.body.partner, 120), location = str(req.body.location, 120);
    const proof = str(req.body.proofUrl, 500), on = str(req.body.happenedOn, 10);
    if (!['planting', 'meals', 'cleanup'].includes(kind)) fail(400, 'Kind must be planting, meals or cleanup.');
    if (!(qty > 0)) fail(400, kind === 'cleanup' ? 'Enter the kilograms collected.' : 'Enter how many trees or meals.');
    if (!partner || !location) fail(400, 'Add the partner and the location.');
    if (!/^https?:\/\//.test(proof)) fail(400, 'Add a link to the proof: receipts, geo-tagged photos or the partner report.');
    if (Number.isNaN(Date.parse(on)) || new Date(on) > new Date()) fail(400, 'Use the date it happened (YYYY-MM-DD), not a future date.');
    const { lastInsertRowid: id } = db.run('INSERT INTO impact_batches(kind,qty,partner,location,proof_url,happened_on,note,created_by) VALUES(?,?,?,?,?,?,?,?)',
      kind, qty, partner, location, proof, on, str(req.body.note, 300) || null, req.user.id);
    db.audit(req.user.id, 'impact.batch', `impact:${id}`, { kind, qty, partner, location });
    res.status(201).json({ id: Number(id) });
  });

  // ---- coins, calls, audit
  r.get('/ledger', (req, res) => { const [lim, off] = page(req); res.json(db.all(`SELECT l.*, u.handle FROM coin_ledger l JOIN users u ON u.id=l.user_id ORDER BY l.id DESC LIMIT ? OFFSET ?`, lim, off)); });
  r.get('/calls', (_req, res) => res.json(db.all(`SELECT c.*, a.handle caller, b.handle callee FROM calls c JOIN users a ON a.id=c.caller_id JOIN users b ON b.id=c.callee_id ORDER BY c.id DESC LIMIT 200`)));
  r.get('/audit', (req, res) => { const [lim, off] = page(req); res.json(db.all(`SELECT l.*, u.handle actor FROM audit_log l LEFT JOIN users u ON u.id=l.actor_id ORDER BY l.id DESC LIMIT ? OFFSET ?`, lim, off)); });

  // ---- settings (admins only): feature switches, maintenance, prices, fees, coin rules, limits, ad CPMs, categories
  r.get('/settings', (_req, res) => res.json(Object.fromEntries(Object.keys(DEFAULT_SETTINGS).map(k => [k, db.setting(k)]))));
  r.put('/settings/:key', (req, res) => {
    requireStaff(req, 'admin');
    const k = req.params.key, def = DEFAULT_SETTINGS[k], v = req.body.value;
    if (!def) fail(404, 'Unknown setting.');
    const shapeOk = (d, x) => Array.isArray(d) ? Array.isArray(x) && x.every(i => typeof i === 'string' && i.trim())
      : typeof d === 'object' ? x && typeof x === 'object' && !Array.isArray(x) && Object.keys(d).every(key => key in x && shapeOk(d[key], x[key]))
      : typeof d === typeof x && (typeof x !== 'number' || (Number.isFinite(x) && x >= 0));
    if (!shapeOk(def, v)) fail(400, 'That value does not match the expected shape.');
    db.setSetting(k, v);
    db.audit(req.user.id, 'settings.update', `settings:${k}`, v);
    res.json({ ok: true });
  });

  return r;
}
