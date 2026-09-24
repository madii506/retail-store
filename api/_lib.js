// RETAIL server library: storage, crypto, X reader, Solana RPC, price.
// No private keys live here. Payouts are signed by the operator in their own wallet on /till.
const crypto = require('crypto');
const fs = require('fs');
const CFG = require('./_config');

const MOCK = () => globalThis.__RETAIL_MOCK || null; // dev-only hook, set by the local test server
const now = () => Date.now();
const DAY = 86400000;
const dayKey = (t = now()) => new Date(t).toISOString().slice(0, 10);

/* ---------------- http helpers ---------------- */
function send(res, code, obj, cache = 'no-store') {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', cache);
  res.end(JSON.stringify(obj));
}
async function body(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') { try { return JSON.parse(req.body); } catch { return {}; } }
  const chunks = [];
  let size = 0;
  for await (const c of req) { size += c.length; if (size > 20000) break; chunks.push(c); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { return {}; }
}
function query(req) {
  if (req.query) return req.query;
  const u = new URL(req.url, 'http://x');
  return Object.fromEntries(u.searchParams);
}
function clientIp(req) {
  const h = req.headers || {};
  return String(h['x-real-ip'] || (h['x-forwarded-for'] || '').split(',')[0] || (req.socket && req.socket.remoteAddress) || '0').trim();
}
class Fail extends Error { constructor(reason, msg, code = 400) { super(msg); this.reason = reason; this.code = code; } }
function wrap(fn) {
  return async (req, res) => {
    try { await fn(req, res); }
    catch (e) {
      if (e instanceof Fail) return send(res, e.code, { ok: false, reason: e.reason, msg: e.message });
      console.error('[retail]', e && e.stack || e);
      return send(res, 500, { ok: false, reason: 'server', msg: 'Something broke on our side. Try again in a minute.' });
    }
  };
}

/* ---------------- rate limit (per instance, best effort) ---------------- */
const hits = new Map();
function limit(key, max, windowMs) {
  if (MOCK() && MOCK().nolimit) return;
  const t = now(), arr = (hits.get(key) || []).filter(x => t - x < windowMs);
  if (arr.length >= max) throw new Fail('slow_down', 'Too many tries. Wait a minute and try again.', 429);
  arr.push(t); hits.set(key, arr);
  if (hits.size > 5000) hits.clear();
}

/* ---------------- storage: one private JSON doc with optimistic writes ---------------- */
const DB_PATH = 'db/retail.json';
const onVercel = !!process.env.VERCEL;
const hasBlob = () => !!(process.env.BLOB_READ_WRITE_TOKEN || process.env.BLOB_STORE_ID);
const storageOn = () => hasBlob() || !onVercel || !!MOCK();
const LOCAL = process.env.RETAIL_DATA || '/tmp/retail-db.json';

function freshDoc() {
  return { v: 1, k: crypto.randomBytes(32).toString('hex'), claims: {}, h: {}, w: {}, seq: 0 };
}
async function rawRead(fresh) {
  if (!hasBlob()) {
    if (!fs.existsSync(LOCAL)) return { doc: null, etag: null };
    const text = fs.readFileSync(LOCAL, 'utf8');
    return { doc: JSON.parse(text), etag: crypto.createHash('md5').update(text).digest('hex') };
  }
  const { get } = require('@vercel/blob');
  const r = await get(DB_PATH, { access: 'private', useCache: !fresh });
  if (!r || r.statusCode !== 200) return { doc: null, etag: null };
  const text = await new Response(r.stream).text();
  return { doc: JSON.parse(text), etag: r.blob.etag };
}
async function rawWrite(doc, etag) {
  const text = JSON.stringify(doc);
  if (!hasBlob()) {
    const cur = fs.existsSync(LOCAL) ? fs.readFileSync(LOCAL, 'utf8') : null;
    const curTag = cur == null ? null : crypto.createHash('md5').update(cur).digest('hex');
    if (curTag !== etag) { const e = new Error('precondition'); e.precondition = true; throw e; }
    fs.writeFileSync(LOCAL + '.tmp', text); fs.renameSync(LOCAL + '.tmp', LOCAL);
    return crypto.createHash('md5').update(text).digest('hex');
  }
  const { put } = require('@vercel/blob');
  const opts = { access: 'private', addRandomSuffix: false, contentType: 'application/json', cacheControlMaxAge: 60 };
  if (etag) { opts.allowOverwrite = true; opts.ifMatch = etag; } else { opts.allowOverwrite = false; }
  try { return (await put(DB_PATH, text, opts)).etag; }
  catch (e) {
    const m = String(e && e.message || e);
    if (/precondition|already exists|etag/i.test(m) || (e && e.constructor && e.constructor.name === 'BlobPreconditionFailedError')) { e.precondition = true; }
    throw e;
  }
}
let mem = null; // { doc, etag, at }
async function readDb({ fresh = false, maxAge = 15000 } = {}) {
  if (!storageOn()) throw new Fail('no_storage', 'The store opens at launch.', 503);
  if (!fresh && mem && now() - mem.at < maxAge) return mem.doc;
  const r = await rawRead(fresh);
  if (r.doc) mem = { doc: r.doc, etag: r.etag, at: now() };
  return r.doc;
}
let chain = Promise.resolve();
function mutate(fn) {
  const run = async () => {
    if (!storageOn()) throw new Fail('no_storage', 'The store opens at launch.', 503);
    for (let attempt = 0; attempt < 7; attempt++) {
      const { doc: cur, etag } = await rawRead(true);
      const doc = cur || freshDoc();
      const out = await fn(doc, !cur);
      if (out && out.__skip) return out.value;
      try {
        const tag = await rawWrite(doc, cur ? etag : null);
        mem = { doc, etag: tag, at: now() };
        return out;
      } catch (e) {
        if (!e.precondition) throw e;
        await new Promise(r => setTimeout(r, 80 + Math.random() * 220 * (attempt + 1)));
      }
    }
    throw new Fail('busy', 'The store is busy. Try again in a few seconds.', 503);
  };
  const p = chain.then(run, run);
  chain = p.catch(() => {});
  return p;
}
const skip = value => ({ __skip: true, value });

let secretMem = null;
async function secret() {
  if (process.env.RETAIL_SECRET) return process.env.RETAIL_SECRET;
  if (secretMem) return secretMem;
  let doc = await readDb({ maxAge: 3600000 });
  if (!doc) { await mutate((d, isNew) => isNew ? { created: true } : skip(null)); doc = await readDb({ fresh: true }); }
  if (!doc || !doc.k) throw new Fail('no_storage', 'The store opens at launch.', 503);
  secretMem = doc.k; return secretMem;
}

/* ---------------- crypto ---------------- */
const hmac = (key, msg) => crypto.createHmac('sha256', key).update(msg).digest();
const b64u = buf => Buffer.from(buf).toString('base64url');
const ALPHA = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
function b32(buf, n) { let s = ''; for (let i = 0; i < n; i++) s += ALPHA[buf[i] % ALPHA.length]; return s; }
const newId = () => b32(crypto.randomBytes(12), 7);

async function signTok(obj) {
  const k = await secret();
  const p = b64u(JSON.stringify(obj));
  return p + '.' + b64u(hmac(k, 'tok|' + p)).slice(0, 32);
}
async function readTok(tok, kind) {
  if (typeof tok !== 'string' || tok.length > 2000 || !tok.includes('.')) return null;
  const [p, s] = tok.split('.');
  const k = await secret();
  const want = b64u(hmac(k, 'tok|' + p)).slice(0, 32);
  if (!s || s.length !== want.length || !crypto.timingSafeEqual(Buffer.from(s), Buffer.from(want))) return null;
  let o; try { o = JSON.parse(Buffer.from(p, 'base64url').toString('utf8')); } catch { return null; }
  if (!o || o.kind !== kind || !(o.exp > now())) return null;
  return o;
}
async function codeFor(handle, t = now()) {
  const k = await secret();
  return 'RETAIL-' + b32(hmac(k, 'code|' + handle.toLowerCase() + '|' + dayKey(t)), 5);
}

/* base58 (Solana addresses) */
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function b58decode(s) {
  if (typeof s !== 'string' || !s || s.length > 64) return null;
  let bytes = [0];
  for (const ch of s) {
    const v = B58.indexOf(ch); if (v < 0) return null;
    let carry = v;
    for (let i = 0; i < bytes.length; i++) { carry += bytes[i] * 58; bytes[i] = carry & 255; carry >>= 8; }
    while (carry) { bytes.push(carry & 255); carry >>= 8; }
  }
  for (const ch of s) { if (ch === '1') bytes.push(0); else break; }
  return Buffer.from(bytes.reverse());
}
function validWallet(s) { const b = b58decode(String(s || '').trim()); return !!b && b.length === 32; }
const SYSTEM = '11111111111111111111111111111111';

function verifyEd25519(pubB58, msg, sigB64) {
  const pub = b58decode(pubB58); if (!pub || pub.length !== 32) return false;
  let sig; try { sig = Buffer.from(String(sigB64), 'base64'); } catch { return false; }
  if (sig.length !== 64) return false;
  const key = crypto.createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), pub]), format: 'der', type: 'spki' });
  try { return crypto.verify(null, Buffer.from(msg, 'utf8'), key, sig); } catch { return false; }
}

