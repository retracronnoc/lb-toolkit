/**
 * Toolkit for Liquid Budget — "Include all transactions" on Reports → Overview.
 *
 * For the current month, the Inflow / Outflow bars get an extra, lighter and
 * striped segment for transactions dated later this month (scheduled and
 * pending ones), the totals are re-scaled to fit, Monthly net and Liquid
 * budget (with its % badge) show their values once those land, and the app's
 * own Monthly net moves into the note under it. The popup setting turns it on
 * and off.
 *
 * It counts the way the report does: inflow = money into buckets plus
 * unassigned income; outflow = money out of buckets (bucketed transfers such
 * as mortgage or loan payments included). Transfers without a bucket and
 * off-budget accounts are left out.
 *
 * Data comes from the app's own account and transaction lists, read with the
 * signed-in session. The app's numbers stay in the page; the extra segment,
 * labels and scaling are layered on with data attributes (see pacing.css).
 */
(function () {
  'use strict';

  const F = globalThis.LBTForecast;
  const P = globalThis.LBTPacing;
  const KEY = 'reportsIncludeAll';
  const MAX_AGE_MS = 60 * 1000;
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const MARK = 'data-lbt-rep'; // on everything we add or touch

  let on = true;
  const state = { budgetId: null, upcoming: null, currency: 'USD', loading: false, fetchedAt: 0, ym: null };
  let lastSig = '';

  const pad = (n) => String(n).padStart(2, '0');

  function reportsBudgetId() {
    const m = location.pathname.match(/^\/budget\/([0-9a-f-]{36})\/reports\/?$/i);
    return m ? m[1] : null;
  }

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    e.setAttribute(MARK, '');
    return e;
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

  function parseNum(text) {
    const m = String(text).replace(/[\s ]/g, '').match(/^(-)?[^\d-]*?(-)?([\d,]+(?:\.\d+)?)$/);
    if (!m) return null;
    const v = Math.round(parseFloat(m[3].replace(/,/g, '')) * 10000);
    return m[1] || m[2] ? -v : v;
  }

  // ---------- data: what's still to come this month ----------

  async function getJson(url) {
    const r = await fetch(url, { credentials: 'same-origin', headers: { Accept: 'application/json' } });
    if (!r.ok) throw new Error(String(r.status));
    return r.json();
  }

  async function load() {
    const id = state.budgetId;
    state.loading = true;
    let upcoming = null;
    try {
      const enc = encodeURIComponent(id);
      const [tx, accounts, budget] = await Promise.all([
        getJson(`/api/account/transaction/budget/${enc}`),
        getJson(`/api/account/budget/${enc}`).catch(() => []),
        getJson(`/api/budget/${enc}`).catch(() => null),
      ]);
      if (budget && budget.currency) state.currency = budget.currency;
      const off = new Set(F.offBudgetIds(accounts));
      const today = F.localToday();
      const ym = F.ymOf(today);
      // Liquid Budget = on-budget cash accounts (everything but credit cards and off-budget).
      const cards = new Set((accounts || []).filter((a) => a && a.type === 'CREDIT_CARD').map((a) => a.id));
      const prevEnd = `${F.addMonths(ym, -1)}-31`;
      upcoming = { ym, inflow: 0, outflow: 0, count: 0, cashFuture: 0, cashPrevEnd: 0 };
      for (const t of tx || []) {
        if (!t || typeof t.amount !== 'number' || !t.dateEpoch || off.has(t.accountId)) continue;
        const date = F.txDate(t.dateEpoch);
        if (!cards.has(t.accountId)) {
          if (date <= prevEnd) upcoming.cashPrevEnd += t.amount;
          if (date > today && F.ymOf(date) === ym) upcoming.cashFuture += t.amount;
        }
        if (date <= today || F.ymOf(date) !== ym) continue;
        const alloc = t.bucketSplit && t.bucketSplit.allocations;
        const bucket = alloc && Object.keys(alloc).length ? alloc : t.bucketId || null;
        let counted = false;
        if (bucket) {
          for (const [, amt] of P.shares(bucket, t.amount)) {
            if (amt > 0) upcoming.inflow += amt;
            else upcoming.outflow -= amt;
            counted = true;
          }
        } else if (t.type !== 'TRANSFER' && t.type !== 'ADJUSTMENT') {
          if (t.amount > 0) upcoming.inflow += t.amount;
          else upcoming.outflow -= t.amount;
          counted = true;
        }
        if (counted) upcoming.count++;
      }
    } catch {
      upcoming = null;
    }
    if (state.budgetId !== id) return;
    state.upcoming = upcoming;
    state.loading = false;
    state.fetchedAt = Date.now();
    lastSig = '';
    sync();
  }

  // ---------- page ----------

  // The month the Overview shows ("October 2026" heading).
  function shownYm() {
    for (const h of document.querySelectorAll('main h1, main h2, main h3')) {
      const m = h.textContent.trim().match(/^([A-Za-z]+)\s+(\d{4})$/);
      if (!m) continue;
      const i = MONTHS.findIndex((n) => n.toLowerCase() === m[1].toLowerCase());
      if (i >= 0) return `${m[2]}-${pad(i + 1)}`;
    }
    return null;
  }

  // The Inflow / Outflow grid and its two rows.
  function barsGrid() {
    const label = [...document.querySelectorAll('main span')].find((s) => s.textContent.trim().toLowerCase() === 'inflow' && s.parentElement && s.parentElement.classList.contains('grid'));
    if (!label) return null;
    const grid = label.parentElement;
    const kids = [...grid.children].filter((c) => !c.hasAttribute(MARK));
    const rowAfter = (name) => {
      const i = kids.findIndex((k) => k.textContent.trim().toLowerCase() === name);
      const row = i >= 0 ? kids[i + 1] : null;
      if (!row) return null;
      const bar = [...row.children].find((c) => c.tagName === 'DIV' && !c.hasAttribute('data-lbt-rep-seg'));
      const value = [...row.children].find((c) => !c.hasAttribute(MARK) && c.tagName === 'SPAN');
      return bar && value ? { row, bar, value } : null;
    };
    const inflow = rowAfter('inflow');
    const outflow = rowAfter('outflow');
    return inflow && outflow ? { grid, inflow, outflow } : null;
  }

  function netBlock() {
    const label = [...document.querySelectorAll('main div')].find((d) => d.childElementCount === 0 && d.textContent.trim().toLowerCase() === 'monthly net');
    return label ? label.parentElement : null;
  }

  function unscale() {
    document.querySelectorAll('[data-lbt-rep-scaled]').forEach((e) => {
      e.removeAttribute('data-lbt-rep-scaled');
      e.style.removeProperty('--lbt-w');
    });
  }

  function clear() {
    unscale();
    unoverlay();
    document.querySelectorAll(`[${MARK}]`).forEach((e) => e.remove());
  }

  // Share of the track: the app keeps 7rem for the number; with the extra
  // "+ … upcoming" note beside it, keep 13rem.
  const width = (frac) => `calc(${(frac * 100).toFixed(4)}% - ${(frac * 13).toFixed(4)}rem)`;

  // Show a different value in place of one of the app's own: the app's
  // element is hidden (it stays in the page, untouched) and a twin with the
  // same classes shows our text right after it.
  function overlay(node, text, tone) {
    if (!node) return;
    let twin = node.nextElementSibling;
    if (!twin || !twin.hasAttribute('data-lbt-rep-twin')) {
      twin = node.cloneNode(false);
      twin.removeAttribute('id');
      twin.setAttribute('data-lbt-rep-twin', '');
      twin.setAttribute(MARK, '');
      node.after(twin);
    }
    if (twin.textContent !== text) twin.textContent = text;
    if (tone) twin.setAttribute('data-lbt-rep-tone', tone);
    else twin.removeAttribute('data-lbt-rep-tone');
    if (node.getAttribute('data-lbt-hidden') !== 'rep') node.setAttribute('data-lbt-hidden', 'rep');
  }
  function unoverlay() {
    document.querySelectorAll('[data-lbt-hidden="rep"]').forEach((n) => n.removeAttribute('data-lbt-hidden'));
    document.querySelectorAll('[data-lbt-rep-twin]').forEach((n) => n.remove());
  }

  // Liquid budget value and its % badge.
  function liquidBlock() {
    const label = [...document.querySelectorAll('main div')].find((d) => d.childElementCount === 0 && d.textContent.trim().toLowerCase() === 'liquid budget');
    const box = label && label.parentElement;
    if (!box) return null;
    const spans = [...box.querySelectorAll('span')].filter((sp) => !sp.hasAttribute(MARK));
    const value = spans.find((sp) => parseNum(sp.textContent.trim()) !== null && !/%$/.test(sp.textContent.trim()));
    const badge = spans.find((sp) => /%$/.test(sp.textContent.trim()));
    return value ? { value, badge } : null;
  }

  const signed = (v) => `${v < 0 ? '-' : ''}${fmt(Math.abs(v))}`;

  function sync() {
    const id = reportsBudgetId();
    if (!id) return;
    const g = barsGrid();
    if (!g) return;
    const ym = shownYm();
    const current = ym && ym === F.ymOf(F.localToday());
    if (!on || !current) {
      if (lastSig !== 'off') { clearAdded(); lastSig = 'off'; }
      return;
    }
    if (state.budgetId !== id) {
      state.budgetId = id;
      state.upcoming = null;
      state.fetchedAt = 0;
    }
    if (!state.loading && (!state.fetchedAt || Date.now() - state.fetchedAt > MAX_AGE_MS)) load();
    const u = state.upcoming;
    if (!u || u.ym !== ym) return;

    const inNow = parseNum(g.inflow.value.textContent);
    const outNow = parseNum(g.outflow.value.textContent);
    if (inNow === null || outNow === null) return;
    const cur = globalThis.LBTCurrency;
    const net = netBlock();
    const own = net ? [...net.children].filter((c) => !c.hasAttribute(MARK)) : [];
    const netValue = own.find((c) => parseNum(c.textContent.trim()) !== null) || null;
    const netNote = netValue ? own[own.indexOf(netValue) + 1] || null : null;
    const liquid = liquidBlock();
    const sig = JSON.stringify([inNow, outNow, u, cur ? cur.strip('$1') : '', netValue && netValue.textContent, liquid && liquid.value.textContent]);
    const present = g.grid.querySelector('[data-lbt-rep-seg]');
    if (sig === lastSig && present) return;
    clearAdded();
    lastSig = sig;
    if (!u.inflow && !u.outflow) return;

    const inAll = Math.abs(inNow) + u.inflow;
    const outAll = Math.abs(outNow) + u.outflow;
    const max = Math.max(inAll, outAll, 1);
    for (const [r, now, extra, kind] of [[g.inflow, Math.abs(inNow), u.inflow, 'in'], [g.outflow, Math.abs(outNow), u.outflow, 'out']]) {
      r.bar.setAttribute('data-lbt-rep-scaled', '');
      r.bar.style.setProperty('--lbt-w', width(now / max));
      if (extra > 0) {
        const seg = el('div', `h-7 shrink-0 lbt-rep-seg ${kind === 'in' ? 'bg-inflow' : 'bg-outflow'}`);
        seg.setAttribute('data-lbt-rep-seg', kind);
        seg.style.width = width(extra / max);
        seg.title = `${fmt(extra)} ${kind === 'in' ? 'coming in' : 'going out'} later this month (scheduled or pending)`;
        r.bar.after(seg);
        r.value.after(el('span', 'shrink-0 pl-1.5 text-xs text-muted-foreground tabular-nums', `+ ${fmt(extra)} upcoming`));
      }
    }
    // Monthly net with what's still to come (the app's own figure moves to the note).
    if (netValue) {
      const nowNet = parseNum(netValue.textContent.trim());
      const after = inAll - outAll;
      overlay(netValue, signed(after));
      if (netNote && netNote.childElementCount === 0) {
        overlay(netNote, `with upcoming · now ${signed(nowNet)}`);
        const twin = netNote.nextElementSibling;
        if (twin && twin.hasAttribute('data-lbt-rep-twin')) {
          twin.classList.remove('text-sm', 'truncate', 'whitespace-nowrap');
          twin.classList.add('text-xs', 'whitespace-normal');
        }
      }
    }
    // Liquid budget once this month's scheduled and pending transactions land.
    if (liquid && u.cashFuture) {
      const nowLiquid = parseNum(liquid.value.textContent.trim());
      const after = nowLiquid + u.cashFuture;
      overlay(liquid.value, signed(after));
      if (liquid.badge && u.cashPrevEnd > 0) {
        const pct = Math.round(((after - u.cashPrevEnd) / u.cashPrevEnd) * 100);
        overlay(liquid.badge, `${pct > 0 ? '+' : ''}${pct}%`, pct >= 0 ? 'pos' : 'neg');
      }
    }
  }

  // Remove everything we added or changed.
  function clearAdded() {
    unscale();
    unoverlay();
    document.querySelectorAll(`[${MARK}]`).forEach((e) => e.remove());
  }

  chrome.storage.sync.get({ [KEY]: true }, (s) => {
    on = s[KEY] !== false;
    sync();
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync' && (changes[KEY] || changes.hideCurrency)) {
      if (changes[KEY]) on = changes[KEY].newValue !== false;
      lastSig = '';
      sync();
    }
  });
  setInterval(() => {
    if (!reportsBudgetId()) {
      if (document.querySelector(`[${MARK}]`)) { clear(); lastSig = ''; }
      return;
    }
    sync();
  }, 800);
})();
