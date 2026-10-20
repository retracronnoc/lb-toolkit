/**
 * Toolkit for Liquid Budget — Pacing page inside the app (replaces Forecast).
 *
 * Adds "Pacing" to Liquid Budget's left menu (right after Projections) and,
 * when chosen, shows the current month's pacing in the app's main content
 * area with the sidebar left as is. The page lives at the budget URL plus
 * #lbt-pacing (old #lbt-forecast links are redirected), so refresh,
 * back/forward and opening in a new tab all work.
 *
 * Pacing counts every transaction dated this month, including pending ones
 * and ones dated after today, and lists only the buckets projected to run
 * out of money before the month ends.
 *
 * Also tightens the left menu (Budget … Recurring Transactions) when
 * "Compact left menu" is on: rows 36px → 32px and 2px between them instead of 4px.
 *
 * Built against Liquid Budget's markup: the left menu is a <nav> of <a> links
 * (/budget/{id}, /budget/{id}/reports, …) and the active link carries the
 * bg-sidebar-primary class; the content area is the outermost <main>. If
 * the app changes that markup, this quietly does nothing.
 *
 * Data comes from the Developer API through the service worker
 * (background.js); the math is in lib/pacing-math.js.
 */
(function () {
  'use strict';

  const P = globalThis.LBTPacing;
  const Q = globalThis.LBTQuickAssign;
  const F = globalThis.LBTForecast;
  const HASH = '#lbt-pacing';
  const OLD_HASH = '#lbt-forecast';
  const ROOT_ID = 'lbt-pacing-root';
  const LINK_ID = 'lbt-pacing-link';
  const ACTIVE_MARK = 'bg-sidebar-primary';
  const PREFS_KEY = 'lbtForecastPrefs'; // kept from Forecast so the category choice carries over
  const ICON =
    '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-gauge mr-2" aria-hidden="true"><path d="m12 14 4-4"></path><path d="M3.34 19a10 10 0 1 1 17.32 0"></path></svg>';

  let enabled = true; // "Show Pacing in the left menu"
  let compactMenu = true; // "Compact left menu"
  const navClasses = { active: null, inactive: null };
  const view = {
    budgetId: null,
    data: null, // { budget, categories, buckets, rows }
    error: null,
    loading: false,
    prefs: null,
    pickerOpen: false,
    showAllUpcoming: false,
    showAllSuggest: false,
    showIgnored: false,
    quickAssign: null, // 'app' | 'api' | 'none': where quick assign settings came from
    fmt: null,
    fmtCompact: null,
    drawChart: null,
  };

  // ---------- helpers ----------

  function budgetIdFromPath() {
    const m = location.pathname.match(/^\/budget\/([0-9a-f-]{36})(?:\/|$)/i);
    return m ? m[1] : null;
  }

  function wantsPacing() {
    return enabled && !!budgetIdFromPath() && location.hash === HASH;
  }

  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style') el.style.cssText = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) {
      if (kid == null || kid === false) continue;
      el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
    }
    return el;
  }

  const SVGNS = 'http://www.w3.org/2000/svg';
  function s(tag, attrs, ...kids) {
    const el = document.createElementNS(SVGNS, tag);
    for (const [k, v] of Object.entries(attrs || {})) if (v != null && v !== false) el.setAttribute(k, v);
    for (const kid of kids.flat()) {
      if (kid == null || kid === false) continue;
      el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
    }
    return el;
  }

  function contentMain() {
    return [...document.querySelectorAll('main')].find((m) => !m.parentElement || !m.parentElement.closest('main')) || null;
  }

  function findNav(id) {
    const reports = `/budget/${id}/reports`;
    return [...document.querySelectorAll('nav')].find((n) => [...n.querySelectorAll(':scope > a')].some((a) => a.pathname === reports)) || null;
  }

  function appLinks(nav) {
    return [...nav.querySelectorAll(':scope > a')].filter((a) => a.id !== LINK_ID);
  }

  function learnNavClasses(nav) {
    for (const a of appLinks(nav)) {
      if (a.dataset.lbtOrig) continue; // one we've restyled ourselves
      const cls = a.className;
      if (cls.includes(ACTIVE_MARK)) navClasses.active = cls;
      else navClasses.inactive = cls;
    }
    if (!navClasses.inactive && navClasses.active) {
      navClasses.inactive = navClasses.active
        .split(/\s+/)
        .filter((c) => !c.includes('sidebar-primary'))
        .concat(['hover:bg-sidebar-accent', 'hover:text-sidebar-accent-foreground'])
        .join(' ');
    }
    if (!navClasses.active && navClasses.inactive) {
      navClasses.active = navClasses.inactive
        .split(/\s+/)
        .filter((c) => !c.includes('sidebar-accent'))
        .concat(['bg-sidebar-primary', 'text-sidebar-primary-foreground', 'hover:bg-sidebar-primary/90', 'hover:text-sidebar-primary-foreground'])
        .join(' ');
    }
  }

  // ---------- menu ----------

  function applyCompact() {
    const id = budgetIdFromPath();
    const nav = id && findNav(id);
    document.querySelectorAll('nav[data-lbt-compact]').forEach((n) => {
      if (n !== nav || !compactMenu) n.removeAttribute('data-lbt-compact');
    });
    if (nav && compactMenu && !nav.hasAttribute('data-lbt-compact')) nav.setAttribute('data-lbt-compact', '');
  }

  function ensureLink() {
    const id = budgetIdFromPath();
    const existing = document.getElementById(LINK_ID);
    if (!enabled || !id) {
      if (existing) existing.remove();
      return null;
    }
    const nav = findNav(id);
    if (!nav) return null;
    learnNavClasses(nav);
    if (existing && existing.parentElement === nav && existing.dataset.budget === id) return existing;
    if (existing) existing.remove();

    const link = h('a', { id: LINK_ID, href: `/budget/${id}${HASH}`, class: navClasses.inactive || '', 'data-budget': id });
    link.innerHTML = `<span>${ICON}</span>Pacing<span class="ml-auto text-xs"></span>`;
    link.addEventListener('click', (e) => {
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return; // let new-tab clicks through
      e.preventDefault();
      if (location.hash !== HASH) history.pushState(history.state, '', location.pathname + location.search + HASH);
      sync();
    });
    const links = appLinks(nav);
    const after = links.find((a) => a.pathname.endsWith('/projections')) || links.find((a) => a.pathname.endsWith('/reports'));
    if (after) after.after(link);
    else nav.append(link);
    return link;
  }

  function setNavActive(on) {
    const link = document.getElementById(LINK_ID);
    const nav = link && link.parentElement;
    if (!nav) return;
    if (on) {
      if (navClasses.active && link.className !== navClasses.active) link.className = navClasses.active;
      for (const a of appLinks(nav)) {
        if (a.className.includes(ACTIVE_MARK) && navClasses.inactive) {
          a.dataset.lbtOrig = a.className;
          a.className = navClasses.inactive;
        }
      }
    } else {
      if (navClasses.inactive && link.className !== navClasses.inactive) link.className = navClasses.inactive;
      for (const a of appLinks(nav)) {
        if (!a.dataset.lbtOrig) continue;
        if (a.pathname === location.pathname && !a.className.includes(ACTIVE_MARK)) a.className = a.dataset.lbtOrig;
        delete a.dataset.lbtOrig;
      }
    }
  }

  // ---------- mount / unmount ----------

  function mount() {
    const main = contentMain();
    if (!main) return;
    const id = budgetIdFromPath();
    let root = document.getElementById(ROOT_ID);
    if (!root || root.parentElement !== main) {
      if (root) root.remove();
      root = h('div', { id: ROOT_ID });
      main.append(root);
    }
    main.setAttribute('data-lbt-pacing', '');
    setNavActive(true);
    if (view.budgetId !== id) {
      view.budgetId = id;
      view.data = null;
      view.error = null;
      view.prefs = null;
    }
    if (!root.dataset.rendered) {
      root.dataset.rendered = '1';
      render();
    }
    if (!view.data && !view.loading && !view.error) load();
  }

  function unmount() {
    const root = document.getElementById(ROOT_ID);
    if (root) root.remove();
    document.querySelectorAll('main[data-lbt-pacing]').forEach((m) => m.removeAttribute('data-lbt-pacing'));
    setNavActive(false);
  }

  function sync() {
    if (location.hash === OLD_HASH && budgetIdFromPath()) {
      history.replaceState(history.state, '', location.pathname + location.search + HASH);
    }
    ensureLink();
    applyCompact();
    if (wantsPacing()) mount();
    else if (document.getElementById(ROOT_ID) || document.querySelector('main[data-lbt-pacing]')) unmount();
  }

  // ---------- data ----------

  function send(msg) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (res) => {
          if (chrome.runtime.lastError) resolve({ ok: false, error: 'The Toolkit extension was updated or reloaded. Refresh this page.' });
          else resolve(res || { ok: false, error: 'No response from the Toolkit extension.' });
        });
      } catch {
        resolve({ ok: false, error: 'The Toolkit extension was updated or reloaded. Refresh this page.' });
      }
    });
  }

  async function getPrefs(budgetId) {
    const all = (await chrome.storage.local.get(PREFS_KEY))[PREFS_KEY] || {};
    return { hiddenCats: [], ...(all[budgetId] || {}) };
  }

  async function savePrefs() {
    const all = (await chrome.storage.local.get(PREFS_KEY))[PREFS_KEY] || {};
    all[view.budgetId] = { ...(all[view.budgetId] || {}), ...view.prefs };
    await chrome.storage.local.set({ [PREFS_KEY]: all });
  }

  async function load() {
    const id = view.budgetId;
    view.loading = true;
    view.error = null;
    render();
    const [res, prefs] = await Promise.all([send({ type: 'lbt-pacing-data', budgetId: id }), getPrefs(id)]);
    if (view.budgetId !== id) return; // budget switched while loading
    view.loading = false;
    view.prefs = prefs;
    if (!res.ok) {
      view.error = { message: res.error, status: res.status || 0 };
    } else {
      view.data = res.result;
      const [offIds, qa] = await Promise.all([
        Array.isArray(view.data.offBudgetAccounts) ? view.data.offBudgetAccounts : appOffBudgetAccounts(id),
        appQuickAssign(id),
      ]);
      view.data.offBudgetAccounts = offIds;
      if (qa) {
        for (const b of view.data.buckets || []) if (qa.has(b.id)) b.quickAssign = qa.get(b.id);
        view.quickAssign = 'app';
      } else {
        view.quickAssign = (view.data.buckets || []).some((b) => b && 'quickAssign' in b) ? 'api' : 'none';
      }
      if (view.budgetId !== id) return;
      const cur = res.result.budget && res.result.budget.currency;
      view.fmt = makeFormatter(cur);
      view.fmtCompact = makeCompact(cur);
    }
    render();
  }

  // Fallback when the Developer API has no account list: the app's own list,
  // read with the signed-in session. Without it, nothing is filtered out.
  async function appOffBudgetAccounts(budgetId) {
    try {
      const r = await fetch(`/api/account/budget/${encodeURIComponent(budgetId)}`, { credentials: 'same-origin', headers: { Accept: 'application/json' } });
      if (!r.ok) return [];
      return F.offBudgetIds(await r.json());
    } catch {
      return [];
    }
  }

  // Quick assign settings from the app's own bucket list (read with your
  // signed-in session). Returns Map(bucketId -> quickAssign) or null.
  async function appQuickAssign(budgetId) {
    try {
      const r = await fetch(`/api/bucket/budget/${encodeURIComponent(budgetId)}`, { credentials: 'same-origin', headers: { Accept: 'application/json' } });
      if (!r.ok) return null;
      const list = await r.json();
      if (!Array.isArray(list)) return null;
      return new Map(list.filter((b) => b && b.id).map((b) => [b.id, b.quickAssign || null]));
    } catch {
      return null;
    }
  }

  function compute() {
    const d = view.data;
    return P.buildPacing({ categories: d.categories, buckets: d.buckets, rows: d.rows, today: F.localToday(), hiddenCats: view.prefs.hiddenCats, offBudgetAccounts: d.offBudgetAccounts || [] });
  }

  // ---------- formatting ----------

  function makeFormatter(currency) {
    const base = currency && currency !== 'NONE' ? { style: 'currency', currency } : {};
    let cents;
    let whole;
    try {
      cents = new Intl.NumberFormat('en-US', { ...base, minimumFractionDigits: 2, maximumFractionDigits: 2 });
      whole = new Intl.NumberFormat('en-US', { ...base, minimumFractionDigits: 0, maximumFractionDigits: 0 });
    } catch {
      cents = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      whole = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
    }
    return (scale4, w) => (w ? whole : cents).format(scale4 / 10000);
  }
  function makeCompact(currency) {
    const base = currency && currency !== 'NONE' ? { style: 'currency', currency } : {};
    let f;
    try {
      f = new Intl.NumberFormat('en-US', { ...base, notation: 'compact', maximumFractionDigits: 1 });
    } catch {
      f = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });
    }
    return (scale4) => f.format(scale4 / 10000);
  }
  const money = (s4, whole) => view.fmt(s4, whole);
  const shortDate = (ymd) => new Date(`${ymd}T12:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const weekdayDate = (ymd) => new Date(`${ymd}T12:00:00`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

  function amt(s4) {
    const cls = s4 > 0 ? 'pos' : s4 < 0 ? 'neg' : '';
    return h('span', { class: `lbt-amt ${cls}` }, money(s4));
  }

  // ---------- render ----------

  function render() {
    const root = document.getElementById(ROOT_ID);
    if (!root) return;
    const refresh = h('button', { class: 'lbt-btn', type: 'button', disabled: view.loading, onclick: () => load() }, view.loading ? 'Loading…' : 'Refresh');
    const header = h('header', { class: 'lbt-header' }, h('h1', null, 'Pacing'), refresh);
    const content = h('div', { class: 'lbt-content' });
    const oldScroll = root.querySelector('.lbt-scroll');
    const scrollTop = oldScroll ? oldScroll.scrollTop : 0;
    const scroller = h('div', { class: 'lbt-scroll' }, content);
    root.replaceChildren(header, scroller);
    view.drawChart = null;

    if (view.error) {
      const needsToken = view.error.status === 401;
      content.append(
        h('div', { class: 'lbt-card' },
          h('div', { class: 'lbt-card-head' }, h('div', null, h('h3', { class: 'lbt-title' }, needsToken ? 'Connect the Developer API' : "Couldn't load pacing"), h('p', { class: 'lbt-muted lbt-small', style: 'margin:0' }, view.error.message))),
          h('div', { class: 'lbt-card-body lbt-controls' },
            needsToken ? h('button', { class: 'lbt-btn primary', type: 'button', onclick: () => send({ type: 'lbt-open-options' }) }, 'Open Toolkit settings') : null,
            h('button', { class: 'lbt-btn', type: 'button', onclick: () => load() }, 'Try again'),
          ),
        ),
      );
      return;
    }
    if (!view.data) {
      content.append(h('div', { class: 'lbt-card' }, h('div', { class: 'lbt-empty' }, 'Loading this month…')));
      return;
    }

    const p = compute();
    const mi = p.month;
    const t = p.totals;
    const monthName = new Date(`${mi.ym}-15T12:00:00`).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
    const monthEnd = `${mi.ym}-${String(mi.daysInMonth).padStart(2, '0')}`;

    content.append(monthCard(p, monthName));
    content.append(atRiskCard(p, monthEnd));
    const chart = chartCard(p);
    content.append(chart.card);
    content.append(upcomingCard(p));
    content.append(suggestCard());
    content.append(
      h('p', { class: 'lbt-note' },
        h('b', null, 'How this works. '),
        'Pacing counts every transaction dated this month, including pending ones and ones dated after today. "Had" is what a bucket started the month with plus this month\'s assignments. Buckets you spend from often (groceries, dining) keep going at their current daily pace for the rest of the month; anything already scheduled is counted toward that pace rather than on top of it. Bills and one-offs only count what\'s scheduled. A bucket shows up under Running out when its balance is projected to drop below $0 before the month ends. "Usual" is the middle half of what you spent by the same day over the last 6 months (at least 3 needed), using the same categories. Transfers between accounts, and anything in off-budget accounts (assets and liabilities such as an HSA, loans or vehicles), are left out. Recurring transactions only count once Liquid Budget has created them as dated transactions. Quick assign suggestions compare each bucket\'s quick assign with its average monthly spending over the full months chosen (counted from when the bucket started), rounded up to a tidy amount; buckets that rarely spend (savings) are never told to lower, and top-off or minimum quick assigns are only ever raised. Nothing is changed for you: update a quick assign in Liquid Budget if you agree.',
      ),
      h('p', { class: 'lbt-note' }, 'Added by Toolkit for Liquid Budget, an unofficial extension. Not part of Liquid Budget.'),
    );
    chart.draw();
    view.drawChart = chart.draw;
    scroller.scrollTop = scrollTop;
  }

  function categoryPicker(p) {
    const prefs = view.prefs;
    const shown = p.groups.filter((g) => !prefs.hiddenCats.includes(g.id)).length;
    const btn = h('button', { class: 'lbt-btn', type: 'button', 'aria-expanded': String(view.pickerOpen), onclick: () => { view.pickerOpen = !view.pickerOpen; render(); } },
      `Categories (${shown} of ${p.groups.length}) ${view.pickerOpen ? '▴' : '▾'}`);
    const chips = view.pickerOpen
      ? h('div', { class: 'lbt-chips' },
          h('span', { class: 'lbt-muted lbt-xs', style: 'align-self:center;margin-right:.25rem' }, 'Count these categories in pacing:'),
          p.groups.map((g) =>
            h('label', { class: 'lbt-chip' },
              h('input', {
                type: 'checkbox',
                checked: !prefs.hiddenCats.includes(g.id),
                onchange: async (e) => {
                  prefs.hiddenCats = e.target.checked ? prefs.hiddenCats.filter((x) => x !== g.id) : [...prefs.hiddenCats, g.id];
                  await savePrefs();
                  render();
                },
              }),
              g.name,
            ),
          ),
        )
      : null;
    return { btn, chips };
  }

  // The headline: is spending where it usually is by this day of the month?
  const VERDICT = {
    ok: ['On track', 'ok', 'Spending is right where it usually is by now.'],
    below: ['Calm', 'ok', 'Spending is below where it usually is by now.'],
    watch: ['Watch', 'warn', 'Spending is a little ahead of where it usually is by now.'],
    alarm: ['Faster than usual', 'err', 'Spending is well ahead of where it usually is by now.'],
  };
  function verdictBanner(p) {
    const tp = p.typical;
    const mi = p.month;
    if (!tp) {
      return h('div', { class: 'lbt-verdict none' },
        h('div', { class: 'lbt-verdict-text' }, h('b', null, 'Not enough history yet. '), 'Once 3 months of spending are in the budget, this compares you to your usual pace.'));
    }
    const [label, tone, sentence] = VERDICT[tp.status];
    const pct = tp.diffPct == null ? null : Math.round(tp.diffPct * 100);
    const vs = pct == null || Math.abs(pct) < 3 ? 'right at your usual' : `${Math.abs(pct)}% ${pct > 0 ? 'above' : 'below'} your usual`;
    return h('div', { class: `lbt-verdict ${tone}` },
      h('span', { class: `lbt-verdict-badge ${tone}` }, h('span', { class: 'lbt-verdict-icon', 'aria-hidden': 'true' }, tone === 'ok' ? '✓' : '!'), label),
      h('div', { class: 'lbt-verdict-text' },
        h('div', null, tp.early ? h('span', { class: 'lbt-pill', style: 'margin-right:.5rem' }, 'Early read') : null, sentence),
        h('div', { class: 'lbt-muted lbt-small' },
          h('b', { class: 'lbt-fg' }, money(tp.actual, true)), ` spent by ${shortDate(mi.today)} · ${vs}. You usually spend `,
          h('b', { class: 'lbt-fg' }, money(tp.byToday.low, true) === money(tp.byToday.high, true) ? `about ${money(tp.byToday.mid, true)}` : `${money(tp.byToday.low, true)}–${money(tp.byToday.high, true)}`),
          ` by day ${mi.day} (last ${tp.months} months) and ${money(tp.endOfMonth.mid, true)} by month end.`,
        ),
      ),
    );
  }

  function monthCard(p, monthName) {
    const mi = p.month;
    const t = p.totals;
    const picker = categoryPicker(p);
    const diff = t.had - t.projectedSpend; // >0 under, <0 over
    const scheduledOut = t.scheduledOut;
    const scheduledNet = -t.scheduled; // positive = net outflow still to come
    const scheduledCount = p.upcoming.filter((u) => u.kind === 'bucket').length;

    // Spending bar: spent | scheduled | expected at pace, against what you had.
    const scale = Math.max(t.had, t.projectedSpend, 1);
    const pct = (v) => `${Math.max(0, (v / scale) * 100).toFixed(2)}%`;
    const schedSeg = Math.max(0, scheduledNet);
    const bar = h('div', { class: 'lbt-spendbar', role: 'img', 'aria-label': `Spent ${money(t.spent, true)}, ${money(schedSeg, true)} scheduled, ${money(t.pace, true)} more expected at the current pace, of ${money(t.had, true)}` },
      h('span', { class: 'seg spent', style: `width:${pct(t.spent)}`, title: `Spent so far: ${money(t.spent)}` }),
      schedSeg > 0 ? h('span', { class: 'seg sched', style: `width:${pct(schedSeg)}`, title: `Scheduled: ${money(schedSeg)}` }) : null,
      t.pace > 0 ? h('span', { class: 'seg pace', style: `width:${pct(t.pace)}`, title: `Expected at current pace: ${money(t.pace)}` }) : null,
      t.projectedSpend > t.had && t.had > 0 ? h('i', { class: 'limit', style: `left:${pct(t.had)}`, title: `Had: ${money(t.had)}` }) : null,
    );
    const key = (cls, label, v) => h('span', { class: 'lbt-key' }, h('span', { class: `sw ${cls}` }), `${label} `, h('b', null, money(v, true)));

    const stat = (label, value, sub, bad) => h('div', { class: 'lbt-stat' }, h('div', { class: 'lbt-label' }, label), h('div', { class: `lbt-big${bad ? ' lbt-bad' : ''}` }, value), h('div', { class: 'lbt-sub' }, sub));
    const inc = p.income;
    return h('div', { class: 'lbt-card' },
      h('div', { class: 'lbt-card-head' },
        h('div', null,
          h('h3', { class: 'lbt-title' }, monthName),
          h('p', { class: 'lbt-muted lbt-small', style: 'margin:0' }, `${plural(p.txCount, 'transaction')} this month, ${p.futureCount} still to come`),
        ),
        h('div', { class: 'lbt-controls' },
          h('span', { class: 'lbt-pill' }, `Day ${mi.day} of ${mi.daysInMonth} · ${plural(mi.daysLeft, 'day')} left`),
          picker.btn,
        ),
      ),
      picker.chips,
      verdictBanner(p),
      h('div', { class: 'lbt-card-body lbt-bars' },
        h('div', { class: 'lbt-barrow' },
          h('div', { class: 'lbt-barlabel' }, h('span', { class: 'lbt-label' }, 'Month'), h('span', { class: 'lbt-muted lbt-small' }, `${Math.round(mi.elapsed * 100)}% gone`)),
          h('div', { class: 'lbt-progress', title: `${Math.round(mi.elapsed * 100)}% of the month gone` }, h('span', { style: `width:${Math.round(mi.elapsed * 100)}%` })),
        ),
        h('div', { class: 'lbt-barrow' },
          h('div', { class: 'lbt-barlabel' },
            h('span', { class: 'lbt-label' }, 'Spending'),
            h('span', { class: 'lbt-muted lbt-small' }, t.had > 0 ? `${Math.round((t.spent / t.had) * 100)}% spent · ${Math.round((t.projectedSpend / t.had) * 100)}% projected` : ''),
          ),
          bar,
          h('div', { class: 'lbt-keys' },
            key('spent', 'Spent', t.spent),
            schedSeg > 0 ? key('sched', 'Scheduled', schedSeg) : null,
            t.pace > 0 ? key('pace', 'At current pace', t.pace) : null,
            h('span', { class: 'lbt-key lbt-muted' }, `of ${money(t.had, true)} you had`),
          ),
        ),
      ),
      h('div', { class: 'lbt-stats' },
        stat('Spent so far', money(t.spent, true), `${money(t.dailyBurn)}/day on everyday spending`),
        stat('Still scheduled', money(scheduledOut, true), scheduledCount ? `${plural(scheduledCount, 'transaction')} dated after today` : 'nothing else dated this month'),
        stat('Projected month-end', money(t.projectedSpend, true), diff < 0 ? `${money(-diff, true)} more than you had` : `${money(diff, true)} under what you had`, diff < 0),
        stat('Free to spend / day', mi.daysLeft && t.safePerDay > 0 ? money(t.safePerDay) : '—', mi.daysLeft ? `after scheduled, for ${plural(mi.daysLeft, 'day')}` : 'last day of the month'),
      ),
      inc.received || inc.coming
        ? h('div', { class: 'lbt-incomeline lbt-small' },
            h('span', { class: 'lbt-label' }, 'Income'),
            h('span', null, h('b', null, money(inc.received, true)), ' received'),
            inc.coming ? h('span', null, h('b', null, money(inc.coming, true)), ' still coming') : null,
          )
        : null,
    );
  }

  function whyText(r) {
    if (r.cause === 'over') return 'Already overspent';
    if (r.cause === 'scheduled') {
      if (r.trigger) return `${r.trigger.payee || 'Scheduled transaction'} (${money(-r.trigger.amount, true)}) on ${shortDate(r.trigger.date)}`;
      return 'Scheduled transactions';
    }
    return `Spending ${money(r.dailyBurn)}/day`;
  }

  // What history says about a bucket that's running out.
  function historyRead(r) {
    const hs = r.history;
    if (!hs || !hs.usualByToday) return { vs: null, tone: '', note: null };
    const pct = Math.round(((r.spent - hs.usualByToday) / hs.usualByToday) * 100);
    const habitual = hs.checked >= 2 && hs.ranOut >= 2;
    let note;
    let tone = '';
    if (pct >= 15) {
      note = 'Faster than usual';
      tone = 'err';
    } else if (habitual) {
      note = 'Runs short most months: assign more?';
      tone = 'warn';
    } else if (pct <= -15) {
      note = 'Slower than usual; short because of larger items';
    } else {
      note = 'Your usual pace';
    }
    return { vs: pct, tone, note };
  }

  function atRiskCard(p, monthEnd) {
    const rows = p.atRisk;
    const head = h('div', { class: 'lbt-card-head' },
      h('div', null,
        h('h3', { class: 'lbt-subtitle' }, 'Running out'),
        h('p', { class: 'lbt-muted lbt-small', style: 'margin:0' }, `Buckets projected to drop below $0 by ${shortDate(monthEnd)}, most urgent first, with how this month compares to the usual`),
      ),
      rows.length ? h('span', { class: 'lbt-pill err' }, plural(rows.length, 'bucket')) : h('span', { class: 'lbt-pill ok' }, 'All clear'),
    );
    if (!rows.length) {
      return h('div', { class: 'lbt-card' }, head, h('div', { class: 'lbt-empty' }, `No bucket is projected to run out of money before ${shortDate(monthEnd)}, counting everything scheduled and current spending pace.`));
    }
    const tbody = h('tbody');
    for (const r of rows) {
      const when = r.cause === 'over' ? 'Now' : shortDate(r.runsOutOn);
      const hr = historyRead(r);
      const hs = r.history;
      tbody.append(
        h('tr', null,
          h('td', { class: 'name' }, h('div', null, r.name), h('div', { class: 'lbt-muted lbt-xs' }, r.categoryName)),
          h('td', { class: 'num' }, amt(r.availableNow)),
          h('td', { class: 'num' }, r.scheduled ? money(r.scheduled) : '—'),
          h('td', { class: 'num' }, r.pace ? money(-r.pace) : '—'),
          h('td', { class: 'num' }, amt(r.endBalance)),
          h('td', { class: 'num' }, h('span', { class: `lbt-pill ${r.cause === 'over' ? 'err' : 'warn'}` }, when)),
          h('td', { class: 'num', title: hs && hs.usualByToday ? `You usually spend ${money(hs.usualByToday, true)} here by day ${p.month.day} (median, last ${hs.months} months)` : null },
            hs && hs.usualByToday
              ? [h('div', { class: `lbt-vs ${hr.tone}` }, `${hr.vs > 0 ? '+' : ''}${hr.vs}%`), h('div', { class: 'lbt-xs lbt-muted' }, `usual ${money(hs.usualByToday, true)}`)]
              : h('span', { class: 'lbt-muted lbt-xs' }, 'no history'),
            hs && hs.checked ? h('div', { class: 'lbt-xs lbt-muted' }, `ran out ${hs.ranOut} of ${hs.checked}`) : null),
          h('td', { class: 'why' }, h('div', null, whyText(r)), hr.note ? h('div', { class: `lbt-xs lbt-vs ${hr.tone}` }, hr.note) : null),
        ),
      );
    }
    return h('div', { class: 'lbt-card' },
      head,
      h('div', { class: 'lbt-tablewrap' },
        h('table', null,
          h('thead', null,
            h('tr', null,
              h('th', null, 'Bucket'),
              h('th', { class: 'num' }, 'Available now'),
              h('th', { class: 'num' }, 'Scheduled'),
              h('th', { class: 'num' }, 'At pace'),
              h('th', { class: 'num' }, 'Month-end'),
              h('th', { class: 'num' }, 'Runs out'),
              h('th', { class: 'num', title: 'Spent so far compared with the median spent by this day over the last 6 months, and how many of the last 3 months it ran out' }, 'Vs. usual'),
              h('th', null, 'Why'),
            ),
          ),
          tbody,
        ),
      ),
    );
  }

  // Cumulative spending chart: actual through today, projected after.
  function chartCard(p) {
    const body = h('div', { class: 'lbt-chartwrap' });
    const had = p.totals.had;
    const prev = p.prev;
    const prevName = new Date(`${prev.ym}-15T12:00:00`).toLocaleDateString('en-US', { month: 'long' });
    const prevPts = prev.series.filter((d) => d.day <= p.month.daysInMonth);
    const hasPrev = prev.total > 0;
    const band = p.typical ? p.typical.band : null;
    const maxCum = Math.max(1, ...p.series.map((d) => d.cum), ...(hasPrev ? prevPts.map((d) => d.cum) : []), ...(band ? band.map((b) => b.high) : []));
    // Savings buckets can make "had" dwarf the month's spending; past 2x, leave
    // the line off so the spending curve stays readable.
    const showHad = had > 0 && had <= maxCum * 2;
    const legend = h('div', { class: 'lbt-legend' },
      h('span', { class: 'lbt-key' }, h('span', { class: 'ln actual' }), 'Actual'),
      h('span', { class: 'lbt-key' }, h('span', { class: 'ln proj' }), 'Projected'),
      band ? h('span', { class: 'lbt-key' }, h('span', { class: 'sw usual' }), `Usual range (last ${p.typical.months} months)`) : null,
      hasPrev ? h('span', { class: 'lbt-key' }, h('span', { class: 'ln prev' }), prevName) : null,
      showHad
        ? h('span', { class: 'lbt-key' }, h('span', { class: 'ln had' }), 'What you had')
        : h('span', { class: 'lbt-key lbt-muted' }, `You had ${money(had, true)} (above this scale)`),
      h('span', { class: 'lbt-key' }, h('span', { class: 'dot' }), 'Scheduled'),
    );
    const card = h('div', { class: 'lbt-card' },
      h('div', { class: 'lbt-card-head' }, h('div', null, h('h3', { class: 'lbt-subtitle' }, 'Spending through the month'), h('p', { class: 'lbt-muted lbt-small', style: 'margin:0' }, compareText())), legend),
      h('div', { class: 'lbt-card-body' }, body),
    );

    function compareText() {
      if (band) return `Running total of bucket spending against your usual range for each day of the month`;
      if (!hasPrev) return 'Running total of bucket spending';
      const now = p.series[p.month.day - 1].cum;
      const diff = now - prev.byToday;
      const by = shortDate(p.month.today);
      if (Math.abs(diff) < 10000) return `Running total of bucket spending · about the same as ${prevName} by ${by}`;
      return `Running total of bucket spending · ${money(Math.abs(diff), true)} ${diff > 0 ? 'more' : 'less'} than ${prevName} by ${by} (${prevName} ended at ${money(prev.total, true)})`;
    }

    function draw() {
      const W = Math.max(320, Math.round(body.clientWidth || 800));
      const H = 240;
      const m = { t: 14, r: 16, b: 26, l: 56 };
      const iw = W - m.l - m.r;
      const ih = H - m.t - m.b;
      const mi = p.month;
      const dim = mi.daysInMonth;
      const maxY = (showHad ? Math.max(had, maxCum) : maxCum) * 1.1;
      const x = (d) => m.l + (d / dim) * iw;
      const y = (v) => m.t + ih - (Math.max(0, v) / maxY) * ih;

      const svg = s('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}`, class: 'lbt-chart', role: 'img', 'aria-label': `Running total of spending. ${money(p.totals.spent, true)} spent through day ${mi.day}; projected ${money(p.totals.projectedSpend, true)} by month end against ${money(had, true)} available.` });

      // grid + y labels
      const ticks = 4;
      const step = niceStep(maxY / ticks);
      for (let v = 0; v <= maxY; v += step) {
        svg.append(s('line', { x1: m.l, x2: W - m.r, y1: y(v), y2: y(v), class: v === 0 ? 'axis' : 'grid' }));
        svg.append(s('text', { x: m.l - 8, y: y(v) + 4, 'text-anchor': 'end', class: 'tick' }, view.fmtCompact(v)));
      }
      // x labels
      for (const d of [1, 8, 15, 22, dim]) {
        svg.append(s('text', { x: x(d), y: H - 8, 'text-anchor': d === dim ? 'end' : 'middle', class: 'tick' }, shortDate(`${mi.ym}-${String(d).padStart(2, '0')}`)));
      }
      // had line
      if (showHad) {
        svg.append(s('line', { x1: m.l, x2: W - m.r, y1: y(had), y2: y(had), class: 'had' }));
        svg.append(s('text', { x: W - m.r, y: y(had) - 6, 'text-anchor': 'end', class: 'tick strong' }, `Had ${money(had, true)}`));
      }
      // today marker
      svg.append(s('line', { x1: x(mi.day), x2: x(mi.day), y1: m.t, y2: m.t + ih, class: 'today' }));
      svg.append(s('text', { x: x(mi.day) + 4, y: m.t + 10, class: 'tick' }, 'Today'));

      const pts = (arr) => arr.map(([d, v]) => `${x(d).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
      const actual = [[0, 0], ...p.series.filter((d) => d.day <= mi.day).map((d) => [d.day, d.cum])];
      const todayCum = actual[actual.length - 1][1];
      const proj = [[mi.day, todayCum], ...p.series.filter((d) => d.day > mi.day).map((d) => [d.day, d.cum])];
      if (band) {
        const top = [[0, 0], ...band.map((b) => [b.day, b.high])];
        const bottom = [...band.map((b) => [b.day, b.low])].reverse().concat([[0, 0]]);
        svg.append(s('polygon', { points: pts(top.concat(bottom)), class: 'usual' }));
        svg.append(s('polyline', { points: pts([[0, 0], ...band.map((b) => [b.day, b.mid])]), class: 'usual-mid' }));
      }
      if (hasPrev) svg.append(s('polyline', { points: pts([[0, 0], ...prevPts.map((d) => [d.day, d.cum])]), class: 'prev' }));
      if (proj.length > 1) svg.append(s('polyline', { points: pts(proj), class: 'proj' }));
      svg.append(s('polyline', { points: pts(actual), class: 'actual' }));

      // scheduled dots
      const schedDays = new Map();
      for (const u of p.upcoming) {
        if (u.kind !== 'bucket') continue;
        const d = Number(u.date.slice(8, 10));
        schedDays.set(d, [...(schedDays.get(d) || []), u]);
      }
      for (const [d, list] of schedDays) {
        const pt = p.series[d - 1];
        if (!pt || !list.some((u) => u.amount < 0)) continue;
        svg.append(s('circle', { cx: x(d), cy: y(pt.cum), r: 4.5, class: 'sched' }));
      }

      // hover layer
      const cross = s('line', { y1: m.t, y2: m.t + ih, class: 'cross', visibility: 'hidden' });
      const knob = s('circle', { r: 4, class: 'knob', visibility: 'hidden' });
      svg.append(cross, knob);
      const tip = h('div', { class: 'lbt-tip', hidden: true });
      const hit = s('rect', { x: m.l, y: m.t, width: iw, height: ih, fill: 'transparent' });
      svg.append(hit);
      const hide = () => { cross.setAttribute('visibility', 'hidden'); knob.setAttribute('visibility', 'hidden'); tip.hidden = true; };
      hit.addEventListener('mouseleave', hide);
      hit.addEventListener('mousemove', (e) => {
        const box = svg.getBoundingClientRect();
        const px = ((e.clientX - box.left) / box.width) * W;
        const d = Math.min(dim, Math.max(1, Math.round(((px - m.l) / iw) * dim)));
        const pt = p.series[d - 1];
        cross.setAttribute('x1', x(d)); cross.setAttribute('x2', x(d)); cross.setAttribute('visibility', 'visible');
        knob.setAttribute('cx', x(d)); knob.setAttribute('cy', y(pt.cum)); knob.setAttribute('visibility', 'visible');
        const list = schedDays.get(d) || [];
        const pp = hasPrev ? prev.series[Math.min(d, prev.daysInMonth) - 1] : null;
        tip.replaceChildren(
          ...[
            h('div', { class: 'lbt-tip-date' }, weekdayDate(pt.date), pt.actual ? '' : ' · projected'),
            h('div', null, 'Running total ', h('b', null, money(pt.cum, true))),
            pt.actual ? h('div', { class: 'lbt-muted' }, `That day: ${money(pt.net)}`) : null,
            ...list.map((u) => h('div', { class: 'lbt-muted' }, `${u.payee || 'Scheduled'}: ${money(u.amount)}`)),
            band ? h('div', { class: 'lbt-tip-prev' }, 'Usual by now: ', h('b', null, money(band[d - 1].low, true) === money(band[d - 1].high, true) ? money(band[d - 1].mid, true) : `${money(band[d - 1].low, true)}–${money(band[d - 1].high, true)}`)) : null,
            pp ? h('div', { class: band ? 'lbt-muted' : 'lbt-tip-prev' }, `${shortDate(pp.date)}: `, h('b', null, money(pp.cum, true)), pt.cum !== pp.cum ? ` (${pt.cum > pp.cum ? '+' : '−'}${money(Math.abs(pt.cum - pp.cum), true)})` : '') : null,
          ].filter(Boolean),
        );
        tip.hidden = false;
        const left = (x(d) / W) * box.width;
        tip.style.left = `${Math.min(box.width - 200, Math.max(0, left + 12))}px`;
        tip.style.top = `${Math.max(0, (y(pt.cum) / H) * box.height - 20)}px`;
      });
      body.replaceChildren(svg, tip);
    }
    return { card, draw };
  }

  function niceStep(raw) {
    const pow = 10 ** Math.floor(Math.log10(Math.max(raw, 1)));
    const n = raw / pow;
    return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * pow;
  }

  function upcomingCard(p) {
    const list = p.upcoming;
    const head = h('div', { class: 'lbt-card-head' },
      h('div', null,
        h('h3', { class: 'lbt-subtitle' }, 'Still to come this month'),
        h('p', { class: 'lbt-muted lbt-small', style: 'margin:0' }, 'Transactions dated after today, pending ones included (transfers left out)'),
      ),
    );
    if (!list.length) return h('div', { class: 'lbt-card' }, head, h('div', { class: 'lbt-empty' }, 'Nothing else is dated this month.'));
    const LIMIT = 12;
    const shown = view.showAllUpcoming ? list : list.slice(0, LIMIT);
    const tbody = h('tbody');
    for (const u of shown) {
      const where = u.kind === 'income' ? 'Income' : u.kind === 'unassigned' ? 'No bucket' : u.buckets.map((b) => b.name).join(', ');
      tbody.append(
        h('tr', null,
          h('td', null, weekdayDate(u.date)),
          h('td', { class: 'name' }, u.payee || h('span', { class: 'lbt-muted' }, '—')),
          h('td', { class: u.kind === 'bucket' ? null : 'lbt-muted' }, where),
          h('td', { class: 'num' }, h('span', { class: u.amount > 0 ? 'lbt-in' : null }, money(u.amount))),
        ),
      );
    }
    const more = list.length > LIMIT
      ? h('div', { class: 'lbt-card-foot' }, h('button', { class: 'lbt-btn', type: 'button', onclick: () => { view.showAllUpcoming = !view.showAllUpcoming; render(); } }, view.showAllUpcoming ? 'Show fewer' : `Show all ${list.length}`))
      : null;
    return h('div', { class: 'lbt-card' },
      head,
      h('div', { class: 'lbt-tablewrap' },
        h('table', null,
          h('thead', null, h('tr', null, h('th', null, 'Date'), h('th', null, 'Payee'), h('th', null, 'Bucket'), h('th', { class: 'num' }, 'Amount'))),
          tbody,
        ),
      ),
      more,
    );
  }

  // ---------- quick assign suggestions ----------

  const monthShort = (ym) => new Date(`${ym}-15T12:00:00`).toLocaleDateString('en-US', { month: 'short', year: 'numeric' });

  function sparkline(sg) {
    const W = 96;
    const H = 26;
    const n = sg.spend.length;
    const max = Math.max(1, sg.qa, sg.suggested, ...sg.spend.map((x) => x.amount));
    const bw = W / n;
    const y = (v) => H - 1 - (v / max) * (H - 3);
    const bars = sg.spend.map((x, i) => {
      const top = y(x.amount);
      return s('rect', { x: (i * bw + bw * 0.15).toFixed(1), y: top.toFixed(1), width: (bw * 0.7).toFixed(1), height: Math.max(x.amount ? 1 : 0, H - 1 - top).toFixed(1), rx: 1, class: x.amount > sg.qa && sg.qa > 0 ? 'over' : 'bar' },
        s('title', null, `${monthShort(x.ym)}: ${money(x.amount, true)}`));
    });
    const qaLine = sg.qa > 0 ? s('line', { x1: 0, x2: W, y1: y(sg.qa).toFixed(1), y2: y(sg.qa).toFixed(1), class: 'qa' }) : null;
    return s('svg', { class: 'lbt-spark', width: W, height: H, viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': `Monthly spending, last ${n} months` }, bars, qaLine);
  }

  function qaLabel(sg) {
    if (sg.qaKind === 'none') return h('span', { class: 'lbt-muted' }, 'None');
    const amount = sg.every > 1 ? `${money(sg.qa * sg.every, true)} / ${sg.every} mo` : money(sg.qa, true);
    const kind = sg.qaKind === 'refill' ? 'fills up to' : sg.qaKind === 'recurring' ? 'target' : null;
    return [h('div', null, amount), kind ? h('div', { class: 'lbt-xs lbt-muted' }, kind) : null];
  }

  function suggestedLabel(sg) {
    const per = sg.every > 1 ? Q.niceUp(sg.avgSpend * sg.every) : sg.suggested;
    const diff = sg.suggested - sg.qa;
    const tone = sg.action === 'lower' ? 'ok' : sg.action === 'set' ? '' : 'warn';
    const arrow = sg.action === 'lower' ? '↓' : sg.action === 'raise' ? '↑' : '+';
    return [
      h('span', { class: `lbt-pill ${tone}` }, `${arrow} ${money(per, true)}${sg.every > 1 ? ` / ${sg.every} mo` : ''}`),
      h('div', { class: 'lbt-xs lbt-muted', style: 'margin-top:.2rem' }, sg.action === 'set' ? 'new quick assign' : `${diff > 0 ? '+' : '−'}${money(Math.abs(diff), true)}/mo`),
    ];
  }

  function suggestWhy(sg) {
    const lines = [];
    const spentIn = `${sg.activeMonths} of ${sg.n} months`;
    if (sg.action === 'set') {
      lines.push(`Spent from it in ${spentIn}, about ${money(sg.avgSpend, true)}/mo, but it has no quick assign.`);
    } else if (sg.action === 'raise') {
      lines.push(`Spent about ${money(sg.avgSpend, true)}/mo (in ${spentIn}), more than the ${money(sg.qa, true)} quick assign.`);
      if (sg.avgAssigned >= sg.qa * 1.1 && sg.avgAssigned > sg.qa + 10 * 10000) lines.push(`You've assigned about ${money(sg.avgAssigned, true)}/mo by hand to keep up.`);
      if (sg.ranOut) lines.push(`Ran out in ${plural(sg.ranOut, 'month')}.`);
      else if (sg.endBalance < sg.startBalance - 20 * 10000) lines.push(`Balance fell from ${money(sg.startBalance, true)} to ${money(sg.endBalance, true)}.`);
    } else {
      lines.push(`Spent about ${money(sg.avgSpend, true)}/mo, less than the ${money(sg.qa, true)} quick assign.`);
      if (sg.avgAssigned <= sg.qa * 0.9) lines.push(`You've been assigning about ${money(sg.avgAssigned, true)}/mo instead.`);
      else if (sg.endBalance > sg.startBalance + 20 * 10000) lines.push(`Balance grew from ${money(sg.startBalance, true)} to ${money(sg.endBalance, true)}.`);
    }
    if (sg.activeMonths < sg.n * 0.6 && sg.action !== 'lower') lines.push('Spending comes in lumps; this spreads it evenly across the months.');
    if (sg.snoozedUntil && sg.snoozedUntil >= F.localToday()) lines.push(`Quick assign is snoozed until ${shortDate(sg.snoozedUntil)}.`);
    return lines;
  }

  function suggestCard() {
    const prefs = view.prefs;
    const monthsPref = prefs.suggestMonths === 6 ? 6 : 12;
    const ignored = new Set(prefs.suggestIgnore || []);
    const setPref = async (patch) => {
      Object.assign(prefs, patch);
      await savePrefs();
      render();
    };
    const seg = h('div', { class: 'lbt-seg', role: 'group', 'aria-label': 'Months of history' },
      [6, 12].map((m) => h('button', { type: 'button', class: m === monthsPref ? 'on' : null, 'aria-pressed': String(m === monthsPref), onclick: () => setPref({ suggestMonths: m }) }, `${m} mo`)));

    const d = view.data;
    const r = Q.suggestQuickAssign({ buckets: d.buckets, rows: d.rows, today: F.localToday(), months: monthsPref, hiddenCats: prefs.hiddenCats, categories: d.categories, offBudgetAccounts: d.offBudgetAccounts || [] });
    const range = `${monthShort(r.months[0])} – ${monthShort(r.months[r.months.length - 1])}`;
    const head = h('div', { class: 'lbt-card-head' },
      h('div', null,
        h('h3', { class: 'lbt-subtitle' }, 'Suggested quick assign changes'),
        h('p', { class: 'lbt-muted lbt-small', style: 'margin:0' }, `Where each bucket's quick assign is out of step with what you actually spent, ${range}`),
      ),
      seg,
    );
    if (view.quickAssign === 'none') {
      return h('div', { class: 'lbt-card' }, head, h('div', { class: 'lbt-empty' }, "Couldn't read quick assign settings for this budget. Make sure you're signed in to Liquid Budget, then Refresh."));
    }
    const all = r.suggestions;
    const live = all.filter((sg) => !ignored.has(sg.id));
    const hidden = all.filter((sg) => ignored.has(sg.id));
    const list = view.showIgnored ? all : live;

    const net = live.reduce((a, sg) => a + (sg.suggested - sg.qa), 0);
    const curTotal = r.totals.current;
    const newTotal = curTotal + net;
    const summary = h('div', { class: 'lbt-suggest-sum lbt-small' },
      h('span', null, 'Quick assigns now ', h('b', { class: 'lbt-fg' }, `${money(curTotal, true)}/mo`)),
      live.length ? h('span', null, 'With these changes ', h('b', { class: 'lbt-fg' }, `${money(newTotal, true)}/mo`), ` (${net >= 0 ? '+' : '−'}${money(Math.abs(net), true)})`) : null,
      r.avgIncome ? h('span', null, 'Average income ', h('b', { class: 'lbt-fg' }, `${money(r.avgIncome, true)}/mo`)) : null,
    );

    if (!list.length) {
      return h('div', { class: 'lbt-card' }, head, summary,
        h('div', { class: 'lbt-empty' }, r.considered ? `Every quick assign is within about 15% of what you spent over the last ${monthsPref} months.` : 'Not enough history yet: buckets need at least 3 full months.'),
        hidden.length ? h('div', { class: 'lbt-card-foot' }, h('button', { class: 'lbt-btn', type: 'button', onclick: () => { view.showIgnored = true; render(); } }, `Show ${plural(hidden.length, 'hidden suggestion')}`)) : null);
    }

    const LIMIT = 8;
    const shown = view.showAllSuggest ? list : list.slice(0, LIMIT);
    const tbody = h('tbody');
    for (const sg of shown) {
      const isIgnored = ignored.has(sg.id);
      tbody.append(
        h('tr', { class: isIgnored ? 'lbt-dim' : null },
          h('td', { class: 'name' }, h('div', null, sg.name), h('div', { class: 'lbt-muted lbt-xs' }, sg.categoryName)),
          h('td', { class: 'num' }, qaLabel(sg)),
          h('td', { class: 'num' }, h('div', null, money(sg.avgSpend, true)), h('div', { class: 'lbt-xs lbt-muted' }, `${sg.activeMonths} of ${sg.n} mo`)),
          h('td', { class: 'spark' }, sparkline(sg)),
          h('td', { class: 'num' }, suggestedLabel(sg)),
          h('td', { class: 'why' }, suggestWhy(sg).map((l) => h('div', null, l))),
          h('td', { class: 'num' },
            h('button', { class: 'lbt-link', type: 'button', title: isIgnored ? 'Show this suggestion again' : "Hide this suggestion (it won't come back unless you show hidden ones)", onclick: () => setPref({ suggestIgnore: isIgnored ? [...ignored].filter((x) => x !== sg.id) : [...ignored, sg.id] }) }, isIgnored ? 'Restore' : 'Hide')),
        ),
      );
    }
    const foot = [];
    if (list.length > LIMIT) foot.push(h('button', { class: 'lbt-btn', type: 'button', onclick: () => { view.showAllSuggest = !view.showAllSuggest; render(); } }, view.showAllSuggest ? 'Show fewer' : `Show all ${list.length}`));
    if (hidden.length) foot.push(h('button', { class: 'lbt-btn', type: 'button', onclick: () => { view.showIgnored = !view.showIgnored; render(); } }, view.showIgnored ? 'Leave hidden ones out' : `Show ${plural(hidden.length, 'hidden suggestion')}`));
    return h('div', { class: 'lbt-card' },
      head,
      summary,
      h('div', { class: 'lbt-tablewrap' },
        h('table', null,
          h('thead', null,
            h('tr', null,
              h('th', null, 'Bucket'),
              h('th', { class: 'num' }, 'Quick assign'),
              h('th', { class: 'num' }, 'Avg spent'),
              h('th', { title: 'Spending each month; the dashed line is the quick assign' }, 'By month'),
              h('th', { class: 'num' }, 'Suggested'),
              h('th', null, 'Why'),
              h('th', null, ''),
            ),
          ),
          tbody,
        ),
      ),
      foot.length ? h('div', { class: 'lbt-card-foot', style: 'gap:.5rem' }, foot) : null,
    );
  }

  // ---------- wiring ----------

  chrome.storage.sync.get({ forecastMenu: true, compactMenu: true }, (st) => {
    enabled = st.forecastMenu !== false;
    compactMenu = st.compactMenu !== false;
    sync();
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync' && (changes.forecastMenu || changes.compactMenu)) {
      if (changes.forecastMenu) enabled = changes.forecastMenu.newValue !== false;
      if (changes.compactMenu) compactMenu = changes.compactMenu.newValue !== false;
      sync();
    }
    if (area === 'local' && changes.lbToken) {
      view.data = null;
      view.error = null;
      if (document.getElementById(ROOT_ID)) load();
    }
  });

  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { if (document.getElementById(ROOT_ID) && view.drawChart) view.drawChart(); }, 150);
  });
  window.addEventListener('popstate', () => setTimeout(sync, 0));
  window.addEventListener('hashchange', sync);
  document.addEventListener(
    'click',
    (e) => {
      const a = e.target.closest && e.target.closest('nav a');
      if (a && a.id !== LINK_ID) [0, 60, 250].forEach((ms) => setTimeout(sync, ms));
    },
    true,
  );
  // The app is a SPA and re-renders its sidebar and content; a light poll
  // re-adds the link and keeps the view in step with the URL.
  setInterval(sync, 700);
})();
