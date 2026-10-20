/**
 * Toolkit for Liquid Budget — "Available after upcoming" on the budget screen.
 *
 * A small calendar-clock toggle next to the AVAILABLE column header. When it's
 * on and you're looking at the current month, every bucket with transactions
 * dated later this month shows its Available with those transactions taken
 * out (or added, for refunds/inflows), with a calendar-clock icon beside it
 * listing them. Category totals are adjusted the same way (without the icon).
 *
 * Nothing in the app is rewritten: the app's own amount stays in the page
 * (and its button still opens the usual popover); the adjusted figure is drawn
 * over it with CSS (see the "Available after upcoming" rules in pacing.css),
 * and the icon sits beside it the way the app's snooze icon does.
 *
 * Built against Liquid Budget's markup: budget rows are <tr> grids whose 3rd
 * cell holds the name; the Available cell is found from the column header
 * (the last one reading AVAILABLE), since the column set is user-selectable; month tabs carry
 * data-state="active". If the markup changes, this quietly does nothing.
 */
(function () {
  'use strict';

  const F = globalThis.LBTForecast;
  const P = globalThis.LBTPacing;
  const KEY = 'availIncludesUpcoming';
  const MAX_AGE_MS = 10 * 60 * 1000;
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const ICON = (size) => `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 7.5V6a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h3.5"></path><path d="M16 2v4"></path><path d="M8 2v4"></path><path d="M3 10h5"></path><path d="M17.5 17.5 16 16.3V14"></path><circle cx="16" cy="16" r="6"></circle></svg>`;

  let on = false;
  const state = { budgetId: null, data: null, loading: false, error: null, fetchedAt: 0, offBudget: null };

  const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();

  function budgetIdFromPath() {
    const m = location.pathname.match(/^\/budget\/([0-9a-f-]{36})\/?$/i); // the budget screen itself
    return m ? m[1] : null;
  }

  function send(msg) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (res) => resolve(chrome.runtime.lastError ? { ok: false } : res || { ok: false }));
      } catch {
        resolve({ ok: false });
      }
    });
  }

  function parseMoney(text) {
    const m = String(text).replace(/\s/g, '').match(/^(-)?\$?(-)?([\d,]+(?:\.\d+)?)$/);
    if (!m) return null;
    const v = Math.round(parseFloat(m[3].replace(/,/g, '')) * 10000);
    return m[1] || m[2] ? -v : v;
  }

  function fmt(scale4) {
    const cur = (state.data && state.data.budget && state.data.budget.currency) || 'USD';
    try {
      return new Intl.NumberFormat('en-US', cur === 'NONE' ? { minimumFractionDigits: 2 } : { style: 'currency', currency: cur }).format(scale4 / 10000);
    } catch {
      return (scale4 / 10000).toFixed(2);
    }
  }
  const shortDate = (ymd) => new Date(`${ymd}T12:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

  // Is the budget screen showing the current month?
  function viewingCurrentMonth() {
    const now = new Date();
    const tab = [...document.querySelectorAll('[data-state="active"]')].find((el) => MONTHS.includes(el.textContent.trim()));
    if (!tab || MONTHS.indexOf(tab.textContent.trim()) !== now.getMonth()) return false;
    const year = [...document.querySelectorAll('button')].find((b) => /^\s*\d{4}\s*$/.test(b.textContent));
    return !year || Number(year.textContent.trim()) === now.getFullYear();
  }

  // ---------- data ----------

  async function load() {
    const id = state.budgetId;
    state.loading = true;
    const res = await send({ type: 'lbt-pacing-data', budgetId: id });
    if (state.budgetId !== id) return;
    state.loading = false;
    state.fetchedAt = Date.now();
    if (!res.ok) {
      state.error = res.error || 'Could not load transactions.';
      state.data = null;
    } else {
      state.error = null;
      state.data = res.result;
      if (!Array.isArray(state.data.offBudgetAccounts)) {
        try {
          const r = await fetch(`/api/account/budget/${encodeURIComponent(id)}`, { credentials: 'same-origin', headers: { Accept: 'application/json' } });
          state.data.offBudgetAccounts = r.ok ? F.offBudgetIds(await r.json()) : [];
        } catch {
          state.data.offBudgetAccounts = [];
        }
      }
    }
    sync();
  }

  // { byBucket: Map(id -> { net, items }), byName, catByName }
  function upcoming() {
    const d = state.data;
    const today = F.localToday();
    const ym = F.ymOf(today);
    const off = new Set(d.offBudgetAccounts || []);
    const live = (d.buckets || []).filter((b) => !b.archived);
    const known = new Set(live.map((b) => b.id));
    const byBucket = new Map();
    for (const [acct, epoch, amount, , bucket, payee] of d.rows || []) {
      if (!bucket || !epoch || off.has(acct)) continue;
      const date = F.txDate(epoch);
      if (date <= today || F.ymOf(date) !== ym) continue;
      for (const [id, amt] of P.shares(bucket, amount)) {
        if (!known.has(id)) continue;
        const e = byBucket.get(id) || { net: 0, items: [] };
        e.net += amt;
        e.items.push({ date, payee: payee || '', amount: amt });
        byBucket.set(id, e);
      }
    }
    const catName = new Map((d.categories || []).map((c) => [c.id, norm(c.name)]));
    const byName = new Map(); // "cat|name" and "|name"
    const catTotals = new Map(); // category name -> { net, count }
    for (const b of live) {
      const e = byBucket.get(b.id);
      if (!e) continue;
      const cn = catName.get(b.categoryId) || '';
      byName.set(`${cn}|${norm(b.name)}`, e);
      if (!byName.has(`|${norm(b.name)}`)) byName.set(`|${norm(b.name)}`, e);
      const t = catTotals.get(cn) || { net: 0, items: [] };
      t.net += e.net;
      t.items.push(...e.items.map((i) => ({ ...i, bucket: b.name })));
      catTotals.set(cn, t);
    }
    return { byName, catTotals, catNames: new Set(catName.values()) };
  }

  // ---------- page ----------

  const tone = (v) => (v < -50 ? 'neg' : v > 50 ? 'pos' : 'zero');

  function clearAll() {
    document.querySelectorAll('[data-lbt-adj]').forEach((el) => {
      el.removeAttribute('data-lbt-adj');
      el.removeAttribute('data-lbt-tone');
    });
    document.querySelectorAll('[data-lbt-sched-icon]').forEach((el) => el.remove());
  }

  function iconFor(entry, label) {
    const lines = entry.items
      .slice()
      .sort((a, b) => a.date.localeCompare(b.date))
      .map((i) => `${shortDate(i.date)} · ${i.payee || 'Scheduled'}${i.bucket ? ` (${i.bucket})` : ''} · ${fmt(i.amount)}`);
    const title = `${label}: includes ${fmt(entry.net)} dated later this month\n${lines.join('\n')}`;
    const el = document.createElement('span');
    el.setAttribute('data-lbt-sched-icon', '');
    el.className = 'shrink-0 text-muted-foreground';
    el.setAttribute('role', 'img');
    el.setAttribute('aria-label', title);
    el.title = title;
    el.innerHTML = ICON(16);
    return el;
  }

  function applyTo(cell, target, entry, label, withIcon = true) {
    const shown = parseMoney(target.textContent);
    if (shown === null) return;
    const adj = shown + entry.net;
    const cur = globalThis.LBTCurrency;
    const text = cur ? cur.strip(fmt(adj)) : fmt(adj);
    if (target.getAttribute('data-lbt-adj') !== text) target.setAttribute('data-lbt-adj', text);
    const t = tone(adj);
    if (t !== tone(shown)) target.setAttribute('data-lbt-tone', t);
    else target.removeAttribute('data-lbt-tone');
    let icon = cell.querySelector(':scope > [data-lbt-sched-icon]');
    if (!withIcon) {
      if (icon) icon.remove();
      return;
    }
    const wanted = `${entry.net}|${entry.items.length}`;
    if (icon && icon.dataset.sig !== wanted) {
      icon.remove();
      icon = null;
    }
    if (!icon) {
      icon = iconFor(entry, label);
      icon.dataset.sig = wanted;
      const anchor = [...cell.children].find((c) => c.contains(target));
      cell.insertBefore(icon, anchor || null);
    }
  }

  // The budget grid's column header row and its LAST "Available" label. The app
  // lets you pick which columns show (All / Standard / Basic / Minimal), so the
  // Available column's position changes; this finds it by its header.
  function availableHeader() {
    const labels = [...document.querySelectorAll('main span')].filter((el) => /^available$/i.test(el.textContent.trim()) && el.parentElement && el.parentElement.classList.contains('grid'));
    const label = labels[labels.length - 1];
    if (!label) return null;
    const row = label.parentElement;
    const cols = [...row.children];
    let index = -1;
    cols.forEach((c, i) => { if (/^available$/i.test(c.textContent.trim())) index = i; });
    return { label, row, index, count: cols.length };
  }

  // Index of the Available cell in a budget row: the header's position when the
  // row has the same columns, otherwise the right-most cell showing an amount.
  function availIndexFor(cells, hdr) {
    if (hdr && hdr.index >= 0 && cells.length === hdr.count) return hdr.index;
    for (let i = cells.length - 1; i >= 0; i--) if (parseMoney(cells[i].textContent.trim()) !== null) return i;
    return -1;
  }

  function headerToggle(hdr) {
    const label = hdr && hdr.label;
    if (!label) return;
    let btn = label.querySelector('[data-lbt-avail-toggle]');
    if (!btn) {
      btn = document.createElement('button');
      btn.type = 'button';
      btn.setAttribute('data-lbt-avail-toggle', '');
      btn.innerHTML = ICON(14);
      // The header label opens the app's column menu on pointer-down; keep our
      // presses from reaching it.
      for (const t of ['pointerdown', 'mousedown', 'pointerup', 'mouseup']) btn.addEventListener(t, (e) => e.stopPropagation());
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        chrome.storage.sync.set({ [KEY]: !on });
      });
      label.prepend(btn);
    }
    const current = viewingCurrentMonth();
    btn.setAttribute('aria-pressed', String(on));
    btn.title = on
      ? current ? 'Available includes transactions dated later this month. Click to show the app\'s amounts.' : 'Available includes upcoming transactions (current month only).'
      : 'Show Available after transactions dated later this month';
  }

  function sync() {
    const id = budgetIdFromPath();
    if (!id) return;
    const hdr = availableHeader();
    headerToggle(hdr);
    if (!on || !viewingCurrentMonth()) {
      clearAll();
      return;
    }
    if (state.budgetId !== id) {
      state.budgetId = id;
      state.data = null;
      state.fetchedAt = 0;
    }
    if (!state.loading && (!state.fetchedAt || Date.now() - state.fetchedAt > MAX_AGE_MS)) load();
    if (!state.data) return;

    const u = upcoming();
    const seen = new Set();
    let currentCat = '';
    for (const tr of document.querySelectorAll('main tr')) {
      const cells = tr.children;
      if (cells.length < 4) continue;
      const nameCell = cells[2];
      const ai = availIndexFor(cells, hdr);
      if (ai <= 2) continue;
      const availCell = cells[ai];
      const firstSpan = nameCell.querySelector('span');
      const bucketName = norm(firstSpan ? firstSpan.textContent : '');
      const rowText = norm(nameCell.textContent);
      if (u.catNames.has(rowText) || u.catNames.has(bucketName)) {
        currentCat = u.catNames.has(rowText) ? rowText : bucketName;
        const total = u.catTotals.get(currentCat);
        const target = availCell.querySelector('div');
        if (total && target && !target.querySelector('button')) {
          applyTo(availCell, target, total, currentCat, false); // total only; the icon is on the bucket rows
          seen.add(target);
        }
        continue;
      }
      const entry = u.byName.get(`${currentCat}|${bucketName}`) || u.byName.get(`|${bucketName}`);
      const target = availCell.querySelector('button');
      if (entry && target) {
        applyTo(availCell, target, entry, bucketName);
        seen.add(target);
      }
    }
    // Drop marks from rows that no longer have upcoming transactions.
    document.querySelectorAll('[data-lbt-adj]').forEach((el) => {
      if (seen.has(el)) return;
      el.removeAttribute('data-lbt-adj');
      el.removeAttribute('data-lbt-tone');
      const cell = el.closest('td');
      const icon = cell && cell.querySelector(':scope > [data-lbt-sched-icon]');
      if (icon) icon.remove();
    });
  }

  chrome.storage.sync.get({ [KEY]: false }, (s) => {
    on = s[KEY] === true;
    sync();
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync' && changes[KEY]) {
      on = changes[KEY].newValue === true;
      sync();
    }
    if (area === 'local' && changes.lbToken) {
      state.data = null;
      state.fetchedAt = 0;
      sync();
    }
  });
  // The budget grid re-renders as you edit and scroll; keep the overlay in step.
  setInterval(sync, 800);
})();
