// Creates the first admin, plus example members and content that match the app's demo data.
// Usage: ADMIN_EMAIL=you@x.com ADMIN_PASSWORD=... npm run seed   (add SEED_DEMO=0 to skip example data)
import crypto from 'node:crypto';
import { openDb } from './db.js';
import { hashPassword } from './auth.js';
import { nowIso, addMin } from './rules.js';

const db = openDb();
const adminEmail = process.env.ADMIN_EMAIL || 'admin@swap.local';
const adminPass = process.env.ADMIN_PASSWORD || crypto.randomBytes(9).toString('base64url');

if (!db.get('SELECT 1 FROM users WHERE email=?', adminEmail)) {
  db.run("INSERT INTO users(handle,name,email,pass_hash,dob,role,verified,trust) VALUES('swap.admin','Swaapo Admin',?,?,'1990-01-01','admin',1,100)", adminEmail, hashPassword(adminPass));
  console.log(`Admin created: ${adminEmail} / ${adminPass}${process.env.ADMIN_PASSWORD ? '' : '  (generated: save it now)'}`);
} else console.log(`Admin ${adminEmail} already exists.`);

if (process.env.SEED_DEMO !== '0' && !db.get("SELECT 1 FROM users WHERE handle='meera.swaps'")) {
  const demoPass = process.env.DEMO_PASSWORD || 'swap-demo-2026';
  const H = hashPassword(demoPass);
  const users = [
    ['meera.swaps', 'Meera Nair', '1998-04-12', 'Kakkanad', 'free', 'member', 91, 1],
    ['arjun_m', 'Arjun Menon', '1996-08-03', 'Edappally', 'plus', 'none', 88, 1],
    ['fatima.reads', 'Fatima Sheikh', '1999-02-21', 'Fort Kochi', 'free', 'member', 97, 1],
    ['rahul.iyer', 'Rahul Iyer', '2002-11-30', 'Vyttila', 'pro', 'none', 74, 0],
    ['anjali.t', 'Anjali Thomas', '1990-06-15', 'Kaloor', 'free', 'pending', 93, 1],
    ['vik.lifts', 'Vikram Rao', '1995-01-09', 'Palarivattom', 'free', 'none', 69, 0],
    ['sneha.clicks', 'Sneha Pillai', '1997-09-27', 'Panampilly Nagar', 'plus', 'member', 95, 1],
    ['dev.vintage', 'Dev Kurian', '1988-03-05', 'Mattancherry', 'plus', 'none', 98, 1],
    ['kiran.d', 'Kiran Das', '2009-05-18', 'Aluva', 'free', 'none', 66, 0], // teen (15-17), consent pending
    ['mod.kochi', 'Kochi Moderator', '1993-07-07', 'Kochi', 'free', 'none', 100, 1],
  ];
  const id = {};
  for (const [h, n, dob, area, tier, circle, trust, ver] of users) {
    id[h] = Number(db.run(`INSERT INTO users(handle,name,email,pass_hash,dob,area,tier,tier_until,circle_status,trust,verified,role,guardian_contact,coins)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, h, n, `${h}@demo.swap`, H, dob, area, tier, tier === 'free' ? null : addMin(nowIso(), 30 * 1440),
      circle, trust, ver, h === 'mod.kochi' ? 'moderator' : 'user', h === 'kiran.d' ? 'parent.kiran@demo.swap' : null, 0).lastInsertRowid);
    if (h === 'meera.swaps') { db.coin(id[h], 1100, '5-star swaps (seed)', 'seed'); }
  }
  const post = (h, type, cat, title, want, body) => Number(db.run('INSERT INTO posts(user_id,type,cat,title,want,body,cond) VALUES(?,?,?,?,?,?,?)', id[h], type, cat, title, want, body, 'Good').lastInsertRowid);
  post('meera.swaps', 'item', 'Electronics', 'JBL Flip 5 speaker', 'Books, headphones', 'Battery still lasts a full day.');
  post('fatima.reads', 'item', 'Books', '12 Murakami novels', 'Desk lamp, plants', 'Paperbacks, good condition.');
  post('vik.lifts', 'item', 'Bike & Car', 'Studds full-face helmet (M)', 'Riding gloves, phone mount', 'ISI marked, no drops.');
  const bad = post('vik.lifts', 'item', 'Electronics', 'iPhone 14 — pay advance on UPI', 'Cash', 'Send advance first.');
  db.run('INSERT INTO reports(reporter_id,target_type,target_id,reason) VALUES(?,?,?,?)', id['meera.swaps'], 'post', bad, 'Asks for advance payment on UPI. Looks like a scam.');
  db.run('INSERT INTO messages(from_id,to_id,body,flagged) VALUES(?,?,?,1)', id['vik.lifts'], id['meera.swaps'], 'Share the OTP and I will send the item');

  const start = nowIso();
  db.run(`INSERT INTO auctions(seller_id,item,cat,fmt,start,inc,duration_min,verify,status,starts_at,ends_at) VALUES(?,?,?,?,?,?,?,?, 'live', ?, ?)`,
    id['dev.vintage'], 'Seiko 5 Automatic (1978)', 'Fashion', 'english', 4000, 250, 1440, '{"bill":true,"serial":"6119-8090","own":true}', start, addMin(start, 1440));
  db.run(`INSERT INTO auctions(seller_id,item,cat,fmt,start,inc,reserve,duration_min,verify) VALUES(?,?,?,?,?,?,?,?,?)`,
    id['arjun_m'], 'Btwin Rockrider ST100 MTB', 'Sports', 'reserve', 9000, 500, 12000, 4320, '{"bill":true,"serial":"BT-22918","own":true}');
  db.run('INSERT INTO promos(user_id,kind,title,cat,details,ends_at) VALUES(?,?,?,?,?,?)', id['sneha.clicks'], 'draw', 'Camera strap + 32 GB SD card', 'Electronics',
    JSON.stringify({ winners: 1, how: ['follow', 'comment'] }), addMin(nowIso(), 2 * 1440));
  db.run('INSERT INTO campaigns(owner_id,business,headline,cta,placement,area,budget) VALUES(?,?,?,?,?,?,?)', id['arjun_m'], 'Periyar Cycle Clinic', 'Free check-up for swapped cycles', 'Book a check', 'feed', 'Kochi', 3000);
  const g = db.run("INSERT INTO groups_(owner_id,name,emoji,cat,about) VALUES(?,?,?,?,?)", id['vik.lifts'], 'Kochi Riders Swap', '🏍️', 'Bike & Car', 'Helmets, jackets, bike and car accessories.').lastInsertRowid;
  db.run('INSERT INTO group_members(group_id,user_id) VALUES(?,?)', g, id['vik.lifts']);
  db.run('INSERT INTO events(host_id,title,kind,starts_at,place) VALUES(?,?,?,?,?)', id['meera.swaps'], 'Fort Kochi Swap Meet', 'meet', addMin(nowIso(), 6 * 1440), 'Vasco da Gama Square');
  for (const [kind, qty, partner, location, on] of [['planting', 40, 'Green Kerala Trust (example)', 'Attappadi, Palakkad', '2026-08-02'], ['cleanup', 180, 'Swaapo volunteers', 'Cherai Beach, Vypin', '2026-09-14']])
    db.run('INSERT INTO impact_batches(kind,qty,partner,location,proof_url,happened_on) VALUES(?,?,?,?,?,?)', kind, qty, partner, location, 'https://example.org/proof', on);
  console.log(`Demo data added. Demo members sign in with their handle and password "${demoPass}" (moderator: mod.kochi).`);
}
