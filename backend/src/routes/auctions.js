// Auctions: create (verified items only, staff approve before going live), bid, buy now, and closing.
import { Router } from 'express';
import { requireUser } from '../auth.js';
import { fail } from '../errors.js';
import { FMT, PRO_FMTS, needAdult, needBidAge, needAuctionView, needTier, needFeature, minNext, topBid, dutchPrice, hasTier, str, int, nowIso } from '../rules.js';

// Close live auctions whose timer has run out. Called on a timer and before reads.
// Brand (Swaapo Exclusive) sales use the exclusive fee; others use the seller's plan fee.
const feeFor = (db, a, sellerTier) => (a.brand_id ? db.setting('exclusive').feePct : db.setting('fees')[sellerTier === 'plus' ? 'plus' : 'pro']);
// Executive auctions only accept bids from members whose ID check is approved.
function needKyc(db, u, a) {
  if (a.brand_id && db.setting('exclusive').kycRequired && u.kyc_status !== 'verified')
    fail(403, 'Executive auctions are for verified bidders. Verify your ID once to bid.', 'kyc_required');
}

export function closeExpired(db) {
  const due = db.all("SELECT * FROM auctions WHERE status='live' AND ends_at<=?", nowIso());
  for (const a of due) {
    const bids = db.all('SELECT * FROM bids WHERE auction_id=?', a.id), t = topBid(bids);
    const seller = db.get('SELECT tier FROM users WHERE id=?', a.seller_id);
    const sold = t && (a.fmt !== 'reserve' || t.amount >= (a.reserve ?? a.start));
    db.run('UPDATE auctions SET status=?, winner_id=?, final_price=?, fee_pct=?, escrow=? WHERE id=?',
      sold ? 'sold' : 'ended', sold ? t.user_id : null, sold ? t.amount : null,
      sold ? feeFor(db, a, seller.tier) : null, sold ? 'awaiting_payment' : null, a.id);
    db.audit(null, sold ? 'auction.sold' : 'auction.ended', `auction:${a.id}`, sold ? { winner: t.user_id, price: t.amount } : null);
  }
  return due.length;
}

export function auctionView(db, a, viewer) {
  const bids = db.all('SELECT b.amount,b.created_at,b.user_id,b.auto,b.swap_item,u.handle FROM bids b JOIN users u ON u.id=b.user_id WHERE auction_id=? ORDER BY amount DESC', a.id);
  const sealed = a.fmt === 'sealed' && a.status === 'live';
  const mine = viewer ? bids.filter(b => b.user_id === viewer.id) : [];
  const brand = a.brand_id ? db.get('SELECT name,slug,legal_name,gstin,city FROM brands WHERE id=?', a.brand_id) : null;
  return {
    ...a, verify: JSON.parse(a.verify || '{}'), brand, exclusive: !!a.brand_id,
    price: a.fmt === 'dutch' ? dutchPrice(a) : (sealed ? a.start : topBid(bids)?.amount ?? a.start),
    minNext: a.fmt === 'dutch' ? null : sealed ? a.start : minNext(a, bids), bidCount: bids.length,
    reserveMet: a.fmt === 'reserve' ? (topBid(bids)?.amount ?? 0) >= (a.reserve ?? a.start) : undefined,
    reserve: undefined, // the reserve amount itself is never shown to buyers
    bids: sealed ? [] : bids.slice(0, 50).map(({ user_id, ...b }) => b),
    myTopBid: mine.length ? Math.max(...mine.map(b => b.amount)) : null,
  };
}

