/**
 * Toolkit for Liquid Budget — "Hide currency symbol".
 *
 * Removes the currency symbol ($, or the budget's own currency) from amounts
 * everywhere in Liquid Budget, including the Toolkit's own pages and widgets:
 * "$1,234.56" → "1,234.56", "-$12.00" → "-12.00". Only symbols attached to a
 * number are touched; inputs and editable fields are left alone.
 *
 * It rewrites the text of amounts in place and keeps watching the page, so
 * amounts the app re-renders are cleaned again. Switching it off puts the
 * original text back.
 */
(function () {
  'use strict';

  const KEY = 'hideCurrency';
  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'INPUT', 'SELECT', 'OPTION', 'CODE', 'PRE']);
  const original = new WeakMap(); // text node -> its text before we changed it
  const touched = new Set(); // text nodes we changed (to restore on switch-off)
  let on = false;
  let symbol = '$';
  let pattern = makePattern(symbol);
  let observer = null;
  let lookedUpFor = null;

  function makePattern(sym) {
    const esc = sym.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Symbol right before a number (optionally after a minus), or right after one.
    return new RegExp(`${esc}[\\s\\u00a0]?(?=-?[\\d.,])|(?<=[\\d.,])[\\s\\u00a0]?${esc}`, 'g');
  }

  // Lets the Toolkit's other scripts format amounts the same way.
  globalThis.LBTCurrency = {
    strip(text) {
      if (!on || typeof text !== 'string') return text;
      pattern.lastIndex = 0;
      return text.replace(pattern, '');
    },
  };

  function budgetIdFromPath() {
    const m = location.pathname.match(/^\/budget\/([0-9a-f-]{36})(?:\/|$)/i);
    return m ? m[1] : null;
  }

  // The budget's currency symbol, from the app's own budget record; "$" if unknown.
  async function lookUpSymbol() {
    const id = budgetIdFromPath();
    if (!id || lookedUpFor === id) return;
    lookedUpFor = id;
    try {
      const r = await fetch(`/api/budget/${encodeURIComponent(id)}`, { credentials: 'same-origin', headers: { Accept: 'application/json' } });
      if (!r.ok) return;
      const b = await r.json();
      const cur = b && typeof b.currency === 'string' && /^[A-Z]{3}$/.test(b.currency) ? b.currency : null;
      if (!cur) return;
      const part = new Intl.NumberFormat('en-US', { style: 'currency', currency: cur }).formatToParts(1).find((p) => p.type === 'currency');
      if (part && part.value && part.value !== symbol) {
        restoreAll();
        symbol = part.value;
        pattern = makePattern(symbol);
        if (on) scan(document.body);
      }
    } catch {
      /* keep "$" */
    }
  }

  function skippable(node) {
    const el = node.parentElement;
    if (!el) return true;
    if (SKIP.has(el.tagName)) return true;
    return !!el.closest('[contenteditable=""], [contenteditable="true"], input, textarea, select');
  }

  function clean(node) {
    const text = node.data;
    if (!text || text.indexOf(symbol) === -1 || skippable(node)) return;
    pattern.lastIndex = 0;
    const next = text.replace(pattern, '');
    if (next === text) return;
    original.set(node, text);
    touched.add(node);
    node.data = next;
  }

  // Overlays drawn from attributes (the Toolkit's "Available includes upcoming").
  function cleanAttr(el) {
    const v = el.getAttribute('data-lbt-adj');
    if (!v || v.indexOf(symbol) === -1) return;
    pattern.lastIndex = 0;
    el.setAttribute('data-lbt-adj', v.replace(pattern, ''));
  }

  function scan(root) {
    if (!root) return;
    if (root.nodeType === Node.TEXT_NODE) return clean(root);
    if (root.nodeType !== Node.ELEMENT_NODE) return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) clean(n);
    if (root.hasAttribute && root.hasAttribute('data-lbt-adj')) cleanAttr(root);
    root.querySelectorAll && root.querySelectorAll('[data-lbt-adj]').forEach(cleanAttr);
  }

  function restoreAll() {
    for (const node of touched) {
      const was = original.get(node);
      pattern.lastIndex = 0;
      // Put it back only if the app hasn't replaced the text since.
      if (node.isConnected && was != null && node.data === was.replace(pattern, '')) node.data = was;
    }
    touched.clear();
  }

  function start() {
    if (observer) return;
    scan(document.body);
    observer = new MutationObserver((records) => {
      for (const r of records) {
        if (r.type === 'characterData') clean(r.target);
        else if (r.type === 'attributes') cleanAttr(r.target);
        else r.addedNodes.forEach(scan);
      }
    });
    observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['data-lbt-adj'] });
  }

  function stop() {
    if (observer) observer.disconnect();
    observer = null;
    restoreAll();
  }

  function apply() {
    if (on) {
      start();
      lookUpSymbol();
    } else {
      stop();
    }
  }

  chrome.storage.sync.get({ [KEY]: false }, (s) => {
    on = s[KEY] === true;
    apply();
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync' && changes[KEY]) {
      on = changes[KEY].newValue === true;
      apply();
    }
  });
  // Switching budgets can change the currency.
  setInterval(() => { if (on) lookUpSymbol(); }, 3000);
})();
