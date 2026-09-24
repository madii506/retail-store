// POST /api/claim {vt, wallet, agree} — puts a verified X account + wallet in line for a payout.
const L = require('./_lib');
module.exports = L.wrap(async (req, res) => {
  if (req.method !== 'POST') throw new L.Fail('method', 'POST only.', 405);
  const ip = L.clientIp(req);
  L.limit('claim:' + ip, 6, 60000);
  const C = L.CFG, b = await L.body(req);
  if (!C.open) throw new L.Fail('closed', 'Claims are paused right now. Check back soon.', 403);
  const v = await L.readTok(b.vt, 'v');
  if (!v) throw new L.Fail('expired', 'Your bio check expired. Go back one step and check again.');
  const wallet = String(b.wallet || '').trim();
  if (!L.validWallet(wallet)) throw new L.Fail('bad_wallet', 'That doesn\'t look like a Solana address. Copy it from your wallet app and paste it again.');
  if (wallet === C.payout || wallet === L.SYSTEM) throw new L.Fail('bad_wallet', 'Paste your own wallet address.');
  if (!b.agree) throw new L.Fail('agree', 'Tick the box to confirm you\'re 18+ and understand the risks.');
  if (C.maxWalletTxs > 0) {
    try {
      const sigs = await L.rpc('getSignaturesForAddress', [wallet, { limit: C.maxWalletTxs + 1 }]);
      if ((sigs || []).length > C.maxWalletTxs) throw new L.Fail('wallet_used', `This wallet already has history. RETAIL is for first-timers: use a fresh wallet (fewer than ${C.maxWalletTxs} transactions).`);
    } catch (e) { if (e instanceof L.Fail && e.reason === 'wallet_used') throw e; }
  }
  const ipH = L.hmac(await L.secret(), 'ip|' + ip).toString('hex').slice(0, 16);
  const c = await L.mutate(doc => {
    const today = L.dayKey(), all = Object.values(doc.claims);
    if (doc.h[v.h]) throw new L.Fail('already', `@${v.dh} already claimed. One per person.`);
    if (doc.w[wallet]) throw new L.Fail('wallet_taken', 'This wallet already claimed. One per person.');
    if (all.filter(x => L.dayKey(x.ts) === today && x.st !== 'x').length >= C.dailyCap) throw new L.Fail('sold_out', 'Today\'s spots are gone. New spots open at 00:00 UTC.', 409);
    if (all.filter(x => x.ip === ipH && L.dayKey(x.ts) === today).length >= C.perIpPerDay) throw new L.Fail('ip_limit', 'Too many claims from this network today. One per person.', 429);
    let id; do { id = L.newId(); } while (doc.claims[id]);
    doc.seq = (doc.seq || 0) + 1;
    const rec = { i: id, q: doc.seq, h: v.h, dh: v.dh, nm: v.name, fo: v.fo, po: v.po, age: v.age, w: wallet, ts: L.now(), ip: ipH, st: 'q' };
    doc.claims[id] = rec; doc.h[v.h] = id; doc.w[wallet] = id;
    return rec;
  });
  L.send(res, 200, { ok: true, id: c.i });
});
