// Shared bits: ticker, nav, API helper, formatting, reveal-on-scroll, toast.
(function () {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  async function api(path, data) {
    const opt = data ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) } : { cache: 'no-store' };
    let r, j;
    try { r = await fetch('/api/' + path, opt); } catch { return { ok: false, reason: 'offline', msg: 'You look offline. Check your connection and try again.' }; }
    try { j = await r.json(); } catch { j = { ok: false, reason: 'server', msg: 'Something broke on our side. Try again in a minute.' }; }
    if (!r.ok && j.ok !== false) j.ok = false;
    return j;
  }
  let storeP = null;
  const store = () => storeP || (storeP = api('store'));

  const fmt = {
    sol: n => n == null ? '—' : (n >= 100 ? n.toFixed(1) : n >= 1 ? n.toFixed(3) : n.toFixed(4)),
    usd: n => n == null ? '—' : '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
    int: n => n == null ? '—' : Number(n).toLocaleString('en-US'),
    date: t => t ? new Date(t).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—',
    ago: t => { if (!t) return '—'; const s = (Date.now() - t) / 1000; if (s < 60) return 'just now'; if (s < 3600) return Math.floor(s / 60) + ' min ago'; if (s < 86400) return Math.floor(s / 3600) + ' h ago'; return Math.floor(s / 86400) + ' d ago'; },
    short: w => w ? w.slice(0, 4) + '…' + w.slice(-4) : '—',
    pad: n => String(n || 0).padStart(6, '0'),
  };
  const solscan = { tx: s => 'https://solscan.io/tx/' + s, acct: a => 'https://solscan.io/account/' + a };

  function toast(text, ms = 2600) {
    let t = $('.toast'); if (!t) { t = document.createElement('div'); t.className = 'toast'; t.setAttribute('role', 'status'); document.body.appendChild(t); }
    t.textContent = text; t.classList.add('on'); clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('on'), ms);
  }
  async function copy(text, label = 'Copied') {
    try { await navigator.clipboard.writeText(text); toast(label); return true; }
    catch { const ta = document.createElement('textarea'); ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0'; document.body.appendChild(ta); ta.select(); let ok = false; try { ok = document.execCommand('copy'); } catch {} ta.remove(); toast(ok ? label : 'Copy failed. Press and hold to copy.'); return ok; }
  }

  // ---- header ----
  const here = location.pathname.replace(/\.html$/, '').replace(/\/$/, '') || '/';
  const links = [['/#how', 'How it works'], ['/receipts', 'Receipts'], ['/learn', 'Learn'], ['/#policies', 'Rules'], ['/#faq', 'FAQ']];
  function header() {
    const h = $('#top'); if (!h) return;
    h.innerHTML = `
      <nav class="nav" aria-label="Main"><div class="wrap"><div class="bar">
        <a class="brand" href="/" aria-label="RETAIL home"><img src="/assets/img/mark-plain.svg" alt="" width="46" height="40"><b>RETAIL</b></a>
        <div class="links">${links.map(([u, l]) => `<a href="${u}"${u === here ? ' aria-current="page"' : ''}>${l}</a>`).join('')}</div>
        <button class="menu" aria-label="Menu" aria-expanded="false"><span></span></button>
      </div></div></nav>
      <div class="sheet" role="dialog" aria-label="Menu"><div class="in"><button class="x" aria-label="Close">×</button>
        ${[['/', 'Store'], ['/status', 'My ticket'], ...links].map(([u, l]) => `<a href="${u}">${l}</a>`).join('')}
      </div></div>`;
    const sh = $('.sheet'), mb = $('.menu');
    const set = o => { sh.classList.toggle('open', o); mb.setAttribute('aria-expanded', o); document.body.style.overflow = o ? 'hidden' : ''; };
    mb.onclick = () => set(true); $('.sheet .x').onclick = () => set(false);
    sh.onclick = e => { if (e.target === sh || e.target.tagName === 'A') set(false); };
    document.addEventListener('keydown', e => { if (e.key === 'Escape') set(false); });
  }

  function reveal() {
    const els = $$('.reveal');
    if (!('IntersectionObserver' in window)) { els.forEach(e => e.classList.add('in')); return; }
    const io = new IntersectionObserver(es => es.forEach(e => { if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); } }), { rootMargin: '0px 0px -10% 0px' });
    els.forEach(e => io.observe(e));
  }

  // receipt card used on home + wall
  function receiptCard(r, i = 0) {
    const rot = [-2.2, 1.6, -1, 2.4, -1.8, 1.1][i % 6];
    return `<a class="rcard" style="--rot:${rot}deg" href="${solscan.tx(r.sig)}" target="_blank" rel="noopener" aria-label="Receipt ${r.n}, check on Solscan">
      <div class="rcsh"><div class="rc">
        <h4>RETAIL</h4><div class="sub">RECEIPT #${fmt.pad(r.n)}</div><hr>
        <div class="ln"><span>CUSTOMER</span><span>@${esc(r.h)}</span></div>
        <div class="ln"><span>1x FIRST TRADE</span><span>${r.usd ? fmt.usd(r.usd) : '$20'}</span></div>
        <div class="ln"><span>PAID IN SOL</span><span>${fmt.sol(r.sol)}</span></div><hr>
        <div class="ln"><span>${fmt.date(r.t)}</span><span>TX ${esc(r.sig.slice(0, 5))}…</span></div>
        <div class="bars"></div><div class="ty">CHECK ON SOLSCAN ↗</div>
      </div></div><div class="paid">PAID</div></a>`;
  }
  function emptyReceipt() {
    return `<div class="rcard empty" style="--rot:-1.5deg"><div class="rcsh"><div class="rc">
      <h4>RETAIL</h4><div class="sub">RECEIPT #000001</div><hr>
      <div class="ln"><span>CUSTOMER</span><span>you?</span></div>
      <div class="ln"><span>1x FIRST TRADE</span><span>$20.00</span></div>
      <div class="ln"><span>FIRST-TIMER</span><span>-$20.00</span></div><hr>
      <div class="c">The first receipt prints here.</div><div class="bars"></div><div class="ty">NEXT CUSTOMER PLEASE</div>
    </div></div></div>`;
  }

  window.R = { $, $$, esc, api, store, fmt, solscan, toast, copy, receiptCard, emptyReceipt };
  // living background: slow floating store bits behind every page
  function bgfx() {
    if (document.querySelector('.bgfx')) return;
    const tag = t => `<svg viewBox="0 0 120 64"><path d="M22 4H112a6 6 0 0 1 6 6V54a6 6 0 0 1-6 6H22L3 32Z" fill="#ffe14d" stroke="#141414" stroke-width="4" stroke-linejoin="round"/><circle cx="18" cy="32" r="5" fill="#fff3e0" stroke="#141414" stroke-width="3"/><text x="68" y="43" text-anchor="middle" font-family="Lucky,Nunito" font-size="30" fill="#141414">${t}</text></svg>`;
    const coin = t => `<svg viewBox="0 0 64 64"><circle cx="32" cy="32" r="28" fill="#ffab4a" stroke="#141414" stroke-width="4"/><circle cx="32" cy="32" r="19" fill="none" stroke="#141414" stroke-width="3" stroke-dasharray="4 5"/><text x="32" y="42" text-anchor="middle" font-family="Lucky,Nunito" font-size="26" fill="#141414">${t}</text></svg>`;
    const rec = `<svg viewBox="0 0 60 80"><path d="M4 4H56V70l-6-5-6 5-6-5-6 5-6-5-6 5-6-5-6 5Z" fill="#fffdf7" stroke="#141414" stroke-width="3.5" stroke-linejoin="round"/><path d="M13 18H47M13 28H40M13 38H47" stroke="#141414" stroke-width="3" stroke-linecap="round"/><path d="M13 50H47" stroke="#ff8a1e" stroke-width="5" stroke-linecap="round"/></svg>`;
    const star = c => `<svg viewBox="0 0 40 40"><path d="M20 2C22 14 26 18 38 20C26 22 22 26 20 38C18 26 14 22 2 20C14 18 18 14 20 2Z" fill="${c}" stroke="#141414" stroke-width="2.5" stroke-linejoin="round"/></svg>`;
    const sticker = t => `<svg viewBox="0 0 100 100"><circle cx="50" cy="50" r="44" fill="#141414"/><circle cx="50" cy="50" r="38" fill="none" stroke="#ffab4a" stroke-width="2.5" stroke-dasharray="5 4"/><text x="50" y="60" text-anchor="middle" font-family="Lucky,Nunito" font-size="28" fill="#ffab4a">${t}</text></svg>`;
    const items = [
      [tag('$0'), 4, 12, 96, 22], [coin('$'), 88, 8, 58, 26], [rec, 12, 58, 52, 30], [star('#ff8a1e'), 30, 26, 30, 18],
      [sticker('FREE'), 76, 44, 78, 34], [tag('FREE'), 60, 82, 104, 28], [coin('20'), 20, 88, 62, 24], [star('#ffe14d'), 92, 70, 34, 20],
      [rec, 46, 6, 44, 36], [star('#fffdf7'), 6, 38, 26, 16], [coin('$'), 52, 52, 44, 32], [tag('$0'), 84, 92, 86, 30],
      [star('#ff8a1e'), 68, 20, 24, 22], [sticker('1ST'), 36, 72, 64, 38],
    ];
    const el = document.createElement('div');
    el.className = 'bgfx'; el.setAttribute('aria-hidden', 'true');
    el.innerHTML = '<i class="blob b1"></i><i class="blob b2"></i><i class="blob b3"></i>' + items.map(([svg, x, y, w, d], i) =>
      `<span style="left:${x}%;top:${y}%;width:${w}px;--d:${d}s;--r:${(i % 2 ? 1 : -1) * (8 + i * 3)}deg;animation-delay:-${i * 2.3}s">${svg}</span>`).join('');
    document.body.prepend(el);
  }

  document.addEventListener('DOMContentLoaded', () => { bgfx(); header(); reveal(); });
})();