/* ---------------- X profile reader ---------------- */
function normHandle(s) {
  const h = String(s || '').trim().replace(/^https?:\/\/(www\.)?(x|twitter)\.com\//i, '').replace(/^@/, '').replace(/[/?#].*$/, '');
  return /^[A-Za-z0-9_]{1,15}$/.test(h) ? h : null;
}
function xJoined(u) {
  const t = Date.parse(u.joined || u.created_at || '');
  if (Number.isFinite(t) && t > 1136073600000) return t;
  try { const id = BigInt(u.id || u.rest_id || 0); const ts = Number(id >> 22n) + 1288834974657; if (ts > 1300000000000 && ts < now()) return ts; } catch {}
  return null;
}
async function readX(handle) {
  const m = MOCK(); if (m && m.x) return m.x(handle);
  const url = `https://api.fxtwitter.com/${encodeURIComponent(handle)}?t=${Math.floor(now() / 20000)}`;
  let r;
  try { r = await fetch(url, { headers: { 'user-agent': 'RETAIL-store/1.0 (+bio check)', accept: 'application/json' }, signal: AbortSignal.timeout(8000) }); }
  catch { throw new Fail('x_down', "We couldn't reach X right now. Try again in a minute.", 502); }
  let j = null; try { j = await r.json(); } catch {}
  if (r.status === 404 || (j && j.code === 404)) throw new Fail('not_found', `We couldn't find @${handle} on X. Check the spelling.`);
  const u = j && (j.user || (j.data && j.data.user));
  if (!r.ok || !u) throw new Fail('x_down', "X didn't answer. Try again in a minute.", 502);
  return {
    handle: u.screen_name || handle,
    name: u.name || '',
    bio: String(u.description || u.raw_description && u.raw_description.text || ''),
    followers: Number(u.followers ?? u.followers_count ?? 0) || 0,
    posts: Number(u.tweets ?? u.statuses_count ?? 0) || 0,
    joined: xJoined(u),
    protected: !!u.protected,
  };
}

/* ---------------- Solana RPC ---------------- */
function rpcUrls() {
  return [process.env.RPC_URL, 'https://api.mainnet-beta.solana.com', 'https://solana-rpc.publicnode.com'].filter(Boolean);
}
async function rpc(method, params = []) {
  const m = MOCK(); if (m && m.rpc) return m.rpc(method, params);
  let last;
  for (const u of rpcUrls()) {
    try {
      const r = await fetch(u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(9000) });
      if (!r.ok) { last = new Error('rpc ' + r.status); continue; }
      const j = await r.json();
      if (j.error) { last = new Error(j.error.message || 'rpc error'); continue; }
      return j.result;
    } catch (e) { last = e; }
  }
  throw new Fail('rpc_down', 'Solana RPC is busy. Try again in a minute.', 502);
}
async function getTx(sig) {
  return rpc('getTransaction', [sig, { encoding: 'jsonParsed', commitment: 'confirmed', maxSupportedTransactionVersion: 0 }]);
}
function allIx(tx) {
  const out = [...((tx && tx.transaction && tx.transaction.message && tx.transaction.message.instructions) || [])];
  for (const g of (tx && tx.meta && tx.meta.innerInstructions) || []) out.push(...(g.instructions || []));
  return out;
}
function transfersFrom(tx, from) {
  if (!tx || !tx.meta || tx.meta.err) return [];
  return allIx(tx).filter(ix => ix.program === 'system' && ix.parsed && ix.parsed.type === 'transfer' && ix.parsed.info && ix.parsed.info.source === from)
    .map(ix => ({ to: ix.parsed.info.destination, lamports: Number(ix.parsed.info.lamports) || 0 }));
}
function memoOf(tx) {
  for (const ix of allIx(tx)) if (ix.program === 'spl-memo' && typeof ix.parsed === 'string') return ix.parsed;
  return '';
}

