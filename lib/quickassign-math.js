// Toolkit for Liquid Budget — quick assign suggestions.
// Compares each bucket's quick assign (the default amount Liquid Budget
// assigns each month) with what was actually spent from it, and assigned to
// it, over the last 6 or 12 full months. Money stays in scale-4 integers.
//
// What gets a suggestion:
// - raise:  average monthly spending is above the quick assign.
// - lower:  average monthly spending is well below a fixed quick assign, and the
//           bucket is spent from at least half the months (so savings buckets,
//           which rarely spend, are left alone). Top-off and minimum quick
//           assigns only refill what was spent, so they are never "too high".
// - set:    no quick assign, but the bucket is spent from almost every month.
// Recurring targets (e.g. $X every 12 months) are compared per month; one-off
// targets (save $X by a date) are skipped, as Liquid Budget works those out.
(function (root) {
'use strict';

const F = root.LBTForecast || (typeof require !== 'undefined' ? require('./forecast-math.js') : null);
const CENT = 100;
const DOLLAR = 10000;

/** Round a scale-4 amount up to a tidy step: $5 under $100, $10 under $500, $25 under $2,000, then $50. */
function niceUp(s4) {
  const d = s4 / DOLLAR;
  const step = d < 100 ? 5 : d < 500 ? 10 : d < 2000 ? 25 : 50;
  return Math.ceil(d / step - 1e-9) * step * DOLLAR;
}

/** Monthly equivalent of a quick assign, or null when it can't be compared. */
function quickAssignInfo(q) {
  if (!q || q.disabled || typeof q.amount !== 'number' || q.amount <= 0) return { kind: 'none', monthly: 0 };
  const rec = Number(q.recurrenceMonths) || 0;
  if (q.type === 'TARGET') {
    if (rec < 1) return { kind: 'target', monthly: null };
    return { kind: 'recurring', monthly: Math.round(q.amount / rec), every: rec };
  }
  const refill = q.type === 'MINIMUM' || !!q.topOff;
  return { kind: refill ? 'refill' : 'fixed', monthly: rec > 1 ? Math.round(q.amount / rec) : q.amount, every: rec > 1 ? rec : 1 };
}

const median = (xs) => {
  const s = xs.slice().sort((a, b) => a - b);
  if (!s.length) return 0;
  const m = (s.length - 1) / 2;
  return (s[Math.floor(m)] + s[Math.ceil(m)]) / 2;
};

/**
 * suggestQuickAssign({ buckets, rows, today, months = 12, hiddenCats, categories, offBudgetAccounts, dateOf })
 * → { months: [ym…] (oldest first), suggestions: [...], considered, totals: { current, suggested }, avgIncome, incomeMonths }
 * Each suggestion: { id, name, categoryName, action: 'raise'|'lower'|'set', qa, qaKind, every,
 *   suggested, avgSpend, medSpend, avgAssigned, activeMonths, n, ranOut, spend: [{ym, amount}],
 *   startBalance, endBalance, snoozedUntil }
 */
function suggestQuickAssign({ buckets, rows, today, months = 12, hiddenCats = [], categories = [], offBudgetAccounts = [], dateOf = F.txDate, minMonths = 3 }) {
  const ym = F.ymOf(today);
  const window = [];
  for (let i = months; i >= 1; i--) window.push(F.addMonths(ym, -i));
  const last = window[window.length - 1];
  const off = new Set(offBudgetAccounts);
  const live = (rows || []).filter((r) => !off.has(r[0]));
  const activity = F.bucketActivity(live, `${last}-31`, { includePending: true, dateOf });
  const hidden = new Set(hiddenCats);
  const catName = new Map((categories || []).map((c) => [c.id, c.name]));
  const catIds = new Set((categories || []).map((c) => c.id));

  const out = [];
  let considered = 0;
  const totals = { current: 0, suggested: 0 };
  for (const b of buckets || []) {
    if (!b || b.archived) continue;
    const cat = catIds.has(b.categoryId) ? b.categoryId : '__none';
    if (hidden.has(cat)) continue;
    const act = activity[b.id] || {};
    // The bucket's own start: its first assignment or first transaction.
    const starts = [...(b.assignments || []).map((a) => `${a.year}-${String(a.month).padStart(2, '0')}`), ...Object.keys(act)].sort();
    const first = starts[0];
    if (!first) continue;
    const ms = window.filter((m) => m >= first);
    if (ms.length < minMonths) continue;
    const qi = quickAssignInfo(b.quickAssign);
    if (qi.kind === 'target') continue;

    const spend = ms.map((m) => ({ ym: m, amount: Math.max(0, -(act[m] || 0)) }));
    const vals = spend.map((s) => s.amount);
    const n = ms.length;
    // Net over the whole window, so a refund or reimbursement in a later month
    // offsets the spending it paid back.
    const avgSpend = Math.max(0, -ms.reduce((a, m) => a + (act[m] || 0), 0)) / n;
    const medSpend = median(vals);
    const activeMonths = vals.filter((v) => v >= CENT).length;
    const avgAssigned = ms.reduce((a, m) => a + F.assignedIn(b, m), 0) / n;
    // Ran out: still overspent at the end of the month (spending it to exactly
    // $0, or topping it up by hand to cover it, doesn't count).
    let ranOut = 0;
    for (const m of ms) if (act[m] < 0 && F.availableAt(b, act, m) < -CENT / 2) ranOut++;
    const startBalance = F.availableAt(b, act, F.addMonths(ms[0], -1));
    const endBalance = F.availableAt(b, act, last);
    if (avgSpend < DOLLAR && qi.kind === 'none') continue; // nothing spent, nothing set
    considered++;

    const qa = qi.monthly || 0;
    const suggested = niceUp(avgSpend);
    const gap = suggested - qa;
    const big = Math.abs(gap) >= Math.max(20 * DOLLAR, qa * 0.15);
    let action = null;
    if (qi.kind === 'none') {
      if (activeMonths >= Math.ceil(n * 0.75) && avgSpend >= 20 * DOLLAR) action = 'set';
    } else if (gap > 0 && big && avgSpend > qa) {
      action = 'raise';
    } else if (gap < 0 && big && qi.kind !== 'refill' && activeMonths >= Math.ceil(n / 2)) {
      action = 'lower';
    }
    totals.current += qa;
    totals.suggested += action ? suggested : qa;
    if (!action) continue;
    out.push({
      id: b.id,
      name: b.name,
      categoryName: catName.get(b.categoryId) || 'Other',
      action,
      qa,
      qaKind: qi.kind,
      every: qi.every || 1,
      suggested,
      avgSpend: Math.round(avgSpend),
      medSpend: Math.round(medSpend),
      avgAssigned: Math.round(avgAssigned),
      activeMonths,
      n,
      ranOut,
      spend,
      startBalance,
      endBalance,
      snoozedUntil: (b.quickAssign && b.quickAssign.snoozedUntil) || null,
    });
  }
  // Average monthly income (unbucketed, non-transfer inflow), over the months the budget has data for.
  let firstTx = null;
  const income = {};
  for (const [, epoch, amount, , bucket, , type] of live) {
    if (!epoch) continue;
    const m = F.ymOf(dateOf(epoch));
    if (!firstTx || m < firstTx) firstTx = m;
    if (bucket || type !== 'T' || amount <= 0 || m < window[0] || m > last) continue;
    income[m] = (income[m] || 0) + amount;
  }
  const incomeMonths = firstTx ? window.filter((m) => m >= firstTx).length : 0;
  const avgIncome = incomeMonths ? Math.round(Object.values(income).reduce((a, c) => a + c, 0) / incomeMonths) : 0;

  const order = { raise: 0, set: 1, lower: 2 };
  out.sort((a, b) => order[a.action] - order[b.action] || Math.abs(b.suggested - b.qa) - Math.abs(a.suggested - a.qa));
  return { months: window, suggestions: out, considered, totals, avgIncome, incomeMonths };
}

const monthsBetween = (a, b) => { const [ay, am] = a.split('-').map(Number); const [by, bm] = b.split('-').map(Number); return (by - ay) * 12 + (bm - am); };

/**
 * What a bucket's quick assign asks for in month `ym`, the way Liquid Budget's
 * progress bars count it, given the balance carried in from the month before:
 * - fixed:            the amount (spread per month when it repeats every N months)
 * - top-off, minimum: the amount less the balance carried in
 * - target:           what's left to the target, spread over the months up to its date
 * Snoozed, disabled or missing quick assigns ask for nothing.
 * `activity` is { [ym]: net } for the bucket (see LBTForecast.bucketActivity).
 */
function monthNeed(bucket, activity, ym) {
  const q = bucket && bucket.quickAssign;
  if (!q || q.disabled || typeof q.amount !== 'number' || q.amount <= 0) return 0;
  if (q.snoozedUntil && `${ym}-01` < q.snoozedUntil) return 0;
  const rec = Number(q.recurrenceMonths) || 0;
  const carried = () => Math.max(0, F.availableAt(bucket, activity || {}, F.addMonths(ym, -1)));
  if (q.type === 'TARGET') {
    const tym = q.target ? String(q.target).slice(0, 7) : null;
    if (!tym) return 0;
    let due = tym;
    if (ym > due) {
      if (rec < 1) return 0; // a one-off target whose date has passed
      due = F.addMonths(tym, rec * Math.ceil(monthsBetween(tym, ym) / rec)); // this cycle's date
    }
    const left = monthsBetween(ym, due) + 1;
    return Math.round(Math.max(0, q.amount - carried()) / left);
  }
  if (q.type === 'MINIMUM' || q.topOff) return Math.max(0, q.amount - carried());
  return rec > 1 ? Math.round(q.amount / rec) : q.amount;
}

/**
 * How much of month `ym`'s quick assign goals is already assigned:
 * { need, funded, pct } where funded counts each bucket's assignment up to its own need
 * (so over-funding one bucket doesn't cover another), and pct is funded / need (null if nothing is needed).
 */
function monthFunding(buckets, activity, ym) {
  let need = 0;
  let funded = 0;
  for (const b of buckets || []) {
    if (!b || b.archived || b.state === 'ARCHIVED') continue;
    const n = monthNeed(b, (activity || {})[b.id], ym);
    if (n <= 0) continue;
    need += n;
    funded += Math.min(n, Math.max(0, F.assignedIn(b, ym)));
  }
  return { need, funded, pct: need > 0 ? funded / need : null };
}

const api = { suggestQuickAssign, quickAssignInfo, niceUp, monthNeed, monthFunding };
root.LBTQuickAssign = api;
if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
