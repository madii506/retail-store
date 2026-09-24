// GET /api/status?id= — a claim ticket. Also looks on-chain for the payout if it's still in line.
const L = require('./_lib');
module.exports = L.wrap(async (req, res) => {
  const id = String(L.query(req).id || '').toUpperCase().replace(/[^0-9A-Z]/g, '').slice(0, 12);
  if (!id) throw new L.Fail('bad_id', 'Enter your ticket number.');
  L.limit('status:' + L.clientIp(req), 40, 60000);
  let doc = await L.readDb(), c = doc && doc.claims[id];
  if (!c) { doc = await L.readDb({ fresh: true }); c = doc && doc.claims[id]; }
  if (!c) throw new L.Fail('not_found', 'No ticket with that number.', 404);
  if (c.st === 'q') { const upd = await L.lookForPayout(c).catch(() => null); if (upd && upd.st === 'p') c = upd; }
  const q = L.queueOf(doc), pos = c.st === 'q' ? q.findIndex(x => x.i === c.i) + 1 : 0;
  L.send(res, 200, { ok: true, amountUsd: L.CFG.amountUsd, payout: L.CFG.payout, t: {
    id: c.i, h: L.mask(c.h), w: L.short(c.w), ts: c.ts, st: c.st, pos: pos || null, line: q.length,
    n: c.n || null, sig: c.sig || null, sol: c.lam ? c.lam / 1e9 : null, usd: c.usd ? c.usd / 100 : null, pt: c.pt || null, why: c.why || null,
  } });
});
