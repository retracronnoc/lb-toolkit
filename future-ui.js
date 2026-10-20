/**
 * Toolkit for Liquid Budget — "Assigned in future months" in All Money Assigned.
 *
 * Adds always-visible lines at the bottom of the All Money Assigned widget
 * (below its Accounts / Assignments dropdown, after a thin rule) for money already assigned in the months
 * after the one on screen (looking 12 months ahead): the month on the left,
 * that month's total assigned (buckets and payment pools) on the right, drawn
 * like the widget's Buckets / Payment Pools lines. Months with nothing
 * assigned are left out. While this is on, the app's single "Next Months"
 * line in the Assignments dropdown is hidden, and so is the "Future
 * Assignments" row above the budget table whenever there are months to list.
 *
 * After each amount, in brackets, is how much of that month's quick assign
 * goals is already funded: the month's assignments (each bucket counted up to
 * its own goal) over what the buckets' quick assigns ask for that month.
 *
 * Assignments come from the app's own bucket and account lists (read with your
 * signed-in session), falling back to the Developer API's bucket list.
 */
(function () {
  'use strict';

  const KEY = 'futureAssigned';
  const BOX = 'data-lbt-future';
  const AHEAD = 12;
  const MAX_AGE_MS = 60 * 1000;
  const TX_MAX_AGE_MS = 5 * 60 * 1000; // transactions only move top-off and target goals, so refresh them less often
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

  let on = true;
  const state = { budgetId: null, byMonth: null, buckets: null, activity: null, txAt: 0, currency: 'USD', loading: false, fetchedAt: 0 };
  let lastSig = '';

  const pad = (n) => String(n).padStart(2, '0');

  function budgetIdFromPath() {
    const m = location.pathname.match(/^\/budget\/([0-9a-f-]{36})(?:\/|$)/i);
    return m ? m[1] : null;
  }

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  // ---------- data ----------

  function addAssignments(list, into) {
    for (const x of list || []) {
      if (!x || x.archived || x.state === 'ARCHIVED') continue;
      for (const a of x.assignments || []) {
        if (!a || typeof a.amount !== 'number' || !a.year || !a.month) continue;
        const ym = `${a.year}-${pad(a.month)}`;
        into[ym] = (into[ym] || 0) + a.amount;
      }
    }
  }

  async function getJson(url) {
    const r = await fetch(url, { credentials: 'same-origin', headers: { Accept: 'application/json' } });
    if (!r.ok) throw new Error(String(r.status));
    return r.json();
  }

  async function load() {
    const id = state.budgetId;
    state.loading = true;
    const byMonth = {};
    try {
      const enc = encodeURIComponent(id);
      const wantTx = !state.activity || Date.now() - state.txAt > TX_MAX_AGE_MS;
      const [buckets, accounts, budget, tx] = await Promise.all([
        getJson(`/api/bucket/budget/${enc}`),
        getJson(`/api/account/budget/${enc}`).catch(() => []),
        getJson(`/api/budget/${enc}`).catch(() => null),
        wantTx ? getJson(`/api/account/transaction/budget/${enc}`).catch(() => null) : Promise.resolve(null),
      ]);
      addAssignments(buckets, byMonth);
      addAssignments(accounts, byMonth);
      if (state.budgetId === id) {
        state.buckets = Array.isArray(buckets) ? buckets : null;
        const Fm = globalThis.LBTForecast;
        if (tx && Fm) {
          const off = new Set(Fm.offBudgetIds(accounts));
          const rows = Fm.compactTransactions(tx).filter((r) => !off.has(r[0]));
          state.activity = Fm.bucketActivity(rows, '9999-12-31', { includePending: true });
          state.txAt = Date.now();
        }
      }
      if (budget && budget.currency) state.currency = budget.currency;
    } catch {
      // Fall back to the Developer API's bucket list (needs the API token).
      const res = await new Promise((resolve) => {
        try {
          chrome.runtime.sendMessage({ type: 'lbt-pacing-data', budgetId: id }, (r) => resolve(chrome.runtime.lastError ? null : r));
        } catch {
          resolve(null);
        }
      });
      if (res && res.ok) {
        addAssignments(res.result.buckets, byMonth);
        if (state.budgetId === id) state.buckets = res.result.buckets;
        if (res.result.budget && res.result.budget.currency) state.currency = res.result.budget.currency;
      }
    }
    if (state.budgetId !== id) return;
    state.byMonth = byMonth;
    state.loading = false;
    state.fetchedAt = Date.now();
    lastSig = '';
    sync();
  }

  // ---------- page ----------

  function fmt(scale4) {
    let text;
    try {
      text = new Intl.NumberFormat('en-US', state.currency === 'NONE' ? { minimumFractionDigits: 2 } : { style: 'currency', currency: state.currency }).format(scale4 / 10000);
    } catch {
      text = (scale4 / 10000).toFixed(2);
    }
    const cur = globalThis.LBTCurrency;
    return cur ? cur.strip(text) : text;
  }

  // The widget's body and the month it shows ("October 2026").
  function widget() {
    const title = [...document.querySelectorAll('span.font-semibold')].find((e) => e.textContent.trim() === 'All Money Assigned');
    const card = title && title.closest('div.border');
    const body = card && card.querySelector('.bg-card');
    if (!body) return null;
    for (const p of body.querySelectorAll('p')) {
      const m = p.textContent.trim().match(/^([A-Za-z]+)\s+(\d{4})$/);
      if (!m) continue;
      const mi = MONTHS.findIndex((n) => n.toLowerCase() === m[1].toLowerCase());
      if (mi >= 0) return { body, year: Number(m[2]), month: mi + 1 };
    }
    return null;
  }

  function futureLines(w) {
    const out = [];
    for (let i = 1; i <= AHEAD; i++) {
      const idx = w.year * 12 + (w.month - 1) + i;
      const y = Math.floor(idx / 12);
      const m = (idx % 12) + 1;
      const total = state.byMonth[`${y}-${pad(m)}`] || 0;
      if (Math.abs(total) < 50) continue; // nothing (or under half a cent) assigned
      const ym = `${y}-${pad(m)}`;
      const Q = globalThis.LBTQuickAssign;
      const funding = Q && state.buckets ? Q.monthFunding(state.buckets, state.activity || {}, ym) : null;
      out.push({ label: `${MONTHS[m - 1]} ${y}`, total, funding }); // always with the year: Dec → Jan crosses it
    }
    return out;
  }

  function pctText(p) {
    if (p == null) return null;
    if (p >= 0.9995) return '100%';
    if (p > 0 && p < 0.01) return '<1%';
    return `${Math.floor(p * 100)}%`;
  }

  function line(l) {
    const row = el('div', 'flex items-center gap-1.5 text-muted-foreground py-1 text-xs');
    row.append(
      el('span', 'truncate text-foreground', l.label),
      el('span', 'min-w-2 flex-1 border-b border-dotted border-current opacity-40'),
      el('span', 'shrink-0 tabular-nums font-medium text-foreground', fmt(l.total)),
    );
    const f = l.funding;
    const pct = f && pctText(f.pct);
    if (pct) {
      const tag = el('span', 'shrink-0 tabular-nums', `(${pct})`);
      if (f.pct >= 0.9995) tag.style.color = 'hsl(var(--success))';
      row.append(tag);
      row.title = `${fmt(f.funded)} of ${fmt(f.need)} needed to fully fund ${l.label}'s quick assign goals (${pct})`;
    }
    return row;
  }

  // The app's own "Next Months" line inside the Assignments dropdown, which
  // this replaces with one line per month.
  const HIDE = 'data-lbt-hidden';
  function hideNextMonths(body) {
    for (const span of body.querySelectorAll('span.truncate')) {
      if (span.textContent.trim().toLowerCase() !== 'next months') continue;
      const row = span.parentElement;
      if (row && row.getAttribute(HIDE) !== 'next-months') row.setAttribute(HIDE, 'next-months');
    }
  }
  function showNextMonths() {
    document.querySelectorAll(`[${HIDE}="next-months"]`).forEach((r) => r.removeAttribute(HIDE));
  }

  // The app's "Future Assignments" row above the budget table: hidden while the
  // widget is listing future months, shown again otherwise.
  function setFutureRowHidden(hide) {
    for (const span of document.querySelectorAll('main tr span.font-semibold')) {
      if (span.textContent.trim().toLowerCase() !== 'future assignments') continue;
      const table = span.closest('table');
      if (!table) continue;
      if (hide && table.getAttribute(HIDE) !== 'future-assignments') table.setAttribute(HIDE, 'future-assignments');
    }
    if (!hide) document.querySelectorAll(`[${HIDE}="future-assignments"]`).forEach((t) => t.removeAttribute(HIDE));
  }

  function sync() {
    const existing = document.querySelector(`[${BOX}]`);
    const id = budgetIdFromPath();
    const w = on && id ? widget() : null;
    if (!w) {
      if (existing && (!on || !id)) existing.remove();
      if (!on) {
        showNextMonths();
        setFutureRowHidden(false);
      }
      lastSig = '';
      return;
    }
    hideNextMonths(w.body);
    if (state.budgetId !== id) {
      state.budgetId = id;
      state.byMonth = null;
      state.fetchedAt = 0;
    }
    if (!state.loading && (!state.fetchedAt || Date.now() - state.fetchedAt > MAX_AGE_MS)) load();
    if (!state.byMonth) return;

    const lines = futureLines(w);
    setFutureRowHidden(lines.length > 0);
    const cur = globalThis.LBTCurrency;
    const sig = JSON.stringify([w.year, w.month, lines, state.currency, cur ? cur.strip('$1') : '']);
    // At the very bottom of the widget, below the Accounts / Assignments
    // dropdown, so opening the dropdown doesn't push the lines around.
    const placed = existing && existing.parentElement === w.body && existing === w.body.lastElementChild;
    if (placed && sig === lastSig) return;
    if (existing) existing.remove();
    lastSig = sig;
    if (!lines.length) return;
    const box = el('div', 'flow-root mt-2 pt-1.5 px-2 border-t');
    box.setAttribute(BOX, '');
    box.title = 'Money already assigned in later months (buckets and payment pools); in brackets, how much of each month\'s quick assign goals is funded. Added by Toolkit for Liquid Budget';
    for (const l of lines) box.append(line(l));
    w.body.append(box);
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
  // The widget re-renders as you move between months; keep the lines in step.
  setInterval(sync, 1000);
})();
