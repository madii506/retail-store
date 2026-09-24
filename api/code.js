// POST /api/code {handle} — the code to put in your X bio. Same handle + same UTC day = same code.
const L = require('./_lib');
module.exports = L.wrap(async (req, res) => {
  if (req.method !== 'POST') throw new L.Fail('method', 'POST only.', 405);
  L.limit('code:' + L.clientIp(req), 20, 60000);
  const b = await L.body(req);
  const handle = L.normHandle(b.handle);
  if (!handle) throw new L.Fail('bad_handle', 'That doesn\'t look like an X username. Letters, numbers and _ only, up to 15.');
  if (!L.CFG.open) throw new L.Fail('closed', 'Claims are paused right now. Check back soon.', 403);
  const doc = await L.readDb({ fresh: true });
  if (doc && doc.h[handle.toLowerCase()]) throw new L.Fail('already', `@${handle} already claimed. One per person.`);
  L.send(res, 200, { ok: true, handle, code: await L.codeFor(handle) });
});
