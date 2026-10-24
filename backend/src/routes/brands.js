// Swaapo Exclusive brand pages: apply, browse verified brands, and verified-bidder (KYC) requests.
import { Router } from 'express';
import { requireUser } from '../auth.js';
import { fail } from '../errors.js';
import { needAdult, needBidAge, needFeature, str } from '../rules.js';

export const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z]$/;
export const PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
const slugify = s => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'brand';
const publicBrand = b => ({ id: b.id, name: b.name, slug: b.slug, legal_name: b.legal_name, gstin: b.gstin, category: b.category, website: b.website, city: b.city, about: b.about, verified_at: b.verified_at });

export default function brands(db) {
  const r = Router();

  r.post('/brands', (req, res) => {
    needFeature(db, 'exclusive');
    const u = requireUser(req);
    needAdult(u, 'Brand pages are run by adults 18 and over.');
    const name = str(req.body.name, 60), legal = str(req.body.legalName, 120), gstin = str(req.body.gstin, 15).toUpperCase(), tm = str(req.body.trademark, 80);
    if (!name || !legal) fail(400, 'Add the brand name and the registered business name.');
    if (!GSTIN_RE.test(gstin)) fail(400, 'Enter a valid 15-character GSTIN.');
    if (!tm) fail(400, 'Add a trademark number or a brand authorisation.');
    if (req.body.genuine !== true || req.body.invoices !== true) fail(400, 'Please confirm both statements.');
    if (db.get("SELECT 1 FROM brands WHERE owner_id=? AND status IN ('pending','verified')", u.id)) fail(409, 'You already have a brand page or an application in review.');
    if (db.get("SELECT 1 FROM brands WHERE gstin=? AND status IN ('pending','verified')", gstin)) fail(409, 'A brand with this GSTIN is already registered.');
    let slug = slugify(name), i = 1;
    while (db.get('SELECT 1 FROM brands WHERE slug=?', slug)) slug = `${slugify(name)}-${++i}`;
    const { lastInsertRowid: id } = db.run('INSERT INTO brands(owner_id,name,slug,legal_name,gstin,trademark,category,website,city,about) VALUES(?,?,?,?,?,?,?,?,?,?)',
      u.id, name, slug, legal, gstin, tm, str(req.body.category, 40) || null, str(req.body.website, 200) || null, str(req.body.city, 60) || null, str(req.body.about, 600));
    db.audit(u.id, 'brand.apply', `brand:${id}`, { name, gstin });
    res.status(201).json({ id: Number(id), slug, status: 'pending', note: 'We review brands within 3 working days.' });
  });

  r.get('/brands', (_req, res) => res.json(db.all(`SELECT b.*, (SELECT COUNT(*) FROM auctions a WHERE a.brand_id=b.id AND a.status='live') live
    FROM brands b WHERE status='verified' ORDER BY b.name`).map(b => ({ ...publicBrand(b), live: b.live }))));
  r.get('/brands/:slug', (req, res) => {
    const b = db.get("SELECT * FROM brands WHERE slug=? AND status='verified'", req.params.slug);
    if (!b) fail(404, 'Brand not found.');
    const canSee = req.user && req.user.adult; // live auctions are only shown to members 18+
    res.json({ ...publicBrand(b),
      live: !canSee ? [] : db.all("SELECT id,item,fmt,start,ends_at,edition,cert_no FROM auctions WHERE brand_id=? AND status='live' ORDER BY ends_at", b.id),
      sold: db.all("SELECT id,item,final_price,cert_no,ends_at FROM auctions WHERE brand_id=? AND status='sold' ORDER BY ends_at DESC LIMIT 50", b.id) });
  });
  r.get('/me/brand', (req, res) => {
    const u = requireUser(req);
    res.json(db.get('SELECT * FROM brands WHERE owner_id=? ORDER BY id DESC LIMIT 1', u.id) || null);
  });

  // Verified bidder: the member confirms; staff check ID + PAN with a KYC provider and approve. Only the outcome is stored.
  r.post('/me/kyc', (req, res) => {
    const u = requireUser(req);
    needBidAge(db, u, `Executive auctions are for members ${db.setting('limits').bidAge} and over.`);
    if (u.kyc_status === 'verified') return res.json({ kyc_status: 'verified' });
    if (!PAN_RE.test(str(req.body.pan, 10).toUpperCase())) fail(400, 'Enter a PAN like ABCDE1234F.');
    if (req.body.confirm !== true) fail(400, 'Please confirm the ID and PAN are yours.');
    db.run("UPDATE users SET kyc_status='pending' WHERE id=?", u.id);
    db.audit(u.id, 'kyc.request', `user:${u.id}`);
    res.json({ kyc_status: 'pending' });
  });
  return r;
}