let balMem = null;
async function payoutBalance() {
  if (!CFG.payout) return null;
  if (balMem && now() - balMem.at < 30000) return balMem.v;
  const r = await rpc('getBalance', [CFG.payout, { commitment: 'confirmed' }]);
  const v = r && typeof r.value === 'number' ? r.value / 1e9 : null;
  balMem = { v, at: now() }; return v;
}

/* ---------------- SOL price ---------------- */
let priceMem = null;
async function solPrice() {
  const m = MOCK(); if (m && m.price) return m.price();
  if (priceMem && now() - priceMem.at < 60000) return priceMem.v;
  const srcs = [
    ['https://api.coinbase.com/v2/prices/SOL-USD/spot', j => +j.data.amount],
    ['https://api.kraken.com/0/public/Ticker?pair=SOLUSD', j => +Object.values(j.result)[0].c[0]],
    ['https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd', j => +j.solana.usd],
  ];
  for (const [u, pick] of srcs) {
    try {
      const r = await fetch(u, { signal: AbortSignal.timeout(5000) });
      if (!r.ok) continue;
      const v = pick(await r.json());
      if (v > 1 && v < 100000) { priceMem = { v, at: now() }; return v; }
    } catch {}
  }
  return priceMem ? priceMem.v : null;
}

/* ---------------- views ---------------- */
function mask(h) {
  h = String(h || '');
  if (h.length <= 3) return h[0] + '••';
  return h.slice(0, 2) + '•'.repeat(Math.min(4, h.length - 3)) + h.slice(-1);
}
const short = w => w ? w.slice(0, 4) + '…' + w.slice(-4) : '';
function queueOf(doc) {
  return Object.values(doc.claims).filter(c => c.st === 'q').sort((a, b) => a.ts - b.ts);
}
function statsOf(doc, price) {
  const today = dayKey();
  const all = Object.values(doc.claims);
  const todayN = all.filter(c => dayKey(c.ts) === today && c.st !== 'x').length;
  const paid = all.filter(c => c.st === 'p');
  const lam = paid.reduce((a, c) => a + (c.lam || 0), 0);
  return {
    today: todayN, cap: CFG.dailyCap, left: Math.max(0, CFG.dailyCap - todayN),
    queue: all.filter(c => c.st === 'q').length,
    paid: paid.length, paidSol: lam / 1e9, paidUsd: paid.reduce((a, c) => a + (c.usd || 0), 0) / 100,
    lastPaidAt: paid.reduce((a, c) => Math.max(a, c.pt || 0), 0) || null,
    price,
  };
}
function receiptOf(c) {
  return { n: c.n, id: c.i, h: mask(c.h), sol: (c.lam || 0) / 1e9, usd: (c.usd || 0) / 100, sig: c.sig, t: c.pt };
}
function publicCfg() {
  return { name: CFG.name, ticker: CFG.ticker, ca: CFG.ca, payout: CFG.payout, x: CFG.x, amountUsd: CFG.amountUsd, dailyCap: CFG.dailyCap, open: CFG.open,
    minAgeDays: CFG.minAgeDays, minFollowers: CFG.minFollowers, minPosts: CFG.minPosts, maxWalletTxs: CFG.maxWalletTxs, storage: storageOn() };
}

