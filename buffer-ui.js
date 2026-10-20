/**
 * Toolkit for Liquid Budget — "Days of Buffer" widget on the budget screen.
 *
 * Adds a widget to the right-hand panel, above All Money Assigned: how many
 * days the balance of one account group (Liquid by default) would last at the
 * average daily spending of the last 90, 180 or 360 days (picked from the
 * widget's cog menu, like the app's own Overview widget). The same menu can
 * also take what's owed on credit cards (the Credit Cards group's total) off
 * the balance first.
 *
 * - Balance: read from the group's total in the left sidebar, so it always
 *   matches what the app shows.
 * - Spending: every bucket's net spending over the chosen window (today
 *   included, nothing dated later), from the same cached Developer API data
 *   Pacing uses. Transfers with a bucket count, since mortgage and loan
 *   payments are usually recorded that way.
 *
 * Built against Liquid Budget's markup: each right-panel widget is a
 * div.w-full.mt-3 wrapping a bordered card whose header reads its title. The
 * widget reuses the app's own classes so it matches the others. If the app's
 * markup changes, this quietly does nothing.
 */
(function () {
  'use strict';

  const P = globalThis.LBTPacing;
  const F = globalThis.LBTForecast;
  const WIDGET_ID = 'lbt-buffer-widget';
  const OPEN_KEY = 'lbtBufferOpen';
  const WINDOWS = [90, 180, 360];
  const MENU_ID = 'lbt-buffer-menu';
  const MAX_AGE_MS = 10 * 60 * 1000;

  let enabled = true;
  let group = 'Liquid';
  let open = true;
  let windowDays = 90;
  let includeCards = false; // subtract what's owed on credit cards from the balance
  let cardsGroup = 'Credit Cards';
  const state = { budgetId: null, rows: null, firstDate: null, groupOf: null, currency: 'USD', loading: false, error: null, fetchedAt: 0 };
  let lastSig = '';

  const CHEVRON = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-chevron-right h-4 w-4 shrink-0 transition-transform duration-200" aria-hidden="true"><path d="m9 18 6-6-6-6"></path></svg>';
  const CHECK = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"></path></svg>';
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
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) {
      if (kid == null || kid === false) continue;
      el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
    }
    return el;
  }

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

  // ---------- reading the page ----------

  // The wrapper (div.w-full.mt-3) around the All Money Assigned widget.
  function assignedWrapper() {
    const title = [...document.querySelectorAll('span.font-semibold')].find((el) => el.textContent.trim() === 'All Money Assigned');
    const card = title && title.closest('div.border');
    return card && card.parentElement ? card.parentElement : null;
  }

  function parseMoney(text) {
    const m = String(text).replace(/\s/g, '').match(/^(-)?\$?(-)?([\d,]+(?:\.\d+)?)$/);
    if (!m) return null;
    const v = Math.round(parseFloat(m[3].replace(/,/g, '')) * 10000);
    return m[1] || m[2] ? -v : v;
  }

  // The group's total: from its header row in the left sidebar when it's
  // showing, otherwise worked out from the transactions (sidebar collapsed).
  function groupBalance(name) {
    const v = sidebarGroupBalance(name);
    return v !== null ? v : computedGroupBalance(name);
  }

  function computedGroupBalance(name) {
    if (!state.rows || !state.groupOf) return null;
    const want = name.trim().toLowerCase();
    const ids = new Set([...state.groupOf].filter(([, g]) => g === want).map(([id]) => id));
    if (!ids.size) return null;
    const today = F.localToday();
    let total = 0;
    for (const [acct, epoch, amount] of state.rows) if (ids.has(acct) && epoch && F.txDate(epoch) <= today) total += amount;
    return total;
  }

  function sidebarGroupBalance(name) {
    const want = name.trim().toLowerCase();
    for (const el of document.querySelectorAll('span')) {
      if (el.childElementCount || el.textContent.trim().toLowerCase() !== want) continue;
      if (el.closest(`#${WIDGET_ID}`) || el.closest('main')) continue;
      const row = el.parentElement;
      if (!row) continue;
      for (const sib of row.children) {
        if (sib === el) continue;
        const v = parseMoney(sib.textContent);
        if (v !== null) return v;
      }
    }
    return null;
  }

  // ---------- data ----------

  async function load() {
    const id = state.budgetId;
    state.loading = true;
    state.error = null;
    sync();
    const [res, accounts] = await Promise.all([
      send({ type: 'lbt-pacing-data', budgetId: id }),
      // Account groups, for when the sidebar is collapsed and its totals can't be read.
      fetch(`/api/account/budget/${encodeURIComponent(id)}`, { credentials: 'same-origin', headers: { Accept: 'application/json' } })
        .then((r) => (r.ok ? r.json() : null)).catch(() => null),
    ]);
    if (state.budgetId !== id) return;
    state.groupOf = Array.isArray(accounts)
      ? new Map(accounts.filter((a) => a && a.id).map((a) => [a.id, String((a.accountGroup && typeof a.accountGroup === 'object' ? a.accountGroup.name : a.accountGroup) || '').trim().toLowerCase()]))
      : null;
    state.loading = false;
    state.fetchedAt = Date.now();
    if (!res.ok) {
      state.error = { message: res.error, status: res.status || 0 };
      state.rows = null;
    } else {
      const d = res.result;
      state.currency = (d.budget && d.budget.currency) || 'USD';
      state.rows = d.rows || [];
      // Oldest bucketed transaction: a window reaching further back than the
      // budget's history is shortened so the average isn't understated.
      let first = null;
      for (const [, epoch, , , bucket] of state.rows) {
        if (!bucket || !epoch) continue;
        const date = F.txDate(epoch);
        if (!first || date < first) first = date;
      }
      state.firstDate = first;
    }
    sync();
  }

  // ---------- render ----------

  function fmt(scale4, whole) {
    const base = state.currency && state.currency !== 'NONE' ? { style: 'currency', currency: state.currency } : {};
    const digits = whole ? 0 : 2;
    try {
      return new Intl.NumberFormat('en-US', { ...base, minimumFractionDigits: digits, maximumFractionDigits: digits }).format(scale4 / 10000);
    } catch {
      return (scale4 / 10000).toFixed(digits);
    }
  }
  const shortDate = (ymd) => new Date(`${ymd}T12:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

  function bodyContent(balance, cards) {
    const muted = (text) => h('p', { class: 'text-xs text-muted-foreground' }, text);
    if (state.error) {
      const needsToken = state.error.status === 401;
      return h('div', { class: 'pt-2 pb-3 text-center' },
        muted(needsToken ? 'Days of Buffer needs your Liquid Budget API token.' : state.error.message),
        h('button', {
          type: 'button',
          class: 'mt-2 cursor-pointer underline decoration-dotted underline-offset-4 hover:text-foreground font-medium text-muted-foreground text-xs',
          onclick: () => (needsToken ? send({ type: 'lbt-open-options' }) : load()),
        }, needsToken ? 'Open Toolkit settings' : 'Try again'),
      );
    }
    if (balance === null) {
      return h('div', { class: 'pt-2 pb-3 text-center' }, muted(state.rows ? `No account group named “${group}”. You can change the group in Toolkit settings.` : 'Working it out…'));
    }
    if (!state.rows) {
      return h('div', { class: 'pt-2 pb-4 text-center' }, muted('Working it out…'));
    }
    const s = spending();
    // Owed on cards = the card group's total when it's negative (a credit balance isn't added).
    const owed = includeCards && cards !== null ? Math.max(0, -cards) : 0;
    const net = balance - owed;
    const days = P.daysOfBuffer(net, s.perDay);
    const big = days === null ? '—' : `${days.toLocaleString('en-US')} ${days === 1 ? 'day' : 'days'}`;
    const sub = days === null ? `No spending in the last ${s.days} days` : days >= 45 ? `about ${(days / 30.44).toFixed(1)} months` : days >= 14 ? `about ${Math.round(days / 7)} weeks` : null;
    const short = s.days < windowDays ? ` Your budget only has ${s.days} days of history, so that's what's averaged.` : '';
    const cardText = includeCards ? (cards === null ? ` No “${cardsGroup}” group was found, so nothing was taken off for cards.` : ` Minus ${fmt(owed)} owed on ${cardsGroup}.`) : '';
    const title = `${group} balance today (${fmt(balance)})${owed ? ` minus ${fmt(owed)} owed on ${cardsGroup} = ${fmt(net)}` : ''} ÷ average daily bucket spending from ${shortDate(s.start)} to ${shortDate(s.end)}: ${fmt(s.total, true)} over ${s.days} days, mortgage and loan payments included.${short}${cards === null && includeCards ? cardText : ''}`;
    return h('div', { title },
      h('div', { class: 'pt-2 pb-4 text-center' },
        h('p', { class: 'text-xs font-semibold uppercase tracking-widest text-muted-foreground' }, `At ${windowDays}-day pace${s.days < windowDays ? '*' : ''}`),
        h('p', { class: 'mt-0.5 text-lg font-bold tabular-nums text-inflow' }, big),
        sub ? muted(sub) : null,
      ),
      includeCards
        ? h('div', { class: 'px-2 pb-1 text-xs text-muted-foreground tabular-nums text-center' },
            h('div', { class: 'flex justify-center gap-2' },
              h('span', null, `${fmt(balance, true)} ${group}`),
              h('span', null, '−'),
              h('span', null, cards === null ? `${cardsGroup} not found` : `${fmt(owed, true)} cards`),
            ),
            h('div', { class: 'flex justify-center gap-2 mt-0.5' },
              h('span', null, `= ${fmt(net, true)}`),
              h('span', null, '÷'),
              h('span', null, `${fmt(s.perDay, true)}/day`),
            ),
          )
        : h('div', { class: 'flex justify-center gap-4 px-2 pb-1 text-xs text-muted-foreground tabular-nums' },
            h('span', null, `${fmt(balance, true)} ${group}`),
            h('span', null, '÷'),
            h('span', null, `${fmt(s.perDay, true)}/day`),
          ),
    );
  }

  // Spending over the chosen window, cut back to the budget's history if shorter.
  function spending() {
    const today = F.localToday();
    let days = windowDays;
    if (state.firstDate) {
      const span = Math.round((new Date(`${today}T12:00:00`) - new Date(`${state.firstDate}T12:00:00`)) / 86400000) + 1;
      days = Math.max(1, Math.min(days, span));
    }
    return P.recentSpending(state.rows, today, days);
  }

  // ---------- cog menu (styled like the app's widget menus) ----------

  function closeMenu() {
    const m = document.getElementById(MENU_ID);
    if (m) m.remove();
    document.removeEventListener('pointerdown', outside, true);
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('scroll', closeMenu, true);
    window.removeEventListener('resize', closeMenu);
    const cog = document.querySelector(`#${WIDGET_ID} [data-lbt-cog]`);
    if (cog) cog.setAttribute('aria-expanded', 'false');
  }
  function outside(e) {
    const m = document.getElementById(MENU_ID);
    if (m && !m.contains(e.target) && !e.target.closest('[data-lbt-cog]')) closeMenu();
  }
  function onKey(e) {
    if (e.key === 'Escape') closeMenu();
  }

  function openMenu(cog) {
    if (document.getElementById(MENU_ID)) return closeMenu();
    const r = cog.getBoundingClientRect();
    const item = (d) => {
      const on = d === windowDays;
      return h('div', {
        role: 'menuitemradio',
        'aria-checked': String(on),
        tabindex: '-1',
        class: 'group flex cursor-pointer select-none items-start gap-2 rounded-sm px-2 py-1.5 text-sm outline-none transition-colors hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground',
        onclick: () => {
          closeMenu();
          chrome.storage.sync.set({ bufferDays: d });
        },
      },
        h('span', { class: 'flex h-5 shrink-0 items-center' },
          h('span', { class: `flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full border transition-colors ${on ? 'border-primary' : 'border-muted-foreground/40 group-hover:border-muted-foreground/70'}` },
            on ? h('span', { class: 'h-1.5 w-1.5 rounded-full bg-primary' }) : null)),
        h('div', { class: 'min-w-0 flex-1' }, `Last ${d} days`),
      );
    };
    const menu = h('div', {
      id: MENU_ID,
      role: 'menu',
      class: 'z-50 min-w-[8rem] overflow-hidden rounded-md border bg-popover text-popover-foreground shadow-md p-1',
      style: `position:fixed;top:${Math.round(r.bottom + 4)}px;right:${Math.round(window.innerWidth - r.right)}px;z-index:60;min-width:13rem`,
    },
      h('div', { class: 'py-1.5 px-1.5 pb-1 pt-0 text-xs font-medium text-muted-foreground' }, 'Spending to average'),
      h('div', { role: 'group' }, WINDOWS.map(item)),
      h('div', { role: 'separator', class: '-mx-1 my-1 h-px bg-muted' }),
      h('div', {
        role: 'menuitemcheckbox',
        'aria-checked': String(includeCards),
        tabindex: '-1',
        class: 'group flex cursor-pointer select-none items-start gap-2 rounded-sm px-2 py-1.5 text-sm outline-none transition-colors hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground',
        onclick: () => {
          closeMenu();
          chrome.storage.sync.set({ bufferIncludeCards: !includeCards });
        },
      },
        h('span', { class: 'flex h-5 shrink-0 items-center' },
          h('span', { class: `flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-sm border transition-colors ${includeCards ? 'border-primary bg-primary text-primary-foreground' : 'border-muted-foreground/40 group-hover:border-muted-foreground/70'}`, html: includeCards ? CHECK : '' })),
        h('div', { class: 'min-w-0 flex-1' }, 'Subtract credit card balances'),
      ),
    );
    document.body.append(menu);
    cog.setAttribute('aria-expanded', 'true');
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('scroll', closeMenu, true);
    window.addEventListener('resize', closeMenu);
  }

  function build(balance, cards) {
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
            h('div', { class: 'ml-1 flex justify-between items-center w-full' }, h('span', { class: 'font-semibold' }, 'Days of Buffer')),
          ),
        ),
        h('div', { class: 'absolute right-2 top-1.5 z-10' },
          h('button', {
            type: 'button',
            'data-lbt-cog': '',
            'aria-label': 'Days of Buffer Settings',
            'aria-haspopup': 'menu',
            'aria-expanded': 'false',
            title: `Averaging the last ${windowDays} days of spending`,
            class: 'inline-flex items-center justify-center whitespace-nowrap font-medium transition-colors hover:bg-accent hover:text-accent-foreground h-6 rounded-md px-1 text-xs',
            html: COG,
            onclick: (e) => { e.stopPropagation(); openMenu(e.currentTarget); },
          }),
        ),
        open ? h('div', { class: 'overflow-hidden text-sm' }, h('div', { class: 'px-3 py-2.5 bg-card' }, bodyContent(balance, cards))) : null,
      ),
    );
  }

  function sync() {
    const existing = document.getElementById(WIDGET_ID);
    const id = budgetIdFromPath();
    const wrapper = enabled && id ? assignedWrapper() : null;
    if (!wrapper) {
      if (existing && !enabled) existing.remove();
      return;
    }
    if (state.budgetId !== id) {
      state.budgetId = id;
      state.rows = null;
      state.error = null;
      state.fetchedAt = 0;
    }
    if (!state.loading && (!state.fetchedAt || Date.now() - state.fetchedAt > MAX_AGE_MS) && !(state.error && Date.now() - state.fetchedAt < MAX_AGE_MS)) {
      load();
      return;
    }
    const balance = groupBalance(group);
    const cards = includeCards ? groupBalance(cardsGroup) : null;
    const sig = [id, open, group, windowDays, balance, includeCards, cardsGroup, cards, state.fetchedAt, F.localToday(), state.error && state.error.message, state.loading].join('|');
    // Sits just above Retirement Horizon when that's showing, else above All Money Assigned.
    const retire = document.getElementById('lbt-retire-widget');
    const anchor = retire && retire.nextElementSibling === wrapper ? retire : wrapper;
    const placed = existing && existing.nextElementSibling === anchor;
    if (placed && sig === lastSig) return;
    closeMenu();
    const fresh = build(balance, cards);
    if (existing) existing.remove();
    anchor.parentElement.insertBefore(fresh, anchor);
    lastSig = sig;
  }

  // ---------- wiring ----------

  const toWindow = (v) => (WINDOWS.includes(Number(v)) ? Number(v) : 90);

  chrome.storage.sync.get({ bufferWidget: true, bufferGroup: 'Liquid', bufferDays: 90, bufferIncludeCards: false, bufferCardsGroup: 'Credit Cards' }, (st) => {
    enabled = st.bufferWidget !== false;
    includeCards = st.bufferIncludeCards === true;
    cardsGroup = (st.bufferCardsGroup || 'Credit Cards').trim() || 'Credit Cards';
    windowDays = toWindow(st.bufferDays);
    group = (st.bufferGroup || 'Liquid').trim() || 'Liquid';
    chrome.storage.local.get(OPEN_KEY, (l) => {
      if (l && typeof l[OPEN_KEY] === 'boolean') open = l[OPEN_KEY];
      sync();
    });
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync' && (changes.bufferWidget || changes.bufferGroup || changes.bufferDays || changes.bufferIncludeCards || changes.bufferCardsGroup)) {
      if (changes.bufferIncludeCards) includeCards = changes.bufferIncludeCards.newValue === true;
      if (changes.bufferCardsGroup) cardsGroup = (changes.bufferCardsGroup.newValue || 'Credit Cards').trim() || 'Credit Cards';
      if (changes.bufferWidget) enabled = changes.bufferWidget.newValue !== false;
      if (changes.bufferDays) windowDays = toWindow(changes.bufferDays.newValue);
      if (changes.bufferGroup) group = (changes.bufferGroup.newValue || 'Liquid').trim() || 'Liquid';
      lastSig = '';
      sync();
    }
    if (area === 'local' && changes.lbToken) {
      state.rows = null;
      state.error = null;
      state.fetchedAt = 0;
      lastSig = '';
      sync();
    }
  });

  // The budget screen re-renders often; a light poll keeps the widget in place
  // and its balance current.
  setInterval(sync, 1000);
})();