export default function auctions(db) {
  const r = Router();

  r.get('/auctions', (req, res) => {
    needAuctionView(req);
    closeExpired(db);
    const fmt = str(req.query.fmt, 20);
    const rows = db.all(`SELECT * FROM auctions WHERE status='live' AND (?='' OR fmt=?) ORDER BY ends_at LIMIT 100`, fmt, fmt);
    res.json(rows.map(a => auctionView(db, a, req.user)));
  });
  r.get('/auctions/:id', (req, res) => {
    needAuctionView(req);
    closeExpired(db);
    const a = db.get('SELECT * FROM auctions WHERE id=?', req.params.id);
    if (!a || (a.status === 'pending' && a.seller_id !== req.user?.id)) fail(404, 'Auction not found.');
    res.json(auctionView(db, a, req.user));
  });

  r.post('/auctions', (req, res) => {
    needFeature(db, 'auctions');
    const u = requireUser(req);
    needBidAge(db, u, `Selling by auction is for members ${db.setting('limits').bidAge} and over.`);
    const fmt = req.body.fmt;
    if (!FMT.includes(fmt)) fail(400, 'Unknown auction format.');
    // Verified brands sell one-of-one pieces without a member plan; everyone else needs Pro.
    let brand = null;
    if (req.body.brandId) {
      needFeature(db, 'exclusive');
      brand = db.get("SELECT * FROM brands WHERE id=? AND owner_id=?", int(req.body.brandId), u.id);
      if (!brand) fail(404, 'Brand not found.');
      if (brand.status !== 'verified') fail(403, 'Your brand page needs to be verified before it can run executive auctions.', 'brand_unverified');
      if (fmt === 'swapbid') fail(400, 'Executive auctions are cash only. Pick another format.');
    } else {
      needTier(u, 'pro', 'Swapping is free forever. Selling by auction needs Pro, with your item verified first.');
      if (!PRO_FMTS.includes(fmt) && !hasTier(u, 'plus')) fail(402, 'Live drop, Sealed bid, Price drop and Swap or Bid need Pro Plus.', 'upgrade');
    }
    if (!brand && u.tier === 'pro') {
      const n = db.get("SELECT COUNT(*) n FROM auctions WHERE seller_id=? AND created_at>=datetime('now','start of month') AND status NOT IN ('rejected','cancelled')", u.id).n;
      if (n >= db.setting('limits').proAuctionsPerMonth) fail(402, "Pro includes 3 auctions a month, and you've used them all. Pro Plus is unlimited.", 'upgrade');
    }
    const v = req.body.verify || {};
    if (!v.bill || !v.own) fail(400, 'Confirm proof of purchase and ownership. Only verified items can be auctioned.');
    const item = str(req.body.item, 80), start = int(req.body.start);
    if (!item) fail(400, 'Name the item.');
    if (!(start > 0)) fail(400, 'Set a starting price.');
    const inc = int(req.body.inc) > 0 ? int(req.body.inc) : Math.max(50, Math.round(start * 0.05 / 50) * 50);
    const reserve = fmt === 'reserve' ? int(req.body.reserve) : null;
    if (fmt === 'reserve' && !(reserve >= start)) fail(400, "The reserve can't be lower than the starting bid.");
    const buyNow = fmt === 'buynow' ? int(req.body.buyNow) : null;
    if (fmt === 'buynow' && !(buyNow > start)) fail(400, 'Buy Now must be above the starting bid.');
    const floor = fmt === 'dutch' ? int(req.body.floor) : null;
    if (fmt === 'dutch' && !(floor > 0 && floor <= start)) fail(400, 'Set a floor between 1 and the start price.');
    const duration = fmt === 'live' ? 10 : Math.min(10080, Math.max(60, int(req.body.durationMin) || 1440));
    const { lastInsertRowid: id } = db.run(`INSERT INTO auctions(seller_id,item,cat,descr,fmt,start,inc,reserve,buy_now,dutch_floor,dutch_step,dutch_every_min,duration_min,verify)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, u.id, item, str(req.body.cat, 30) || null, str(req.body.descr, 2000), fmt, start, inc, reserve, buyNow,
      floor, fmt === 'dutch' ? (int(req.body.step) || Math.max(50, Math.round(start * 0.03 / 50) * 50)) : null, fmt === 'dutch' ? 4 : null,
      duration, JSON.stringify({ bill: !!v.bill, serial: str(v.serial, 60) || null, own: !!v.own }));
    let cert = null;
    if (brand) {
      const n = db.get('SELECT COUNT(*) n FROM auctions WHERE brand_id=?', brand.id).n + 1;
      cert = `SWX-${brand.slug.replace(/[^a-z]/g, '').slice(0, 3).toUpperCase().padEnd(3, 'X')}-${String(n).padStart(4, '0')}`;
      db.run("UPDATE auctions SET brand_id=?, edition='1 of 1', cert_no=? WHERE id=?", brand.id, cert, id);
    }
    db.audit(u.id, 'auction.submit', `auction:${id}`, { fmt, start, brand: brand?.slug, cert });
    res.status(201).json({ id: Number(id), status: 'pending', cert, note: 'Our team checks the documents and photos before your auction goes live.' });
  });

  r.post('/auctions/:id/bids', (req, res) => {
    needFeature(db, 'auctions');
    const u = requireUser(req);
    needBidAge(db, u, `Bidding is for members ${db.setting('limits').bidAge} and over. Members 18 and over can watch.`);
    needTier(u, 'pro', 'Bidding needs Pro.');
    if (u.strikes >= 3) fail(403, 'Bidding is blocked after three unpaid wins.', 'strikes');
    closeExpired(db);
    const out = db.tx(() => {
      const a = db.get('SELECT * FROM auctions WHERE id=?', req.params.id);
      if (!a || a.status !== 'live') fail(409, 'This auction has ended.');
      if (a.seller_id === u.id) fail(403, "You can't bid on your own auction.");
      needKyc(db, u, a);
      if (a.fmt === 'dutch') fail(400, 'Price drop auctions are bought with Buy now, not bids.');
      const amount = int(req.body.amount), bids = db.all('SELECT * FROM bids WHERE auction_id=?', a.id);
      const min = a.fmt === 'sealed' ? a.start : minNext(a, bids);
      if (!(amount >= min)) fail(400, `Bid at least ₹${min.toLocaleString('en-IN')}.`, 'bid_too_low');
      if (a.buy_now && amount >= a.buy_now) fail(400, 'That reaches the Buy Now price. Use Buy now instead.');
      const max = int(req.body.maxAuto) > amount ? int(req.body.maxAuto) : null;
      if (max) needTier(u, 'plus', 'Auto-bid is part of Pro Plus.');
      if (a.fmt === 'sealed') db.run('DELETE FROM bids WHERE auction_id=? AND user_id=?', a.id, u.id); // one sealed bid each
      db.run('INSERT INTO bids(auction_id,user_id,amount,max_auto,swap_item) VALUES(?,?,?,?,?)', a.id, u.id, amount, max,
        a.fmt === 'swapbid' ? str(req.body.swapItem, 120) || null : null);
      // Auto-bid: if an earlier bidder's private maximum beats this bid, bid for them one step higher.
      let top = amount;
      if (a.fmt !== 'sealed') {
        const rival = db.get('SELECT user_id, MAX(max_auto) m FROM bids WHERE auction_id=? AND user_id<>? AND max_auto IS NOT NULL GROUP BY user_id ORDER BY m DESC LIMIT 1', a.id, u.id);
        if (rival && rival.m >= amount + a.inc) {
          top = Math.min(rival.m, amount + a.inc);
          db.run('INSERT INTO bids(auction_id,user_id,amount,auto) VALUES(?,?,?,1)', a.id, rival.user_id, top);
        }
      }
      // Anti-sniping: a bid in the last N seconds pushes the end back by N seconds.
      const snipe = db.setting('limits').antiSnipeSeconds * 1000;
      let extended = false;
      if (new Date(a.ends_at) - Date.now() < snipe) { db.run('UPDATE auctions SET ends_at=? WHERE id=?', new Date(Date.now() + snipe).toISOString(), a.id); extended = true; }
      return { top, youAreTop: top === amount, extended };
    });
    res.status(201).json(out);
  });

  r.post('/auctions/:id/buy', (req, res) => {
    needFeature(db, 'auctions');
    const u = requireUser(req);
    needBidAge(db, u, `Buying by auction is for members ${db.setting('limits').bidAge} and over.`);
    needTier(u, 'pro');
    const out = db.tx(() => {
      const a = db.get('SELECT * FROM auctions WHERE id=?', req.params.id);
      if (!a || a.status !== 'live') fail(409, 'This auction has ended.');
      if (a.seller_id === u.id) fail(403, "You can't buy your own item.");
      needKyc(db, u, a);
      let price;
      if (a.fmt === 'dutch') price = dutchPrice(a);
      else if (a.buy_now) {
        const t = topBid(db.all('SELECT amount FROM bids WHERE auction_id=?', a.id));
        if (t && t.amount >= a.buy_now) fail(409, 'Bids have passed the Buy Now price.');
        price = a.buy_now;
      } else fail(400, 'This auction has no Buy now option.');
      const seller = db.get('SELECT tier FROM users WHERE id=?', a.seller_id);
      db.run("UPDATE auctions SET status='sold', winner_id=?, final_price=?, fee_pct=?, escrow='awaiting_payment', ends_at=? WHERE id=?",
        u.id, price, feeFor(db, a, seller.tier), nowIso(), a.id);
      db.audit(u.id, 'auction.buy', `auction:${a.id}`, { price });
      return { status: 'sold', price, next: 'Pay into SwaapoSafe escrow to complete.' };
    });
    res.json(out);
  });

  return r;
}

