// POST /api/verify {handle} — reads the public X profile and checks the bio code + basic anti-bot rules.
const L = require('./_lib');
module.exports = L.wrap(async (req, res) => {
  if (req.method !== 'POST') throw new L.Fail('method', 'POST only.', 405);
  const b = await L.body(req);
  const handle = L.normHandle(b.handle);
  if (!handle) throw new L.Fail('bad_handle', 'That doesn\'t look like an X username.');
  L.limit('verify:' + L.clientIp(req), 12, 60000);
  L.limit('verify-h:' + handle.toLowerCase(), 6, 60000);
  const C = L.CFG, h = handle.toLowerCase();
  const doc = await L.readDb({ fresh: true });
  if (doc && doc.h[h]) throw new L.Fail('already', `@${handle} already claimed. One per person.`);
  const p = await L.readX(handle);
  if (p.protected) throw new L.Fail('protected', 'Your posts are protected, so we can\'t read your bio. Make your account public for a minute, then check again.');
  const bio = p.bio.toUpperCase().replace(/\s+/g, '');
  const codes = [await L.codeFor(handle), await L.codeFor(handle, L.now() - L.DAY)];
  if (!codes.some(c => bio.includes(c))) throw new L.Fail('no_code', `We can't see ${codes[0]} in @${p.handle}'s bio yet. Save your bio, wait a few seconds, then check again. X can take up to a minute to show a new bio.`);
  const ageDays = p.joined ? Math.floor((L.now() - p.joined) / L.DAY) : null;
  if (ageDays !== null && ageDays < C.minAgeDays) throw new L.Fail('too_new', `Your X account needs to be at least ${C.minAgeDays} days old. Yours is ${ageDays}.`);
  if (p.followers < C.minFollowers) throw new L.Fail('too_small', `You need at least ${C.minFollowers} followers. You have ${p.followers}.`);
  if (p.posts < C.minPosts) throw new L.Fail('too_quiet', `You need at least ${C.minPosts} posts. You have ${p.posts}.`);
  const vt = await L.signTok({ kind: 'v', h, dh: p.handle, name: String(p.name).slice(0, 50), fo: p.followers, po: p.posts, age: ageDays, exp: L.now() + 30 * 60000 });
  L.send(res, 200, { ok: true, vt, profile: { handle: p.handle, name: p.name, followers: p.followers, posts: p.posts, ageDays } });
});
