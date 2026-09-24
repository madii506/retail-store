// GET /api/store — public settings, live counters (from stored claims + on-chain payouts) and SOL price.
const L = require('./_lib');
module.exports = L.wrap(async (req, res) => {
  const cfg = L.publicCfg();
  const [price, bal] = await Promise.all([
    L.solPrice().catch(() => null),
    cfg.payout ? L.payoutBalance().catch(() => null) : null,
  ]);
  let stats = null;
  if (cfg.storage) {
    try { const doc = await L.readDb(); stats = L.statsOf(doc || { claims: {} }, price); }
    catch (e) { console.error('[store]', e && e.message); }
  }
  L.send(res, 200, { ok: true, cfg, stats, price, balance: bal, repo: 'https://github.com/madii506/retail-store', now: Date.now() }, 'public, max-age=0, s-maxage=15, stale-while-revalidate=60');
});
