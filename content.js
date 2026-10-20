/**
 * Toolkit for Liquid Budget — content script
 *
 * Thicker divider line between months in the transaction list.
 * (The Pacing page and compact menu live in pacing-ui.js.) Built against real LiquidBudget markup — rows are
 * div.group.grid.border-b[data-index], with the date (MM/DD/YYYY) in the
 * 3rd grid column. The list is a flow-based windowed list using top/bottom
 * spacer divs (not absolute positioning), so this reflows safely.
 */

const ROW_SELECTOR = 'div.group.grid.border-b[data-index]';
const DATE_COLUMN_INDEX = 3; // 1-based: checkbox, flag, date, ...
const DIVIDER_WIDTH_PX = 4;

const DEFAULTS = {
  thickMonthDividers: true,
};

let settings = { ...DEFAULTS };

// Reads the MM/DD/YYYY date span in the date column and returns a
// "YYYY-MM" key, or null if it can't be parsed.
function getRowMonthKey(row) {
  const dateCol = row.children[DATE_COLUMN_INDEX - 1];
  if (!dateCol) return null;
  const dateSpan = dateCol.querySelector('span.tabular-nums');
  if (!dateSpan) return null;
  const parts = dateSpan.textContent.trim().split('/');
  if (parts.length !== 3) return null;
  const [month, , year] = parts;
  if (!month || !year) return null;
  return `${year}-${month}`;
}

// Adds a 4px-thick top border wherever the month changes between two
// consecutive rows (works regardless of whether the list is sorted
// newest-first or oldest-first). The color is read from the row's own
// border-bottom so it matches the site's theme automatically.
function markMonthDividers() {
  const rows = Array.from(document.querySelectorAll(ROW_SELECTOR));
  let prevMonthKey = null;
  rows.forEach((row) => {
    row.style.borderTop = '';
    const monthKey = getRowMonthKey(row);
    if (!settings.thickMonthDividers) {
      if (monthKey !== null) prevMonthKey = monthKey;
      return;
    }
    if (monthKey === null) return;
    if (prevMonthKey !== null && monthKey !== prevMonthKey) {
      const cs = getComputedStyle(row);
      const color = cs.borderBottomColor || 'currentColor';
      row.style.borderTop = `${DIVIDER_WIDTH_PX}px solid ${color}`;
    }
    prevMonthKey = monthKey;
  });
}

function loadSettingsAndApply() {
  chrome.storage.sync.get(DEFAULTS, (stored) => {
    settings = { ...DEFAULTS, ...stored };
    markMonthDividers();
  });
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'sync') return;
  for (const key in changes) {
    settings[key] = changes[key].newValue;
  }
  markMonthDividers();
});

// The list re-renders rows as you scroll (windowed list). Debounce with
// requestAnimationFrame so we don't thrash on every scroll-driven mutation.
let rafId = null;
function scheduleApply() {
  if (rafId) return;
  rafId = requestAnimationFrame(() => {
    rafId = null;
    markMonthDividers();
  });
}

const observer = new MutationObserver(scheduleApply);

function findListContainer() {
  const firstRow = document.querySelector(ROW_SELECTOR);
  if (!firstRow) return null;
  // The rows sit inside a relatively-positioned container that also holds
  // the top/bottom spacer divs used for virtual scrolling.
  return firstRow.parentElement;
}

function startObserving() {
  const container = findListContainer();
  if (container) {
    observer.observe(container, { childList: true });
  } else {
    // List hasn't rendered yet (e.g. still loading) — retry shortly.
    setTimeout(startObserving, 500);
    return;
  }
}

loadSettingsAndApply();
startObserving();

// LiquidBudget is a SPA, so the list container can be torn down and
// rebuilt on navigation (e.g. switching accounts/months). A lightweight
// polling check re-attaches the observer if that happens, without the
// cost of a subtree-wide MutationObserver on the whole page.
let lastContainer = findListContainer();
setInterval(() => {
  const current = findListContainer();
  if (current && current !== lastContainer) {
    if (lastContainer) observer.disconnect();
    observer.observe(current, { childList: true });
    lastContainer = current;
    scheduleApply();
  }
}, 1500);
