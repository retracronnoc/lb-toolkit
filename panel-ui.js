/**
 * Toolkit for Liquid Budget — rearrange the cards in the right-hand panel.
 *
 * Each card (All Money Assigned, Days of Buffer, Retirement Horizon, Overview,
 * History, Budget Notes, …) gets a small grip at the left of its header, shown
 * on hover. Drag it up or down to move the card; with the grip focused, the
 * up and down arrow keys move it one place. Budget Errors and a selected
 * bucket's Bucket Warning stay pinned at the top (a setting), and the panel's
 * heading always stays first.
 *
 * The cards are never moved in the page (the app's React code owns them): the
 * panel becomes a flex column and each card gets a CSS `order`. The order is
 * saved by card title, separately for the budget view and the bucket view
 * (when a bucket is selected), in chrome.storage.sync. A card that isn't in
 * the saved order yet shows after the card it follows in the page. "Reset panel order" in Toolkit settings clears it.
 */
(function () {
  'use strict';

  const KEY = 'panelReorder';
  const ORDER_KEY = 'panelOrder';
  const PIN_KEY = 'panelPinAlerts';
  const PANEL = 'data-lbt-panel';
  const CARD = 'data-lbt-card';
  const GRIP = 'data-lbt-grip';

  let on = true;
  let pinAlerts = true;
  let saved = {}; // { budget: [title…], bucket: [title…] }
  let drag = null;
  // Each running copy of this script tags its grips, so a copy left behind
  // when the extension is reloaded (without refreshing the page) can't keep
  // grips whose handlers no longer work.
  const INSTANCE = Math.random().toString(36).slice(2);
  let timer = null;
  let observer = null;

  // False once the extension has been reloaded or removed: this copy then
  // stops and leaves the page to the new one.
  function alive() {
    try {
      return !!(chrome.runtime && chrome.runtime.id);
    } catch {
      return false;
    }
  }
  function retire() {
    clearInterval(timer);
    if (observer) observer.disconnect();
    if (drag) finishDrag(false);
  }

  const GRIP_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="14" viewBox="0 0 8 14" aria-hidden="true"><g fill="currentColor"><circle cx="2" cy="2" r="1.2"/><circle cx="6" cy="2" r="1.2"/><circle cx="2" cy="7" r="1.2"/><circle cx="6" cy="7" r="1.2"/><circle cx="2" cy="12" r="1.2"/><circle cx="6" cy="12" r="1.2"/></g></svg>';

  // ---------- finding the panel and its cards ----------

  function assignedWrapper() {
    const title = [...document.querySelectorAll('span.font-semibold')].find((el) => el.textContent.trim() === 'All Money Assigned');
    const card = title && title.closest('div.border');
    return card && card.parentElement ? card.parentElement : null;
  }

  // The right panel: All Money Assigned's parent, or wherever the Toolkit
  // widgets sit (while a bucket is selected and that card is gone).
  function findPanel() {
    const ama = assignedWrapper();
    if (ama) return ama.parentElement;
    const own = document.getElementById('lbt-buffer-widget') || document.getElementById('lbt-retire-widget');
    return own ? own.parentElement : document.querySelector(`[${PANEL}]`);
  }

  const isHeader = (c, i) => i === 0 && c.matches('div.flex.items-center.justify-between');
  const isAlert = (c) => c.matches('div.overflow-hidden.rounded-lg.border') &&
    (/\bborder-(warning|destructive)/.test(String(c.className)) || /^(budget errors|bucket warning)/i.test(c.textContent.trim()));

  function titleOf(c) {
    const h3 = c.querySelector('h3');
    const span = h3 && h3.querySelector('span.font-semibold');
    const text = (span || h3 || c).textContent.replace(/\s+/g, ' ').trim();
    return text.slice(0, 60);
  }

  // { panel, view, header, alerts: [el], cards: [{ el, title }] } in page order.
  function scan() {
    const panel = findPanel();
    if (!panel) return null;
    const kids = [...panel.children];
    const out = { panel, view: 'bucket', header: null, alerts: [], cards: [] };
    kids.forEach((c, i) => {
      if (c.tagName === 'SCRIPT' || c.tagName === 'STYLE') return;
      if (isHeader(c, i)) out.header = c;
      else if (pinAlerts && isAlert(c)) out.alerts.push(c);
      else {
        const title = titleOf(c);
        if (title) out.cards.push({ el: c, title });
      }
    });
    if (out.cards.some((x) => x.title === 'All Money Assigned' || x.title === 'Overview') || out.alerts.some((a) => /^budget errors/i.test(a.textContent.trim()))) out.view = 'budget';
    return out;
  }

  // Cards in the order they should show: saved titles in saved order; a card
  // that isn't saved yet (say, a widget just switched on) goes right after the
  // card it follows in the page, so it shows up where the app put it.
  function ordered(s) {
    const list = saved[s.view] || [];
    const rank = new Map(list.map((t, i) => [t, i]));
    const out = s.cards.filter((c) => rank.has(c.title)).sort((a, b) => rank.get(a.title) - rank.get(b.title));
    s.cards.forEach((c, i) => {
      if (rank.has(c.title)) return;
      let at = 0;
      for (let k = i - 1; k >= 0; k--) {
        const j = out.indexOf(s.cards[k]);
        if (j >= 0) { at = j + 1; break; }
      }
      out.splice(at, 0, c);
    });
    return out;
  }

  // ---------- applying the order ----------

  // The panel is the inner div of a scroll area that sets display:table on
  // it inline (and a stylesheet rule outranks ours), so the flex layout is
  // set inline too, and the old value put back when the feature is off.
  function attach(panel) {
    if (!panel.hasAttribute(PANEL)) {
      panel.setAttribute(PANEL, panel.style.getPropertyValue('display') || '');
    }
    if (panel.style.getPropertyValue('display') !== 'flex' || panel.style.getPropertyPriority('display') !== 'important') {
      panel.style.setProperty('display', 'flex', 'important');
    }
  }
  function detach(panel) {
    const prev = panel.getAttribute(PANEL);
    panel.removeAttribute(PANEL);
    if (prev) panel.style.setProperty('display', prev);
    else panel.style.removeProperty('display');
  }

  function clear() {
    document.querySelectorAll(`[${PANEL}]`).forEach(detach);
    document.querySelectorAll('[data-lbt-ordered]').forEach((c) => {
      c.removeAttribute('data-lbt-ordered');
      c.removeAttribute(CARD);
      c.style.removeProperty('order');
    });
    document.querySelectorAll(`[${GRIP}]`).forEach((g) => g.remove());
  }

  function setOrder(el, n) {
    if (el.style.order !== String(n)) el.style.setProperty('order', String(n));
    if (!el.hasAttribute('data-lbt-ordered')) el.setAttribute('data-lbt-ordered', '');
  }

  function sync() {
    if (!alive()) return retire();
    if (!on) {
      clear();
      return;
    }
    if (drag) return;
    // Leftovers from a drag that never finished (say, the card was redrawn mid-drag).
    document.querySelectorAll('[data-lbt-drop-line]').forEach((l) => l.remove());
    document.querySelectorAll('[data-lbt-dragging]').forEach((c) => c.removeAttribute('data-lbt-dragging'));
    const s = scan();
    if (!s) return;
    watch(s.panel);
    document.querySelectorAll(`[${PANEL}]`).forEach((p) => { if (p !== s.panel) detach(p); });
    attach(s.panel);
    if (s.header) setOrder(s.header, -1000);
    s.alerts.forEach((a, i) => {
      setOrder(a, -900 + i);
      a.removeAttribute(CARD);
      const g = a.querySelector(`:scope > [${GRIP}]`);
      if (g) g.remove();
    });
    ordered(s).forEach((c, i) => {
      setOrder(c.el, i);
      if (c.el.getAttribute(CARD) !== c.title) c.el.setAttribute(CARD, c.title);
      ensureGrip(c.el, c.title);
    });
  }

  // ---------- grip, dragging and keys ----------

  function ensureGrip(el, title) {
    let g = el.querySelector(`:scope > [${GRIP}]`);
    if (g && g.dataset.inst !== INSTANCE) {
      g.remove();
      g = null;
    }
    if (g) {
      if (g.dataset.title !== title) {
        g.dataset.title = title;
        g.setAttribute('aria-label', `Move ${title}`);
        g.title = `Drag to move ${title} (or use the arrow keys)`;
      }
      return;
    }
    g = document.createElement('button');
    g.type = 'button';
    g.setAttribute(GRIP, '');
    g.dataset.title = title;
    g.dataset.inst = INSTANCE;
    g.setAttribute('aria-label', `Move ${title}`);
    g.title = `Drag to move ${title} (or use the arrow keys)`;
    g.innerHTML = GRIP_SVG;
    g.addEventListener('pointerdown', startDrag);
    g.addEventListener('keydown', onGripKey);
    g.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); });
    el.append(g);
  }

  function save(view, titles) {
    saved = { ...saved, [view]: titles };
    try { chrome.storage.sync.set({ [ORDER_KEY]: saved }); } catch { /* ignore */ }
  }

  function onGripKey(e) {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    e.preventDefault();
    e.stopPropagation();
    const s = scan();
    if (!s) return;
    const list = ordered(s).map((c) => c.title);
    const title = e.currentTarget.dataset.title;
    const i = list.indexOf(title);
    const j = e.key === 'ArrowUp' ? i - 1 : i + 1;
    if (i < 0 || j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]];
    save(s.view, list);
    sync();
    const g = document.querySelector(`[${CARD}="${CSS.escape(title)}"] > [${GRIP}]`);
    if (g) g.focus();
  }

  function startDrag(e) {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const s = scan();
    if (!s) return;
    const cards = ordered(s);
    const title = e.currentTarget.dataset.title;
    const me = cards.find((c) => c.title === title);
    if (!me) return;
    const line = document.createElement('div');
    line.setAttribute('data-lbt-drop-line', '');
    document.body.append(line);
    drag = { s, cards, me, line, target: cards.indexOf(me), grip: e.currentTarget, id: e.pointerId };
    me.el.setAttribute('data-lbt-dragging', '');
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    // Listened for on the whole page: the grip can be redrawn away mid-drag
    // (the Toolkit widgets rebuild themselves), taking its events with it.
    document.addEventListener('pointermove', moveDrag, true);
    document.addEventListener('pointerup', endDrag, true);
    document.addEventListener('pointercancel', endDrag, true);
    window.addEventListener('blur', cancelDrag);
    document.addEventListener('keydown', escDrag, true);
    moveDrag(e);
  }

  // Where it would land: before the first card whose middle is below the pointer.
  function moveDrag(e) {
    if (!drag) return;
    const rects = drag.cards.map((c) => c.el.getBoundingClientRect());
    let idx = drag.cards.length;
    for (let i = 0; i < rects.length; i++) {
      if (e.clientY < rects[i].top + rects[i].height / 2) { idx = i; break; }
    }
    drag.target = idx;
    const panelRect = drag.s.panel.getBoundingClientRect();
    const y = idx < rects.length ? rects[idx].top - 6 : rects[rects.length - 1].bottom - 6;
    Object.assign(drag.line.style, { top: `${Math.round(y)}px`, left: `${Math.round(panelRect.left)}px`, width: `${Math.round(panelRect.width)}px` });
  }

  function finishDrag(apply) {
    if (!drag) return;
    const d = drag;
    drag = null;
    d.line.remove();
    d.me.el.removeAttribute('data-lbt-dragging');
    document.removeEventListener('pointermove', moveDrag, true);
    document.removeEventListener('pointerup', endDrag, true);
    document.removeEventListener('pointercancel', endDrag, true);
    window.removeEventListener('blur', cancelDrag);
    document.removeEventListener('keydown', escDrag, true);
    try { d.grip.releasePointerCapture(d.id); } catch { /* ignore */ }
    if (!apply) return sync();
    const list = d.cards.map((c) => c.title);
    const from = list.indexOf(d.me.title);
    let to = d.target;
    if (to > from) to -= 1;
    if (to !== from) {
      list.splice(from, 1);
      list.splice(to, 0, d.me.title);
      save(d.s.view, list);
    }
    sync();
  }
  function endDrag(e) {
    if (drag && e.pointerId !== drag.id) return;
    finishDrag(e.type === 'pointerup');
  }
  function cancelDrag() { finishDrag(false); }
  function escDrag(e) {
    if (e.key === 'Escape') {
      e.stopPropagation();
      finishDrag(false);
    }
  }

  // ---------- wiring ----------

  chrome.storage.sync.get({ [KEY]: true, [PIN_KEY]: true, [ORDER_KEY]: {} }, (st) => {
    on = st[KEY] !== false;
    pinAlerts = st[PIN_KEY] !== false;
    saved = st[ORDER_KEY] && typeof st[ORDER_KEY] === 'object' ? st[ORDER_KEY] : {};
    sync();
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return;
    if (changes[KEY]) on = changes[KEY].newValue !== false;
    if (changes[PIN_KEY]) pinAlerts = changes[PIN_KEY].newValue !== false;
    if (changes[ORDER_KEY]) saved = changes[ORDER_KEY].newValue && typeof changes[ORDER_KEY].newValue === 'object' ? changes[ORDER_KEY].newValue : {};
    if (changes[KEY] || changes[PIN_KEY] || changes[ORDER_KEY]) {
      if (changes[PIN_KEY]) clear();
      sync();
    }
  });
  // Re-apply right away when cards are added or redrawn (no flash of the
  // app's order), and on a light poll as the panel changes with selections.
  let queued = false;
  function soon() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; sync(); });
  }
  function watch(panel) {
    if (observer && observer.panel === panel) return;
    if (observer) observer.disconnect();
    observer = new MutationObserver(soon);
    observer.panel = panel;
    observer.observe(panel, { childList: true });
  }
  timer = setInterval(sync, 700);
})();
