/**
 * Toolkit for Liquid Budget — "Retirement Horizon" widget on the budget screen.
 *
 * A right-panel widget (below All Money Assigned and Days of Buffer): how
 * close the money you have is to financial independence (FI).
 * - Invested: today's balance of the account groups you count (by default
 *   every group except homes and vehicles; what's owed on credit cards in a
 *   counted group comes off).
 * - Spending: a year of bucket spending (the last 12 full months by default,
 *   leaving out categories that look like savings, such as The Vault).
 * - FI number: spending ÷ withdrawal rate (25× spending at 4%).
 * - Safe withdrawal: invested × withdrawal rate, a month and a year.
 * - FI in: years until invested reaches the FI number, growing at the yearly
 *   growth after inflation, with what you save each year (income − spending,
 *   plus anything saved outside the budget) added.
 * All of it is set from the widget's cog. Data comes from the app's own lists,
 * read with your signed-in session.
 */
(function () {
  'use strict';

  const F = globalThis.LBTForecast;
  const R = globalThis.LBTRetire;
  const WIDGET_ID = 'lbt-retire-widget';
  const MENU_ID = 'lbt-retire-menu';
  const OPEN_KEY = 'lbtRetireOpen';
  const MAX_AGE_MS = 10 * 60 * 1000;
  const WINDOWS = [6, 12, 24];
  const DEFAULTS = { retireWidget: true, retireRate: 4, retireGrowth: 5, retireExtra: 0, retireMultiple: null, retireMonths: 12, retireGroups: null, retireSkipCats: null };

  let cfg = { ...DEFAULTS };
  let open = true;
  const state = { budgetId: null, data: null, error: null, loading: false, fetchedAt: 0 };
  let lastSig = '';

  const CHEVRON = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-chevron-right h-4 w-4 shrink-0 transition-transform duration-200" aria-hidden="true"><path d="m9 18 6-6-6-6"></path></svg>';
  const COG = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-settings h-3.5 w-3.5 text-muted-foreground" aria-hidden="true"><path d="M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915"></path><circle cx="12" cy="12" r="3"></circle></svg>';

  function budgetIdFromPath() {
    const m = location.pathname.match(/^\/budget\/([0-9a-f-]{36})(?:\/|$)/i);
    return m ? m[1] : null;
  }

  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'html') el.innerHTML = v;
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

  // ---------- data ----------

  async function getJson(url) {
    const r = await fetch(url, { credentials: 'same-origin', headers: { Accept: 'application/json' } });
    if (!r.ok) throw new Error(String(r.status));
    return r.json();
  }

  async function load() {
    const id = state.budgetId;
    state.loading = true;
    try {
      const enc = encodeURIComponent(id);
      const [accounts, transactions, buckets, categories, budget] = await Promise.all([
        getJson(`/api/account/budget/${enc}`),
        getJson(`/api/account/transaction/budget/${enc}`),
        getJson(`/api/bucket/budget/${enc}`),
        getJson(`/api/category/budget/${enc}`).catch(() => []),
        getJson(`/api/budget/${enc}`).catch(() => null),
      ]);
      if (state.budgetId !== id) return;
      state.data = {
        accounts,
        transactions,
        rows: F.compactTransactions(transactions),
        offIds: F.offBudgetIds(accounts),
        buckets: (buckets || []).filter((b) => b && !b.archived),
        categories: categories || [],
        currency: (budget && budget.currency) || 'USD',
      };
      state.error = null;
    } catch (e) {
      if (state.budgetId !== id) return;
      state.error = "Couldn't read your accounts. Make sure you're signed in, then reload the page.";
    }
    state.loading = false;
    state.fetchedAt = Date.now();
    lastSig = '';
    sync();
  }

  function compute() {
    const d = state.data;
    const today = F.localToday();
    const bal = R.accountBalances(d.accounts, d.transactions, today);
    const groupNames = Array.isArray(cfg.retireGroups) ? cfg.retireGroups : R.defaultGroups(bal.groups);
    const counted = new Set(groupNames);
    const invested = bal.groups.filter((g) => counted.has(g.name)).reduce((a, g) => a + g.total, 0);
    const skipCats = Array.isArray(cfg.retireSkipCats) ? cfg.retireSkipCats : R.defaultSkipCategories(d.categories);
    const months = WINDOWS.includes(Number(cfg.retireMonths)) ? Number(cfg.retireMonths) : 12;
    const flows = R.yearlyFlows({ rows: d.rows, buckets: d.buckets, today, months, offBudgetAccounts: d.offIds, skipCats });
    const extra = Math.round((Number(cfg.retireExtra) || 0) * 10000);
    const saving = flows.income - flows.spending + extra;
    const rate = clamp(Number(cfg.retireRate) || 4, 0.5, 20) / 100;
    const growth = clamp(Number.isFinite(Number(cfg.retireGrowth)) ? Number(cfg.retireGrowth) : 5, -10, 30) / 100;
    const multiple = Number(cfg.retireMultiple) > 0 ? clamp(Number(cfg.retireMultiple), 5, 100) : null;
    const hz = R.horizon({ invested, spending: flows.spending, saving, rate, growth, multiple });
    return { today, bal, counted, invested, skipCats, months, flows, extra, saving, hz };
  }
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  // ---------- formatting ----------

  function fmt(scale4, mode) {
    const cur = state.data ? state.data.currency : 'USD';
    const base = cur && cur !== 'NONE' ? { style: 'currency', currency: cur } : {};
    const v = scale4 / 10000;
    let opts = { ...base, minimumFractionDigits: 0, maximumFractionDigits: 0 };
    if (mode === 'short' && Math.abs(v) >= 1e6) opts = { ...base, notation: 'compact', minimumFractionDigits: 2, maximumFractionDigits: 2 };
    else if (mode === 'short' && Math.abs(v) >= 1e5) opts = { ...base, notation: 'compact', maximumFractionDigits: 0 };
    let text;
    try {
      text = new Intl.NumberFormat('en-US', opts).format(v);
    } catch {
      text = v.toFixed(0);
    }
    const c = globalThis.LBTCurrency;
    return c ? c.strip(text) : text;
  }
  const pct = (x, digits = 0) => `${(x * 100).toFixed(digits).replace(/\.0+$/, '')}%`;
  const num = (x) => String(Math.round(x * 100) / 100);

  function yearsText(y) {
    if (y === 0) return 'Reached';
    if (y == null) return 'Not at this pace';
    const d = new Date();
    d.setMonth(d.getMonth() + Math.round(y * 12));
    const when = d.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
    return `${y < 10 ? y.toFixed(1) : Math.round(y)} yrs · ${when}`;
  }

  // "8 yrs, 4 mos, 12 days": calendar years, months and days from today.
  function spanText(days) {
    const start = new Date();
    start.setHours(12, 0, 0, 0);
    const end = new Date(start);
    end.setDate(end.getDate() + days);
    let y = end.getFullYear() - start.getFullYear();
    let m = end.getMonth() - start.getMonth();
    let d = end.getDate() - start.getDate();
    if (d < 0) {
      m -= 1;
      d += new Date(end.getFullYear(), end.getMonth(), 0).getDate();
    }
    if (m < 0) {
      y -= 1;
      m += 12;
    }
    const part = (n, w) => (n ? `${n} ${w}${n === 1 ? '' : 's'}` : null);
    return [part(y, 'yr'), part(m, 'mo'), part(d, 'day')].filter(Boolean).join(', ') || '0 days';
  }
  const untilText = (days) => {
    const end = new Date();
    end.setDate(end.getDate() + days);
    return end.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  };

  function runwaySection(c) {
    const rw = R.runway({ invested: c.invested, spending: c.flows.spending, growth: c.hz.growth });
    if (rw.days == null) return null;
    const growthPct = num(c.hz.growth * 100);
    const grown = rw.grownYears == null
      ? 'Indefinitely'
      : rw.grownYears > 100 ? '100+ yrs' : spanText(Math.floor(rw.grownYears * 365.25));
    return h('div', { class: 'mt-2 pt-2 border-t px-2 pb-1', title: `${fmt(c.invested)} invested ÷ ${fmt(c.flows.spending)} a year of spending (the categories you count), starting today.` },
      h('p', { class: 'text-center text-xs font-medium text-muted-foreground' }, 'If you stop working, your money will last'),
      h('div', { class: 'flow-root mt-1' },
        line('With no growth', rw.days > 365.25 * 100 ? '100+ yrs' : spanText(rw.days), `${rw.days.toLocaleString('en-US')} days, until ${untilText(rw.days)}, at ${fmt(c.flows.monthlySpending)} a month with nothing earned on what's left`),
        Math.abs(c.hz.growth) > 1e-9
          ? line(`With ${growthPct}% growth`, grown, rw.grownYears == null ? `${growthPct}% growth on ${fmt(c.invested)} is more than a year of spending, so it never runs out` : `What's left keeps growing at ${growthPct}% a year after inflation while you spend ${fmt(c.flows.spending)} a year`)
          : null,
      ),
    );
  }

  // ---------- render ----------

  function line(label, value, title) {
    const row = h('div', { class: 'flex items-center gap-1.5 text-muted-foreground py-1 text-xs', title },
      h('span', { class: 'truncate text-foreground' }, label),
      h('span', { class: 'min-w-2 flex-1 border-b border-dotted border-current opacity-40' }),
      h('span', { class: 'shrink-0 tabular-nums font-medium text-foreground' }, value),
    );
    return row;
  }

  function bodyContent() {
    const muted = (text) => h('p', { class: 'text-xs text-muted-foreground' }, text);
    if (state.error) return h('div', { class: 'pt-2 pb-3 text-center' }, muted(state.error));
    if (!state.data) return h('div', { class: 'pt-2 pb-4 text-center' }, muted('Working it out…'));
    const c = compute();
    const { hz, flows } = c;
    if (!flows.months) return h('div', { class: 'pt-2 pb-3 text-center' }, muted('Needs at least one full month of budget history.'));
    const progress = hz.progress == null ? 1 : hz.progress;
    const bar = Math.min(1, progress);
    const savingRate = flows.income > 0 ? (c.saving - c.extra) / flows.income : null;
    const ratePct = num(hz.rate * 100);
    const groupsText = [...c.counted].join(', ') || 'no account groups';
    const title = [
      `Invested: ${fmt(c.invested)} today in ${groupsText}.`,
      `Spending: ${fmt(flows.spending)} a year, from ${monthLabel(flows.from)} to ${monthLabel(flows.to)}${flows.months < c.months ? ` (only ${flows.months} months of history, scaled to a year)` : ''}${c.skipCats.length ? `, leaving out ${c.skipCats.length === 1 ? '1 category' : `${c.skipCats.length} categories`}` : ''}.`,
      hz.customMultiple
        ? `FI number: ${Math.round(hz.multiple * 10) / 10}× spending (your setting) = ${fmt(hz.fiNumber)}.`
        : `FI number: spending ÷ ${ratePct}% = ${fmt(hz.fiNumber)} (${Math.round(hz.multiple * 10) / 10}× spending).`,
      `Saving: income ${fmt(flows.income)} − spending ${fmt(flows.spending)}${c.extra ? ` + ${fmt(c.extra)} outside the budget` : ''} = ${fmt(c.saving)} a year.`,
      `Growth: ${num(hz.growth * 100)}% a year after inflation, so every amount is in today's money.`,
    ].join('\n');
    const reached = hz.progress != null && hz.progress >= 1;
    return h('div', { title },
      h('div', { class: 'pt-2 pb-3 text-center' },
        h('p', { class: 'text-xs font-semibold uppercase tracking-widest text-muted-foreground' }, 'To financial independence'),
        h('p', { class: `mt-0.5 text-lg font-bold tabular-nums ${reached ? 'text-inflow' : 'text-foreground'}` }, hz.progress == null ? '—' : pct(progress)),
        h('div', { class: 'lbt-rh-bar' }, h('div', { style: `width:${(bar * 100).toFixed(1)}%` })),
        h('p', { class: 'text-xs text-muted-foreground tabular-nums' }, `${fmt(c.invested, 'short')} of ${fmt(hz.fiNumber, 'short')} · ${Math.round(hz.multiple * 10) / 10}× spending`),
      ),
      h('div', { class: 'flow-root px-2 pb-1' },
        line(`${ratePct}% withdrawal`, `${fmt(hz.safeMonthly)}/mo`, `${ratePct}% of ${fmt(c.invested)} a year, split over 12 months`),
        line('', `${fmt(hz.safeYearly)}/yr`),
        line('Spending', `${fmt(flows.monthlySpending)}/mo`, `${fmt(flows.spending)} a year`),
        line('Saving', `${fmt(Math.round(c.saving / 12))}/mo${savingRate != null && !c.extra ? ` · ${pct(savingRate)}` : ''}`, savingRate != null ? `${pct(savingRate)} of budget income${c.extra ? `, plus ${fmt(c.extra)} a year outside the budget` : ''}` : null),
        line('FI in', yearsText(hz.years), `At ${num(hz.growth * 100)}% growth after inflation, saving ${fmt(c.saving)} a year`),
        reached ? null : line('Coasting', yearsText(hz.coastYears), 'Growth alone, with no more saving'),
      ),
      runwaySection(c),
    );
  }
  const monthLabel = (ym) => new Date(`${ym}-15T12:00:00`).toLocaleDateString('en-US', { month: 'short', year: 'numeric' });

  // ---------- cog menu ----------

  function closeMenu() {
    const m = document.getElementById(MENU_ID);
    if (m) m.remove();
    document.removeEventListener('pointerdown', outside, true);
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', closeMenu);
    const cog = document.querySelector(`#${WIDGET_ID} [data-lbt-retire-cog]`);
    if (cog) cog.setAttribute('aria-expanded', 'false');
  }
  function outside(e) {
    const m = document.getElementById(MENU_ID);
    if (m && !m.contains(e.target) && !(e.target.closest && e.target.closest('[data-lbt-retire-cog]'))) closeMenu();
  }
  function onKey(e) {
    if (e.key === 'Escape') closeMenu();
  }
  const save = (patch) => chrome.storage.sync.set(patch);

  function field(label, key, { step, min, max, prefix, suffix, hint, placeholder, optional }) {
    const input = h('input', {
      type: 'number', step, min, max, value: String(cfg[key] ?? ''), placeholder,
      class: 'lbt-rh-input',
      onchange: (e) => {
        const raw = e.target.value.trim();
        if (optional && raw === '') return save({ [key]: null }); // blank = automatic
        const v = Number(raw);
        save({ [key]: raw !== '' && Number.isFinite(v) ? clamp(v, Number(min), Number(max)) : DEFAULTS[key] });
      },
    });
    return h('div', { class: 'lbt-rh-field' },
      h('div', { class: 'lbt-rh-row' },
        h('label', null, label),
        h('span', { class: 'lbt-rh-unit' }, prefix || null, input, h('span', { class: 'lbt-rh-suf' }, suffix || ''))),
      hint ? h('p', { class: 'lbt-rh-hint' }, hint) : null,
    );
  }

  function check(label, on, onToggle, right) {
    return h('label', { class: 'lbt-rh-check' },
      h('input', { type: 'checkbox', checked: on, onchange: (e) => onToggle(e.target.checked) }),
      h('span', { class: 'lbt-rh-name' }, label),
      right ? h('span', { class: 'lbt-rh-unit' }, right) : null,
    );
  }

  const head = (text) => h('div', { class: 'lbt-rh-head' }, text);
  const sep = () => h('div', { role: 'separator', class: 'lbt-rh-sep' });

  function menuContent() {
    const kids = [
      head('Assumptions'),
      field('Withdrawal rate', 'retireRate', { step: '0.25', min: '0.5', max: '20', suffix: '%' }),
      field('FI target (× spending)', 'retireMultiple', {
        step: '0.5', min: '5', max: '100', suffix: '×', optional: true,
        placeholder: String(Math.round(100 / (clamp(Number(cfg.retireRate) || 4, 0.5, 20)) * 10) / 10),
        hint: 'Leave blank to follow the withdrawal rate (25× at 4%).',
      }),
      field('Growth after inflation', 'retireGrowth', { step: '0.5', min: '-10', max: '30', suffix: '%/yr' }),
      field('Saved outside the budget', 'retireExtra', { step: '500', min: '0', max: '10000000', suffix: '/yr', hint: 'Such as 401(k) payroll contributions and employer match.' }),
      sep(),
      head('Spending to average'),
      h('div', { class: 'lbt-rh-seg' }, WINDOWS.map((m) => {
        const on = Number(cfg.retireMonths) === m;
        return h('button', { type: 'button', class: on ? 'on' : null, 'aria-pressed': String(on), onclick: () => save({ retireMonths: m }) }, `${m} mo`);
      })),
    ];
    if (state.data) {
      const c = compute();
      kids.push(sep(), head('Accounts counted as invested'));
      for (const g of c.bal.groups) {
        kids.push(check(g.name, c.counted.has(g.name), (on) => {
          const next = new Set(c.counted);
          if (on) next.add(g.name); else next.delete(g.name);
          save({ retireGroups: c.bal.groups.map((x) => x.name).filter((n) => next.has(n)) });
        }, fmt(g.total, 'short')));
      }
      kids.push(sep(), head('Categories counted as spending'));
      const skip = new Set(c.skipCats);
      for (const cat of state.data.categories) {
        kids.push(check(cat.name, !skip.has(cat.id), (on) => {
          const next = new Set(skip);
          if (on) next.delete(cat.id); else next.add(cat.id);
          save({ retireSkipCats: [...next] });
        }));
      }
      kids.push(h('p', { class: 'lbt-rh-hint', style: 'padding:.25rem .5rem .4rem' }, 'Leave out categories that are really savings (money moved to investments), so they count as saving instead.'));
    }
    return kids;
  }

  function openMenu(cog) {
    if (document.getElementById(MENU_ID)) return closeMenu();
    const r = cog.getBoundingClientRect();
    const top = Math.round(r.bottom + 4);
    const menu = h('div', {
      id: MENU_ID,
      role: 'dialog',
      'aria-label': 'Retirement Horizon settings',
      class: 'lbt-rh-menu',
      style: `position:fixed;top:${top}px;left:${Math.round(Math.max(8, Math.min(r.right - 304, window.innerWidth - 312)))}px;z-index:60;width:19rem;max-height:${Math.max(200, window.innerHeight - top - 12)}px`,
      onkeydown: (e) => { if (e.key !== 'Escape') e.stopPropagation(); }, // keep typing out of the app's shortcuts
    }, menuContent());
    document.body.append(menu);
    cog.setAttribute('aria-expanded', 'true');
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', closeMenu);
  }

  function refreshMenu() {
    const m = document.getElementById(MENU_ID);
    if (!m) return;
    const scroll = m.scrollTop;
    const active = document.activeElement && m.contains(document.activeElement);
    if (active) return; // don't rebuild under the cursor while typing
    m.replaceChildren(...menuContent());
    m.scrollTop = scroll;
  }

  function build() {
    const toggle = () => {
      open = !open;
      try { chrome.storage.local.set({ [OPEN_KEY]: open }); } catch { /* ignore */ }
      lastSig = '';
      sync();
    };
    const chevron = h('span', { class: 'contents', html: CHEVRON });
    const chevSvg = chevron.firstElementChild;
    if (open && chevSvg) chevSvg.style.transform = 'rotate(90deg)';
    return h('div', { id: WIDGET_ID, class: 'w-full mt-3' },
      h('div', { class: 'relative border border-input rounded-lg shadow-sm overflow-hidden mb-4' },
        h('h3', { class: 'flex' },
          h('button', {
            type: 'button',
            class: 'flex flex-1 items-center justify-between font-medium transition-all hover:no-underline w-full px-3 py-2 pr-10 text-sm relative bg-background text-foreground',
            'aria-expanded': String(open),
            onclick: toggle,
          },
            chevSvg,
            h('div', { class: 'ml-1 flex justify-between items-center w-full' }, h('span', { class: 'font-semibold' }, 'Retirement Horizon')),
          ),
        ),
        h('div', { class: 'absolute right-2 top-1.5 z-10' },
          h('button', {
            type: 'button',
            'data-lbt-retire-cog': '',
            'aria-label': 'Retirement Horizon Settings',
            'aria-haspopup': 'dialog',
            'aria-expanded': document.getElementById(MENU_ID) ? 'true' : 'false',
            title: 'Withdrawal rate, growth, accounts and spending',
            class: 'inline-flex items-center justify-center whitespace-nowrap font-medium transition-colors hover:bg-accent hover:text-accent-foreground h-6 rounded-md px-1 text-xs',
            html: COG,
            onclick: (e) => { e.stopPropagation(); openMenu(e.currentTarget); },
          }),
        ),
        open ? h('div', { class: 'overflow-hidden text-sm' }, h('div', { class: 'px-3 py-2.5 bg-card' }, bodyContent())) : null,
      ),
    );
  }

  // The wrapper (div.w-full.mt-3) around the All Money Assigned widget.
  function assignedWrapper() {
    const title = [...document.querySelectorAll('span.font-semibold')].find((el) => el.textContent.trim() === 'All Money Assigned');
    const card = title && title.closest('div.border');
    return card && card.parentElement ? card.parentElement : null;
  }

  // Where the Toolkit widgets go in the right panel: just below the panel's
  // header and any cards the app puts first: All Money Assigned, Budget
  // Errors, or a selected bucket's Bucket Warning. That way errors and
  // warnings stay at the top.
  function topCard() {
    const ama = assignedWrapper();
    // The right panel: All Money Assigned's parent, or (while a bucket is
    // selected and that card is gone) wherever the Toolkit widgets already are.
    const own = document.getElementById('lbt-buffer-widget') || document.getElementById('lbt-retire-widget');
    const panel = ama ? ama.parentElement : own ? own.parentElement : null;
    if (!panel) return null;
    let anchor = null;
    for (const c of panel.children) {
      if (c.id && c.id.startsWith('lbt-')) continue;
      const header = !anchor && c.matches('div.flex.items-center.justify-between'); // "My Budget" / the bucket's name
      const alert = c.matches('div.overflow-hidden.rounded-lg.border') &&
        (/\bborder-(warning|destructive)/.test(String(c.className)) || /^(budget errors|bucket warning)/i.test(c.textContent.trim()));
      if (header || c === ama || alert) anchor = c;
      else break; // only the cards at the very top
    }
    return anchor || ama;
  }



  function sync() {
    const existing = document.getElementById(WIDGET_ID);
    const id = budgetIdFromPath();
    const wrapper = cfg.retireWidget && id ? topCard() : null;
    if (!wrapper) {
      if (existing && (!cfg.retireWidget || !id)) {
        existing.remove();
        closeMenu();
      }
      return;
    }
    if (state.budgetId !== id) {
      state.budgetId = id;
      state.data = null;
      state.error = null;
      state.fetchedAt = 0;
      closeMenu();
    }
    if (!state.loading && (!state.fetchedAt || Date.now() - state.fetchedAt > MAX_AGE_MS)) load();
    const cur = globalThis.LBTCurrency;
    const sig = [id, open, JSON.stringify(cfg), state.fetchedAt, F.localToday(), state.error, cur ? cur.strip('$1') : ''].join('|');
    // Below All Money Assigned (or Budget Errors), after Days of Buffer when that's showing.
    const buffer = document.getElementById('lbt-buffer-widget');
    const anchor = buffer && buffer.previousElementSibling === wrapper ? buffer : wrapper;
    const placed = existing && existing.previousElementSibling === anchor;
    if (placed && sig === lastSig) return;
    const fresh = build();
    if (existing) existing.remove();
    anchor.after(fresh);
    lastSig = sig;
    refreshMenu();
  }

  // ---------- wiring ----------

  chrome.storage.sync.get(DEFAULTS, (st) => {
    cfg = { ...DEFAULTS, ...st };
    chrome.storage.local.get(OPEN_KEY, (l) => {
      if (l && typeof l[OPEN_KEY] === 'boolean') open = l[OPEN_KEY];
      sync();
    });
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return;
    let hit = false;
    for (const k of Object.keys(DEFAULTS)) {
      if (changes[k]) {
        cfg[k] = changes[k].newValue === undefined ? DEFAULTS[k] : changes[k].newValue;
        hit = true;
      }
    }
    if (hit || changes.hideCurrency) {
      lastSig = '';
      sync();
    }
  });
  setInterval(sync, 1000);
})();
