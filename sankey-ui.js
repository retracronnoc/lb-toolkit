/**
 * Toolkit for Liquid Budget — "Cash Flow" tab on Reports (a Sankey chart).
 *
 * Adds a Cash Flow tab after Income vs Expense. It shows where the month's
 * money came from and where it went — income sources → Budget → categories →
 * buckets — counting every transaction in the month, cleared, pending and
 * scheduled. Pending and scheduled amounts are drawn striped and lighter.
 * The tab lives at the Reports URL plus #lbt-cashflow.
 *
 * The app's tabs are Radix tabs; ours is a look-alike button in the same tab
 * list. While it's active, the app's report content is hidden (not removed)
 * and the chart is shown in its place. Data comes from the app's own lists,
 * read with the signed-in session; the math is in lib/cashflow-math.js.
 */
(function () {
  'use strict';

  const CF = globalThis.LBTCashFlow;
  const KEY = 'cashFlowTab';
  const HASH = '#lbt-cashflow';
  const ROOT_ID = 'lbt-cf-root';
  const MAX_AGE_MS = 60 * 1000;
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  // Categorical slots 2–8 of the Toolkit's validated palette (slot 1, blue, is close to the app's inflow color).
  const LIGHT = ['#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#e34948'];
  const DARK = ['#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'];
  const SVGNS = 'http://www.w3.org/2000/svg';

  let on = true;
  const state = { budgetId: null, data: null, currency: 'USD', loading: false, fetchedAt: 0, ym: null, error: null };

  const pad = (n) => String(n).padStart(2, '0');
  const localToday = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
  const addMonths = (ym, n) => { const [y, m] = ym.split('-').map(Number); const i = y * 12 + m - 1 + n; return `${Math.floor(i / 12)}-${pad((i % 12) + 1)}`; };

  function reportsBudgetId() {
    const m = location.pathname.match(/^\/budget\/([0-9a-f-]{36})\/reports(?:\/[a-z0-9-]+)?\/?$/i); // every report tab has its own path (/reports/net-worth …)
    return m ? m[1] : null;
  }
  const wants = () => on && !!reportsBudgetId() && location.hash === HASH;

  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
    return el;
  }
  function s(tag, attrs, ...kids) {
    const el = document.createElementNS(SVGNS, tag);
    for (const [k, v] of Object.entries(attrs || {})) if (v != null && v !== false) el.setAttribute(k, v);
    for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
    return el;
  }

  function fmt(scale4) {
    let text;
    try {
      text = new Intl.NumberFormat('en-US', state.currency === 'NONE' ? { maximumFractionDigits: 0 } : { style: 'currency', currency: state.currency, maximumFractionDigits: 0, minimumFractionDigits: 0 }).format(scale4 / 10000);
    } catch {
      text = Math.round(scale4 / 10000).toLocaleString('en-US');
    }
    const cur = globalThis.LBTCurrency;
    return cur ? cur.strip(text) : text;
  }

  // ---------- data ----------

  async function getJson(url) {
    const r = await fetch(url, { credentials: 'same-origin', headers: { Accept: 'application/json' } });
    if (!r.ok) throw new Error(`Liquid Budget returned HTTP ${r.status}.`);
    return r.json();
  }

  async function load() {
    const id = state.budgetId;
    state.loading = true;
    try {
      const enc = encodeURIComponent(id);
      const [transactions, accounts, buckets, categories, budget] = await Promise.all([
        getJson(`/api/account/transaction/budget/${enc}`),
        getJson(`/api/account/budget/${enc}`),
        getJson(`/api/bucket/budget/${enc}`),
        getJson(`/api/category/budget/${enc}`),
        getJson(`/api/budget/${enc}`).catch(() => null),
      ]);
      if (state.budgetId !== id) return;
      state.data = { transactions, accounts, buckets, categories };
      if (budget && budget.currency) state.currency = budget.currency;
      state.error = null;
    } catch (e) {
      if (state.budgetId !== id) return;
      state.error = e.message || 'Could not load transactions.';
    }
    state.loading = false;
    state.fetchedAt = Date.now();
    render();
  }

  // ---------- tab ----------

  function tabList() {
    return [...document.querySelectorAll('main [role="tablist"]')].find((tl) => [...tl.children].some((b) => b.textContent.trim() === 'Overview')) || null;
  }

  function ensureTab(tl) {
    let btn = tl.querySelector('[data-lbt-tab]');
    if (!on) {
      if (btn) btn.remove();
      return null;
    }
    if (btn) return btn;
    const template = [...tl.children].find((b) => b.getAttribute('data-state') === 'inactive') || tl.firstElementChild;
    if (!template) return null;
    btn = template.cloneNode(false);
    for (const a of ['id', 'aria-controls', 'data-radix-collection-item']) btn.removeAttribute(a);
    btn.setAttribute('data-lbt-tab', '');
    btn.setAttribute('aria-selected', 'false');
    btn.setAttribute('data-state', 'inactive');
    btn.setAttribute('tabindex', '-1');
    btn.textContent = 'Cash Flow';
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (location.hash !== HASH) history.pushState(history.state, '', location.pathname + location.search + HASH);
      sync();
    });
    tl.append(btn);
    // Choosing any of the app's tabs leaves Cash Flow.
    if (tl.hasAttribute('data-lbt-cf-wired')) return btn;
    tl.setAttribute('data-lbt-cf-wired', '');
    tl.addEventListener('click', (e) => {
      const t = e.target.closest && e.target.closest('[role="tab"]');
      if (!t || t.hasAttribute('data-lbt-tab') || location.hash !== HASH) return;
      history.replaceState(history.state, '', location.pathname + location.search);
      sync();
    }, true);
    return btn;
  }

  function setTabActive(tl, btn, active) {
    if (!btn) return;
    btn.setAttribute('data-state', active ? 'active' : 'inactive');
    btn.setAttribute('aria-selected', String(active));
    const ind = tl.nextElementSibling && /\babsolute\b/.test(tl.nextElementSibling.className) ? tl.nextElementSibling : null;
    if (active) {
      tl.setAttribute('data-lbt-cf', '');
      if (ind) {
        ind.setAttribute('data-lbt-ind', '');
        ind.style.setProperty('--lbt-l', `${btn.offsetLeft}px`);
        ind.style.setProperty('--lbt-iw', `${btn.offsetWidth}px`);
      }
    } else {
      tl.removeAttribute('data-lbt-cf');
      if (ind) {
        ind.removeAttribute('data-lbt-ind');
        ind.style.removeProperty('--lbt-l');
        ind.style.removeProperty('--lbt-iw');
      }
    }
  }

  // The report content area: the <main> next to the header holding the tabs.
  function contentArea(tl) {
    let header = tl;
    while (header && header.parentElement && !(header.nextElementSibling && header.nextElementSibling.tagName === 'MAIN')) header = header.parentElement;
    return header && header.nextElementSibling && header.nextElementSibling.tagName === 'MAIN' ? header.nextElementSibling : null;
  }

  // ---------- render ----------

  function render() {
    const root = document.getElementById(ROOT_ID);
    if (!root) return;
    const today = localToday();
    const ym = state.ym || today.slice(0, 7);
    const [y, m] = ym.split('-').map(Number);
    const title = `${MONTHS[m - 1]} ${y}`;
    const navBtn = (label, delta, disabled) => h('button', {
      type: 'button',
      class: 'inline-flex h-8 w-8 items-center justify-center rounded-md border bg-background text-sm hover:bg-muted disabled:opacity-40',
      'aria-label': label,
      disabled,
      onclick: () => { state.ym = addMonths(ym, delta); render(); },
    }, delta < 0 ? '‹' : '›');

    const head = h('div', { class: 'flex flex-row items-center justify-between border-b p-6 py-3' },
      h('div', null,
        h('h3', { class: 'tracking-tight text-2xl font-bold pb-1' }, title),
        h('p', { class: 'text-sm text-muted-foreground' }, 'Cash flow for the month — every transaction, pending and scheduled included'),
      ),
      h('div', { class: 'flex items-center gap-1' },
        navBtn('Previous month', -1, false),
        h('span', { class: 'px-2 text-sm tabular-nums' }, `${MONTHS[m - 1].slice(0, 3)} ${y}`),
        navBtn('Next month', 1, ym >= addMonths(today.slice(0, 7), 1)),
      ),
    );
    const body = h('div', { class: 'relative p-6 lbt-cf-body' });
    const card = h('div', { class: 'rounded-xl border bg-card text-card-foreground shadow overflow-hidden' }, head, body);
    root.replaceChildren(h('div', { class: 'p-6' }, card));

    if (state.error) {
      body.append(h('p', { class: 'text-sm text-muted-foreground' }, `Couldn't load transactions: ${state.error}`));
      return;
    }
    if (!state.data) {
      body.append(h('p', { class: 'text-sm text-muted-foreground' }, 'Loading this month…'));
      return;
    }
    const f = CF.buildCashFlow({ ...state.data, ym, today });
    if (!f.inflow && !f.outflow) {
      body.append(h('p', { class: 'text-sm text-muted-foreground' }, 'No transactions in this month.'));
      return;
    }

    const up = (v) => (v ? ` (${fmt(v)} pending or scheduled)` : '');
    body.append(
      h('div', { class: 'lbt-cf-top' },
        h('div', { class: 'lbt-cf-summary text-sm tabular-nums' },
          h('span', null, h('span', { class: 'text-muted-foreground' }, 'In '), h('b', null, fmt(f.inflow)), h('span', { class: 'text-muted-foreground text-xs' }, up(f.inflowUp))),
          h('span', null, h('span', { class: 'text-muted-foreground' }, 'Out '), h('b', null, fmt(f.outflow)), h('span', { class: 'text-muted-foreground text-xs' }, up(f.outflowUp))),
          f.leftover ? h('span', null, h('span', { class: 'text-muted-foreground' }, 'Left over '), h('b', null, fmt(f.leftover))) : null,
          f.drawdown ? h('span', null, h('span', { class: 'text-muted-foreground' }, 'From balances '), h('b', null, fmt(f.drawdown))) : null,
        ),
        h('div', { class: 'lbt-cf-legend text-xs text-muted-foreground' },
          h('span', null, h('span', { class: 'lbt-cf-key' }), 'Cleared'),
          h('span', null, h('span', { class: 'lbt-cf-key up' }), 'Pending or scheduled'),
        ),
      ),
    );
    const chartBox = h('div', { class: 'relative w-full' });
    body.append(chartBox);
    drawSankey(chartBox, f);
  }

  function drawSankey(box, f) {
    const dark = document.documentElement.classList.contains('dark');
    const palette = dark ? DARK : LIGHT;
    const css = getComputedStyle(document.documentElement);
    const hsl = (v, fallback) => (css.getPropertyValue(v).trim() ? `hsl(${css.getPropertyValue(v).trim()})` : fallback);
    const inColor = hsl('--inflow', '#2a78d6');
    const neutral = hsl('--muted-foreground', '#888');
    const fg = hsl('--foreground', '#222');
    const cardBg = hsl('--card', '#fff');

    const total = (x) => x.now + x.up;
    // Nodes per column.
    const col0 = f.sources.map((x) => ({ ...x, color: x.kind === 'refund' ? neutral : inColor }));
    if (f.drawdown) col0.push({ name: 'From balances', now: f.drawdown, up: 0, color: neutral, plain: true });
    const T = Math.max(f.inflow + f.drawdown, 1);
    const budget = { name: 'Budget', now: T, up: 0, color: fg };
    const col2 = f.categories.map((c, i) => ({ ...c, color: c.id === '__other' ? neutral : palette[i % palette.length] }));
    if (f.leftover) col2.push({ name: 'Left over', now: f.leftover, up: 0, color: inColor, plain: true });
    const col3 = [];
    for (const c of col2) for (const b of c.buckets || []) col3.push({ ...b, color: c.color, parent: c });

    const W = Math.max(640, Math.round(box.clientWidth || 900));
    const rows = Math.max(col0.length, col2.length, col3.length);
    const H = Math.max(420, rows * 30);
    // Room for the labels: left of the income nodes, right of the bucket nodes.
    const labelW = (n) => Math.min(26, n.name.length) * 6.6 + fmt(total(n)).length * 6.2 + 18;
    const L = Math.round(Math.min(280, Math.max(120, ...col0.map(labelW))));
    const R = Math.round(Math.min(280, Math.max(150, ...col3.map(labelW))));
    const NW = 12;
    const PAD = 11;
    const span = W - L - R - NW;
    const xs = [L, L + span / 3, L + (2 * span) / 3, L + span];
    const cols = [col0, [budget], col2, col3];
    const sums = cols.map((c) => c.reduce((a, n) => a + total(n), 0));
    const k = Math.min(...cols.map((c, i) => (H - PAD * Math.max(0, c.length - 1)) / Math.max(sums[i], 1)));
    cols.forEach((c, ci) => {
      const used = sums[ci] * k + PAD * Math.max(0, c.length - 1);
      let y = (H - used) / 2;
      for (const n of c) {
        n.x = xs[ci];
        n.y = y;
        n.h = Math.max(1, total(n) * k);
        n.outY = y;
        n.inY = y;
        y += n.h + PAD;
      }
    });

    const svg = s('svg', { width: W, height: H + 8, viewBox: `0 -4 ${W} ${H + 8}`, class: 'lbt-cf-svg', role: 'img', 'aria-label': `Cash flow: ${fmt(f.inflow)} in, ${fmt(f.outflow)} out` });
    const defs = s('defs', null, s('pattern', { id: 'lbt-cf-stripes', width: 6, height: 6, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' }, s('rect', { width: 3, height: 6, fill: dark ? 'rgba(0,0,0,.35)' : 'rgba(255,255,255,.6)' })));
    svg.append(defs);
    const linkLayer = s('g');
    const nodeLayer = s('g');
    const labelLayer = s('g');
    svg.append(linkLayer, nodeLayer, labelLayer);

    const tip = h('div', { class: 'lbt-cf-tip', hidden: true });
    const showTip = (e, lines) => {
      tip.replaceChildren(...lines.map((l, i) => h('div', { class: i === 0 ? 'lbt-cf-tip-title' : null }, l)));
      tip.hidden = false;
      const b = box.getBoundingClientRect();
      tip.style.left = `${Math.min(b.width - 230, Math.max(0, e.clientX - b.left + 14))}px`;
      tip.style.top = `${Math.max(0, e.clientY - b.top + 10)}px`;
    };
    const hideTip = () => { tip.hidden = true; };
    const detail = (n) => [n.name, `${fmt(total(n))}`, n.up ? `${fmt(n.now)} cleared · ${fmt(n.up)} pending or scheduled` : 'All cleared'];

    const band = (x0, y0, x1, y1, th) => {
      const xm = (x0 + x1) / 2;
      return `M${x0},${y0}C${xm},${y0} ${xm},${y1} ${x1},${y1}L${x1},${y1 + th}C${xm},${y1 + th} ${xm},${y0 + th} ${x0},${y0 + th}Z`;
    };
    const link = (a, b, v, color) => {
      // v = { name, now, up } flowing from node a to node b.
      const g = s('g', { class: 'lbt-cf-link' });
      const x0 = a.x + NW;
      const x1 = b.x;
      const nowTh = v.now * k;
      const upTh = v.up * k;
      if (nowTh > 0) g.append(s('path', { d: band(x0, a.outY, x1, b.inY, nowTh), fill: color, 'fill-opacity': v.plain ? 0.18 : 0.32 }));
      if (upTh > 0) {
        g.append(s('path', { d: band(x0, a.outY + nowTh, x1, b.inY + nowTh, upTh), fill: color, 'fill-opacity': 0.16 }));
        g.append(s('path', { d: band(x0, a.outY + nowTh, x1, b.inY + nowTh, upTh), fill: 'url(#lbt-cf-stripes)' }));
      }
      a.outY += nowTh + upTh;
      b.inY += nowTh + upTh;
      g.addEventListener('mousemove', (e) => showTip(e, [`${a.name} → ${b.name}`, fmt(total(v)), v.up ? `${fmt(v.now)} cleared · ${fmt(v.up)} pending or scheduled` : 'All cleared']));
      g.addEventListener('mouseleave', hideTip);
      linkLayer.append(g);
    };

    for (const n of col0) link(n, budget, n, n.color);
    for (const c of col2) link(budget, c, c, c.color);
    for (const b of col3) link(b.parent, b, b, b.color);

    const label = (n, x, anchor, small) => {
      const t = s('text', { x, y: n.y + n.h / 2, 'text-anchor': anchor, 'dominant-baseline': 'middle', class: `lbt-cf-label${small ? ' small' : ''}`, stroke: cardBg });
      t.append(s('tspan', { class: 'name' }, n.name.length > 26 ? `${n.name.slice(0, 25)}…` : n.name), s('tspan', { class: 'amt', dx: 6 }, fmt(total(n))));
      labelLayer.append(t);
    };
    cols.forEach((c, ci) => {
      let lastLabel = -Infinity; // skip labels that would collide (the tooltip still has them)
      for (const n of c) {
        const mid = n.y + n.h / 2;
        const roomy = mid - lastLabel >= 14;
        if (roomy) lastLabel = mid;
        const r = s('rect', { x: n.x, y: n.y, width: NW, height: n.h, rx: 2, fill: n.color, class: 'lbt-cf-node' });
        if (n.up && total(n)) {
          nodeLayer.append(r, s('rect', { x: n.x, y: n.y + (n.now / total(n)) * n.h, width: NW, height: (n.up / total(n)) * n.h, fill: 'url(#lbt-cf-stripes)', 'pointer-events': 'none' }));
        } else nodeLayer.append(r);
        r.addEventListener('mousemove', (e) => showTip(e, detail(n)));
        r.addEventListener('mouseleave', hideTip);
        if (ci === 0) { if (roomy) label(n, n.x - 8, 'end'); }
        else if (ci === 1) {
          const t = s('text', { x: n.x + NW / 2, y: n.y - 10, 'text-anchor': 'middle', class: 'lbt-cf-label', stroke: cardBg });
          t.append(s('tspan', { class: 'name' }, 'Budget'), s('tspan', { class: 'amt', dx: 6 }, fmt(T)));
          labelLayer.append(t);
        } else if (ci === 2) { if (roomy) label(n, n.x + NW + 6, 'start'); }
        else if (roomy) label(n, n.x + NW + 6, 'start', true);
      }
    });

    box.replaceChildren(svg, tip);
  }

  // ---------- mount / sync ----------

  function sync() {
    const id = reportsBudgetId();
    const tl = id ? tabList() : null;
    if (!tl) {
      const root = document.getElementById(ROOT_ID);
      if (root) root.remove();
      return;
    }
    const btn = ensureTab(tl);
    const area = contentArea(tl);
    const active = wants() && !!area;
    setTabActive(tl, btn, active);
    let root = document.getElementById(ROOT_ID);
    if (!active) {
      if (root) root.remove();
      document.querySelectorAll('main[data-lbt-cf-on]').forEach((m) => m.removeAttribute('data-lbt-cf-on'));
      return;
    }
    if (!root || root.parentElement !== area) {
      if (root) root.remove();
      root = h('div', { id: ROOT_ID });
      area.append(root);
      area.setAttribute('data-lbt-cf-on', '');
      if (state.budgetId !== id) {
        state.budgetId = id;
        state.data = null;
        state.fetchedAt = 0;
      }
      render();
    }
    if (!state.loading && (!state.fetchedAt || Date.now() - state.fetchedAt > MAX_AGE_MS)) load();
  }

  chrome.storage.sync.get({ [KEY]: true }, (st) => {
    on = st[KEY] !== false;
    sync();
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync' && (changes[KEY] || changes.hideCurrency)) {
      if (changes[KEY]) on = changes[KEY].newValue !== false;
      sync();
      render();
    }
  });
  let resizeTimer = null;
  window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(render, 150); });
  window.addEventListener('popstate', () => setTimeout(sync, 0));
  window.addEventListener('hashchange', sync);
  setInterval(sync, 700);
})();