/* mark a claim paid after checking the transaction on-chain */
async function checkTxForClaim(sig, claim) {
  const tx = await getTx(sig);
  if (!tx) return null;
  const lam = transfersFrom(tx, CFG.payout).filter(t => t.to === claim.w).reduce((a, t) => a + t.lamports, 0);
  if (!lam) return false;
  return { sig, lam, pt: (tx.blockTime ? tx.blockTime * 1000 : now()) };
}
async function markPaid(id, found) {
  const price = await solPrice();
  return mutate(doc => {
    const c = doc.claims[id];
    if (!c) throw new Fail('not_found', 'No claim with that number.', 404);
    if (c.st === 'p') return skip(c);
    // one transaction pays one claim
    if (Object.values(doc.claims).some(o => o.sig === found.sig)) throw new Fail('tx_used', 'That transaction already paid another claim.');
    c.st = 'p'; c.sig = found.sig; c.lam = found.lam; c.pt = found.pt;
    c.usd = price ? Math.round(found.lam / 1e9 * price * 100) : 0;
    doc.paidN = (doc.paidN || 0) + 1; c.n = doc.paidN;
    return c;
  });
}
// look for a payout to this claim's wallet (used by the status page)
const lastLook = new Map();
async function lookForPayout(claim) {
  if (!CFG.payout || claim.st !== 'q') return null;
  const t = lastLook.get(claim.i) || 0;
  if (now() - t < 15000) return null;
  lastLook.set(claim.i, now());
  const sigs = await rpc('getSignaturesForAddress', [claim.w, { limit: 15, commitment: 'confirmed' }]);
  for (const s of sigs || []) {
    if (s.err) continue;
    const f = await checkTxForClaim(s.signature, claim).catch(() => null);
    if (f) return markPaid(claim.i, f).catch(() => null);
  }
  return null;
}

module.exports = {
  CFG, send, body, query, clientIp, Fail, wrap, limit, now, DAY, dayKey,
  readDb, mutate, skip, secret, storageOn, signTok, readTok, codeFor, newId, hmac,
  validWallet, verifyEd25519, normHandle, readX, rpc, getTx, payoutBalance, transfersFrom, memoOf, solPrice,
  mask, short, queueOf, statsOf, receiptOf, publicCfg, checkTxForClaim, markPaid, lookForPayout, SYSTEM,
};
