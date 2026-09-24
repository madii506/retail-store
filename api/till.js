// POST /api/till — the operator's till. Sign in by signing a message with the payout wallet.
// This server never holds keys: payouts are signed in the operator's wallet, then checked on-chain here.
const L = require('./_lib');
const msgFor = n => `RETAIL till sign-in\n\nWallet: ${L.CFG.payout}\nNonce: ${n.nonce}\nExpires: ${new Date(n.exp).toISOString()}\n\nThis signature is free and does not send a transaction.`;
const memoFor = id => `RETAIL receipt #${id}`;
module.exports = L.wrap(async (req, res) => {
  if (req.method !== 'POST') throw new L.Fail('method', 'POST only.', 405);
  const C = L.CFG, b = await L.body(req), op = String(b.op || '');
  L.limit('till:' + L.clientIp(req), 90, 60000);
  if (!C.payout) throw new L.Fail('no_payout', 'Set the payout wallet in api/_config.js and redeploy. Only that wallet can open the till.', 403);

  if (op === 'challenge') {
    const n = { kind: 'n', nonce: require('crypto').randomBytes(12).toString('hex'), exp: L.now() + 5 * 60000 };
    return L.send(res, 200, { ok: true, msg: msgFor(n), nt: await L.signTok(n) });
  }
  if (op === 'login') {
    const n = await L.readTok(b.nt, 'n');
    if (!n) throw new L.Fail('expired', 'Sign-in expired. Try again.', 401);
    if (b.pub !== C.payout) throw new L.Fail('wrong_wallet', 'Connect the payout wallet. Only it can open the till.', 403);
    if (!L.verifyEd25519(b.pub, msgFor(n), b.sig)) throw new L.Fail('bad_sig', 'That signature didn\'t check out.', 401);
    return L.send(res, 200, { ok: true, tok: await L.signTok({ kind: 'till', w: b.pub, exp: L.now() + 8 * 3600000 }) });
  }

  const t = await L.readTok(b.tok, 'till');
  if (!t || t.w !== C.payout) throw new L.Fail('signin', 'Sign in again.', 401);

  if (op === 'queue') {
    const [doc, price, bal] = await Promise.all([L.readDb({ fresh: true }), L.solPrice(), L.rpc('getBalance', [C.payout, { commitment: 'confirmed' }]).catch(() => null)]);
    const all = Object.values((doc && doc.claims) || {});
    const pick = c => ({ id: c.i, h: c.dh || c.h, name: c.nm, fo: c.fo, po: c.po, age: c.age, w: c.w, ts: c.ts, st: c.st, n: c.n, sig: c.sig, lam: c.lam, usd: c.usd ? c.usd / 100 : null, pt: c.pt, why: c.why });
    return L.send(res, 200, { ok: true, price, balance: bal ? bal.value / 1e9 : null, amountUsd: C.amountUsd,
      lamports: price ? Math.round(C.amountUsd / price * 1e9) : null,
      stats: L.statsOf(doc || { claims: {} }, price),
      queue: all.filter(c => c.st === 'q').sort((a, b2) => a.ts - b2.ts).map(pick),
      paid: all.filter(c => c.st === 'p').sort((a, b2) => (b2.n || 0) - (a.n || 0)).slice(0, 40).map(pick),
      rejected: all.filter(c => c.st === 'x').sort((a, b2) => b2.ts - a.ts).slice(0, 40).map(pick) });
  }
  if (op === 'blockhash') {
    const [r, price] = await Promise.all([L.rpc('getLatestBlockhash', [{ commitment: 'confirmed' }]), L.solPrice()]);
    if (!price) throw new L.Fail('no_price', 'Couldn\'t get the SOL price. Try again in a minute.', 502);
    return L.send(res, 200, { ok: true, blockhash: r.value.blockhash, lastValidBlockHeight: r.value.lastValidBlockHeight, memo: b.id ? memoFor(b.id) : null,
      price, lamports: Math.round(C.amountUsd / price * 1e9) });
  }
  if (op === 'mark') {
    const doc = await L.readDb({ fresh: true }), c = doc && doc.claims[b.id];
    if (!c) throw new L.Fail('not_found', 'No claim with that number.', 404);
    if (c.st === 'p') return L.send(res, 200, { ok: true, already: true });
    if (typeof b.sig !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(b.sig)) throw new L.Fail('bad_sig', 'That isn\'t a transaction signature.');
    const f = await L.checkTxForClaim(b.sig, c);
    if (f === null) throw new L.Fail('not_yet', 'Not confirmed yet. Checking again…', 409);
    if (f === false) throw new L.Fail('no_transfer', 'That transaction doesn\'t send SOL from the payout wallet to this claim\'s wallet.');
    const done = await L.markPaid(c.i, f);
    return L.send(res, 200, { ok: true, n: done.n });
  }
  if (op === 'reject' || op === 'restore') {
    const why = String(b.why || '').slice(0, 140);
    await L.mutate(doc => {
      const c = doc.claims[b.id];
      if (!c) throw new L.Fail('not_found', 'No claim with that number.', 404);
      if (c.st === 'p') throw new L.Fail('paid', 'Already paid.');
      if (op === 'reject') { c.st = 'x'; c.why = why || 'Didn\'t pass review.'; } else { c.st = 'q'; delete c.why; }
      return c;
    });
    return L.send(res, 200, { ok: true });
  }
  if (op === 'sync') {
    // Finds payouts sent outside the till: scans the payout wallet's recent transactions.
    const doc = await L.readDb({ fresh: true });
    const all = Object.values((doc && doc.claims) || {});
    const used = new Set(all.filter(c => c.sig).map(c => c.sig));
    const byWallet = new Map(all.filter(c => c.st === 'q').map(c => [c.w, c]));
    const sigs = await L.rpc('getSignaturesForAddress', [C.payout, { limit: 60, commitment: 'confirmed' }]);
    let checked = 0, marked = 0;
    for (const s of sigs || []) {
      if (s.err || used.has(s.signature) || !byWallet.size) continue;
      const memo = String(s.memo || '');
      checked++;
      const tx = await L.getTx(s.signature).catch(() => null);
      if (!tx) continue;
      for (const tr of L.transfersFrom(tx, C.payout)) {
        const c = byWallet.get(tr.to);
        if (!c) continue;
        const lam = L.transfersFrom(tx, C.payout).filter(x => x.to === c.w).reduce((a, x) => a + x.lamports, 0);
        await L.markPaid(c.i, { sig: s.signature, lam, pt: tx.blockTime ? tx.blockTime * 1000 : L.now() }).catch(() => null);
        byWallet.delete(tr.to); marked++; break;
      }
      void memo;
    }
    return L.send(res, 200, { ok: true, checked, marked });
  }
  throw new L.Fail('bad_op', 'Unknown till action.');
});
