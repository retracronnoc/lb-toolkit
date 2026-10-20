/**
 * Toolkit for Liquid Budget — sidebar tweaks.
 *
 * "Hide Net Worth": hides the Net Worth card at the bottom of the left
 * sidebar (above Add Account / Sort Accounts). Built against Liquid Budget's
 * markup: the card is a <button> whose label reads "Net Worth". If the app
 * changes that markup, this quietly does nothing.
 */
(function () {
  'use strict';

  const MARK = 'data-lbt-hidden';
  let hideNetWorth = true;
  let highlightErrors = true;

  // "Highlight budget errors": the app's error bars above the budget (Budget
  // Overdraft and the like) are table rows whose label is a red, upper-case
  // button. Marking the row lets pacing.css give it a light red band, a red
  // edge and larger text.
  const ALERT = 'data-lbt-alert';
  function markAlerts() {
    const rows = new Set();
    if (highlightErrors) {
      for (const b of document.querySelectorAll('main tr button.uppercase')) {
        if (!/\btext-destructive/.test(b.className)) continue;
        const tr = b.closest('tr');
        if (tr) rows.add(tr);
      }
    }
    document.querySelectorAll(`tr[${ALERT}]`).forEach((tr) => { if (!rows.has(tr)) tr.removeAttribute(ALERT); });
    rows.forEach((tr) => { if (!tr.hasAttribute(ALERT)) tr.setAttribute(ALERT, ''); });
  }

  function netWorthCard() {
    for (const el of document.querySelectorAll('button span')) {
      if (el.childElementCount || el.textContent.trim().toLowerCase() !== 'net worth') continue;
      if (el.closest('main')) continue;
      return el.closest('button');
    }
    return null;
  }

  function sync() {
    markAlerts();
    const card = netWorthCard();
    document.querySelectorAll(`[${MARK}="net-worth"]`).forEach((el) => {
      if (el !== card || !hideNetWorth) el.removeAttribute(MARK);
    });
    if (card && hideNetWorth && card.getAttribute(MARK) !== 'net-worth') card.setAttribute(MARK, 'net-worth');
  }

  chrome.storage.sync.get({ hideNetWorth: true, highlightErrors: true }, (s) => {
    hideNetWorth = s.hideNetWorth !== false;
    highlightErrors = s.highlightErrors !== false;
    sync();
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync' && (changes.hideNetWorth || changes.highlightErrors)) {
      if (changes.hideNetWorth) hideNetWorth = changes.hideNetWorth.newValue !== false;
      if (changes.highlightErrors) highlightErrors = changes.highlightErrors.newValue !== false;
      sync();
    }
  });
  // Remember the app's theme colors so the toolbar popup can match them.
  const THEME_VARS = ['background', 'foreground', 'card', 'muted', 'muted-foreground', 'border', 'primary', 'primary-foreground', 'success', 'warning'];
  let lastTheme = '';
  function saveTheme() {
    const cs = getComputedStyle(document.documentElement);
    const theme = {};
    for (const v of THEME_VARS) {
      const val = cs.getPropertyValue(`--${v}`).trim();
      if (/^[\d.\s%a-z/-]+$/i.test(val)) theme[v] = val;
    }
    if (!theme.background || !theme.primary) return;
    const sig = JSON.stringify(theme);
    if (sig === lastTheme) return;
    lastTheme = sig;
    try { chrome.storage.local.set({ lbtTheme: theme }); } catch { /* extension reloaded */ }
  }

  // The sidebar re-renders as you navigate; keep the setting applied.
  setInterval(sync, 700);
  saveTheme();
  setInterval(saveTheme, 5000);
})();
