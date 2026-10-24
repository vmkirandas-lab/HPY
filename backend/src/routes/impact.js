// Swaapo Green: every completed swap pledges a tree; every milestone pledges meals and a clean-up drive.
// "Pledged" comes from completed swaps. "Delivered" only counts batches staff record with partner proof.
import { Router } from 'express';
import { requireUser } from '../auth.js';

export function impactSummary(db) {
  const cfg = db.setting('impact');
  const swaps = db.get("SELECT COUNT(*) n FROM offers WHERE status='completed'").n;
  const sum = kind => db.get('SELECT COALESCE(SUM(qty),0) n FROM impact_batches WHERE kind=?', kind).n;
  const milestones = Math.floor(swaps / cfg.milestoneSwaps);
  const next = (milestones + 1) * cfg.milestoneSwaps;
  return {
    swaps,
    trees: { pledged: swaps * cfg.treesPerSwap, planted: sum('planting') },
    meals: { pledged: milestones * cfg.mealsPerMilestone, funded: sum('meals') },
    cleanups: { pledged: milestones * cfg.cleanupsPerMilestone, done: db.get("SELECT COUNT(*) n FROM impact_batches WHERE kind='cleanup'").n },
    estimates: { co2Kg: Math.round(swaps * cfg.co2KgPerSwap), wasteKg: Math.round(swaps * cfg.wasteKgPerSwap), note: 'Estimates for an average item not bought new.' },
    milestone: { every: cfg.milestoneSwaps, reached: milestones, next, progressPct: Math.round(((swaps % cfg.milestoneSwaps) / cfg.milestoneSwaps) * 100) },
  };
}

// Called inside the swap-completion transaction. Returns the milestone number if this swap crossed one.
export function onSwapCompleted(db, offerId) {
  const cfg = db.setting('impact');
  const swaps = db.get("SELECT COUNT(*) n FROM offers WHERE status='completed'").n;
  db.audit(null, 'impact.tree_pledged', `offer:${offerId}`, { trees: cfg.treesPerSwap, total: swaps * cfg.treesPerSwap });
  if (swaps % cfg.milestoneSwaps === 0) {
    db.audit(null, 'impact.milestone', `swaps:${swaps}`, { meals: cfg.mealsPerMilestone, cleanups: cfg.cleanupsPerMilestone });
    return swaps;
  }
  return null;
}

export default function impact(db) {
  const r = Router();
  r.get('/impact', (_req, res) => res.json({
    ...impactSummary(db),
    recent: db.all('SELECT kind,qty,partner,location,proof_url,happened_on FROM impact_batches ORDER BY happened_on DESC, id DESC LIMIT 20'),
  }));
  r.get('/me/impact', (req, res) => {
    const u = requireUser(req), cfg = db.setting('impact');
    const n = db.get("SELECT COUNT(*) n FROM offers WHERE status='completed' AND (from_id=? OR to_id=?)", u.id, u.id).n;
    res.json({ swaps: n, trees: n * cfg.treesPerSwap, co2Kg: Math.round(n * cfg.co2KgPerSwap), wasteKg: Math.round(n * cfg.wasteKgPerSwap) });
  });
  return r;
}
