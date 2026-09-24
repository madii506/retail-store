// GET /api/receipts — every paid claim, each one a confirmed Solana transaction from the payout wallet.
const L = require('./_lib');
module.exports = L.wrap(async (req, res) => {
  const lim = Math.min(500, Math.max(1, parseInt(L.query(req).limit, 10) || 60));
  let doc = null;
  if (L.storageOn()) { try { doc = await L.readDb(); } catch (e) { doc = null; } }
  const paid = Object.values((doc && doc.claims) || {}).filter(c => c.st === 'p').sort((a, b) => (b.n || 0) - (a.n || 0));
  L.send(res, 200, {
    ok: true, payout: L.CFG.payout, total: paid.length,
    sol: paid.reduce((a, c) => a + (c.lam || 0), 0) / 1e9, usd: paid.reduce((a, c) => a + (c.usd || 0), 0) / 100,
    receipts: paid.slice(0, lim).map(L.receiptOf),
  }, 'public, max-age=0, s-maxage=15, stale-while-revalidate=60');
});
