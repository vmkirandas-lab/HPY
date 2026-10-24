// SQLite storage (Node's built-in node:sqlite). One file, no server to run.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY, handle TEXT UNIQUE NOT NULL, name TEXT NOT NULL, email TEXT UNIQUE,
  pass_hash TEXT NOT NULL, dob TEXT NOT NULL, gender TEXT, area TEXT DEFAULT '', bio TEXT DEFAULT '',
  role TEXT NOT NULL DEFAULT 'user' CHECK(role IN ('user','moderator','admin')),
  tier TEXT NOT NULL DEFAULT 'free' CHECK(tier IN ('free','pro','plus')), tier_until TEXT,
  verified INTEGER NOT NULL DEFAULT 0, banned INTEGER NOT NULL DEFAULT 0, ban_reason TEXT,
  guardian_contact TEXT, guardian_consent INTEGER NOT NULL DEFAULT 0,
  circle_status TEXT NOT NULL DEFAULT 'none' CHECK(circle_status IN ('none','pending','member','rejected')),
  coins INTEGER NOT NULL DEFAULT 0, trust INTEGER NOT NULL DEFAULT 50, strikes INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS posts(
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id),
  type TEXT NOT NULL CHECK(type IN ('item','iso','done','tip')), cat TEXT, title TEXT NOT NULL, body TEXT DEFAULT '',
  want TEXT, cond TEXT, value INTEGER, media_url TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','removed')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS offers(
  id INTEGER PRIMARY KEY, from_id INTEGER NOT NULL REFERENCES users(id), to_id INTEGER NOT NULL REFERENCES users(id),
  post_id INTEGER REFERENCES posts(id), give TEXT NOT NULL, get TEXT NOT NULL, coins INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','accepted','declined','completed','cancelled')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')), completed_at TEXT);
CREATE TABLE IF NOT EXISTS ratings(
  id INTEGER PRIMARY KEY, offer_id INTEGER NOT NULL REFERENCES offers(id), rater_id INTEGER NOT NULL, ratee_id INTEGER NOT NULL,
  stars INTEGER NOT NULL CHECK(stars BETWEEN 1 AND 5), note TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(offer_id, rater_id));
CREATE TABLE IF NOT EXISTS coin_ledger(
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), delta INTEGER NOT NULL, reason TEXT NOT NULL,
  ref TEXT, actor_id INTEGER, created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS auctions(
  id INTEGER PRIMARY KEY, seller_id INTEGER NOT NULL REFERENCES users(id), item TEXT NOT NULL, cat TEXT, descr TEXT DEFAULT '',
  fmt TEXT NOT NULL, start INTEGER NOT NULL, inc INTEGER NOT NULL, reserve INTEGER, buy_now INTEGER,
  dutch_floor INTEGER, dutch_step INTEGER, dutch_every_min INTEGER, duration_min INTEGER NOT NULL,
  verify TEXT NOT NULL DEFAULT '{}', verify_note TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','live','sold','ended','rejected','cancelled')),
  starts_at TEXT, ends_at TEXT, winner_id INTEGER, final_price INTEGER, fee_pct INTEGER, escrow TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS bids(
  id INTEGER PRIMARY KEY, auction_id INTEGER NOT NULL REFERENCES auctions(id), user_id INTEGER NOT NULL REFERENCES users(id),
  amount INTEGER NOT NULL, max_auto INTEGER, swap_item TEXT, auto INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS promos(
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL CHECK(kind IN ('draw','giveaway','challenge','box','video')), title TEXT NOT NULL, cat TEXT, caption TEXT DEFAULT '',
  details TEXT NOT NULL DEFAULT '{}', ends_at TEXT,
  status TEXT NOT NULL DEFAULT 'live' CHECK(status IN ('live','closed','removed')), winners TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS promo_entries(
  promo_id INTEGER NOT NULL REFERENCES promos(id), user_id INTEGER NOT NULL REFERENCES users(id), note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')), PRIMARY KEY(promo_id, user_id));
CREATE TABLE IF NOT EXISTS campaigns(
  id INTEGER PRIMARY KEY, owner_id INTEGER NOT NULL REFERENCES users(id), business TEXT NOT NULL, headline TEXT NOT NULL,
  cta TEXT NOT NULL DEFAULT 'Learn more', image_url TEXT, link TEXT, placement TEXT NOT NULL CHECK(placement IN ('feed','story','side','auction')),
  area TEXT, budget INTEGER NOT NULL, impressions INTEGER NOT NULL DEFAULT 0, clicks INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','active','paused','rejected','ended')), review_note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS events(
  id INTEGER PRIMARY KEY, host_id INTEGER NOT NULL REFERENCES users(id), title TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'meet',
  starts_at TEXT NOT NULL, place TEXT, online INTEGER NOT NULL DEFAULT 0, group_id INTEGER, about TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','cancelled','removed')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS event_rsvps(event_id INTEGER NOT NULL, user_id INTEGER NOT NULL, PRIMARY KEY(event_id,user_id));
CREATE TABLE IF NOT EXISTS groups_(
  id INTEGER PRIMARY KEY, owner_id INTEGER NOT NULL REFERENCES users(id), name TEXT NOT NULL, emoji TEXT DEFAULT '👥', cat TEXT, about TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','removed')), created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS group_members(group_id INTEGER NOT NULL, user_id INTEGER NOT NULL, PRIMARY KEY(group_id,user_id));
CREATE TABLE IF NOT EXISTS messages(
  id INTEGER PRIMARY KEY, from_id INTEGER NOT NULL REFERENCES users(id), to_id INTEGER NOT NULL REFERENCES users(id),
  body TEXT NOT NULL, flagged INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS calls(
  id INTEGER PRIMARY KEY, caller_id INTEGER NOT NULL, callee_id INTEGER NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('voice','video')),
  status TEXT NOT NULL DEFAULT 'ringing' CHECK(status IN ('ringing','ended')), started_at TEXT NOT NULL DEFAULT (datetime('now')),
  ended_at TEXT, seconds INTEGER);
CREATE TABLE IF NOT EXISTS reports(
  id INTEGER PRIMARY KEY, reporter_id INTEGER NOT NULL, target_type TEXT NOT NULL, target_id INTEGER NOT NULL, reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','resolved','dismissed')), resolution TEXT, handled_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')), handled_at TEXT);
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS identities(
  provider TEXT NOT NULL CHECK(provider IN ('google','apple')), sub TEXT NOT NULL, user_id INTEGER NOT NULL REFERENCES users(id), email TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')), PRIMARY KEY(provider, sub));
CREATE TABLE IF NOT EXISTS otps(phone TEXT PRIMARY KEY, code_hash TEXT NOT NULL, expires_at TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, sent_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS brands(
  id INTEGER PRIMARY KEY, owner_id INTEGER NOT NULL REFERENCES users(id), name TEXT NOT NULL, slug TEXT UNIQUE NOT NULL,
  legal_name TEXT NOT NULL, gstin TEXT NOT NULL, trademark TEXT NOT NULL, category TEXT, website TEXT, city TEXT, about TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','verified','rejected','suspended')), review_note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')), verified_at TEXT);
CREATE TABLE IF NOT EXISTS impact_batches(
  id INTEGER PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('planting','meals','cleanup')), qty INTEGER NOT NULL CHECK(qty>0),
  partner TEXT NOT NULL, location TEXT NOT NULL, proof_url TEXT NOT NULL, happened_on TEXT NOT NULL, note TEXT,
  created_by INTEGER, created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS audit_log(
  id INTEGER PRIMARY KEY, actor_id INTEGER, action TEXT NOT NULL, target TEXT, details TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE INDEX IF NOT EXISTS ix_bids_auction ON bids(auction_id, amount DESC);
CREATE INDEX IF NOT EXISTS ix_ledger_user ON coin_ledger(user_id);
CREATE INDEX IF NOT EXISTS ix_msgs ON messages(from_id, to_id);
CREATE INDEX IF NOT EXISTS ix_reports ON reports(status);
`;

// Every value the Control Center can change at runtime. Prices and fees are example pricing.
export const DEFAULT_SETTINGS = {
  features: { signups: true, auctions: true, studio: true, draws: true, calls: true, coins: true, circle: true, ads: true, events: true, groups: true, exclusive: true },
  // Swap Exclusive: one-of-one auctions by verified brands. Fee is example pricing.
  exclusive: { feePct: 8, kycRequired: true },
  maintenance: { on: false, message: 'Swap is down for a short update. Back soon.' },
  plans: { pro: 149, plus: 399 },
  fees: { pro: 5, plus: 3 },
  coins: { perFiveStar: 100, unlockAt: 1000, circleBonus: 50, welcomeBonus: 1000 },
  // Starting trust comes from verifications; swaps and ratings add to it later. Money never buys trust.
  trust: { phone: 20, email: 10, id: 20 },
  limits: { minAge: 15, adultAge: 18, bidAge: 23, deleteGraceDays: 30, proAuctionsPerMonth: 3, videoMaxSeconds: 120, boxMinValue: 200, antiSnipeSeconds: 120 },
  ads: { cpm: { feed: 80, story: 120, side: 60, auction: 150 } },
  // Swap Green. CO2e and waste per swap are estimates for an average item not bought new; publish the method.
  impact: { treesPerSwap: 1, milestoneSwaps: 10000, mealsPerMilestone: 10000, cleanupsPerMilestone: 1, co2KgPerSwap: 12, wasteKgPerSwap: 2.5 },
  categories: ['Electronics', 'Books', 'Sports', 'Home', 'Fashion', 'Hobbies', 'Kids', 'Bike & Car'],
};

const clean = v => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v);

export function openDb(path = process.env.DB_PATH || 'data/swap.db') {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const raw = new DatabaseSync(path);
  raw.exec('PRAGMA foreign_keys=ON;');
  if (path !== ':memory:') raw.exec('PRAGMA journal_mode=WAL;');
  raw.exec(SCHEMA);
  const db = {
    raw,
    get: (sql, ...p) => raw.prepare(sql).get(...p.map(clean)),
    all: (sql, ...p) => raw.prepare(sql).all(...p.map(clean)),
    run: (sql, ...p) => raw.prepare(sql).run(...p.map(clean)),
    tx(fn) {
      raw.exec('BEGIN IMMEDIATE');
      try { const r = fn(); raw.exec('COMMIT'); return r; } catch (e) { raw.exec('ROLLBACK'); throw e; }
    },
    setting(key) {
      const r = db.get('SELECT value FROM settings WHERE key=?', key), def = structuredClone(DEFAULT_SETTINGS[key]);
      if (!r) return def;
      const v = JSON.parse(r.value);
      return def && typeof def === 'object' && !Array.isArray(def) && v && typeof v === 'object' ? { ...def, ...v } : v;
    },
    setSetting(key, value) { db.run('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', key, JSON.stringify(value)); },
    audit(actorId, action, target, details) { db.run('INSERT INTO audit_log(actor_id,action,target,details) VALUES(?,?,?,?)', actorId, action, target, details ? JSON.stringify(details) : null); },
    // Coins only ever move through the ledger, so every balance can be traced.
    coin(userId, delta, reason, ref, actorId) {
      db.run('UPDATE users SET coins=coins+? WHERE id=?', delta, userId);
      db.run('INSERT INTO coin_ledger(user_id,delta,reason,ref,actor_id) VALUES(?,?,?,?,?)', userId, delta, reason, ref, actorId);
    },
  };
  const addCol = (table, col, def) => { if (!raw.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === col)) raw.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`); };
  addCol('users', 'kyc_status', "TEXT NOT NULL DEFAULT 'none'");
  addCol('users', 'phone', 'TEXT');
  addCol('users', 'status', "TEXT NOT NULL DEFAULT 'active'");
  addCol('users', 'deactivated_at', 'TEXT');
  addCol('users', 'delete_after', 'TEXT');
  addCol('users', 'email_verified', 'INTEGER NOT NULL DEFAULT 0');
  addCol('users', 'id_verified', 'INTEGER NOT NULL DEFAULT 0');
  addCol('users', 'id_method', 'TEXT');
  addCol('users', 'id_last4', 'TEXT');
  addCol('users', 'id_ref_hash', 'TEXT');
  addCol('users', 'avatar_url', 'TEXT');
  addCol('users', 'welcome_bonus', 'INTEGER NOT NULL DEFAULT 0');
  raw.exec('CREATE UNIQUE INDEX IF NOT EXISTS ux_users_idref ON users(id_ref_hash) WHERE id_ref_hash IS NOT NULL');
  raw.exec('CREATE UNIQUE INDEX IF NOT EXISTS ux_users_phone ON users(phone) WHERE phone IS NOT NULL');
  addCol('auctions', 'brand_id', 'INTEGER');
  addCol('auctions', 'edition', 'TEXT');
  addCol('auctions', 'cert_no', 'TEXT');
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) db.run('INSERT OR IGNORE INTO settings(key,value) VALUES(?,?)', k, JSON.stringify(v));
  return db;
}
