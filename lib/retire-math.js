// Toolkit for Liquid Budget — Retirement Horizon math.
// How far the money you have is from financial independence (FI): the point
// where a safe yearly withdrawal (4% by default) covers a year of spending.
// Money stays in scale-4 integers (123400 = $12.34); rates are fractions (0.04).
(function (root) {
'use strict';

const F = root.LBTForecast || (typeof require !== 'undefined' ? require('./forecast-math.js') : null);
const NO_GROUP = 'Other accounts';

const groupOf = (a) => {
  const g = a && a.accountGroup;
  const name = g && typeof g === 'object' ? g.name : g;
  return String(name || '').trim() || NO_GROUP;
};

/**
 * Balance of every account from its transactions dated up to and including
 * `today` (pending ones too), grouped by the sidebar's account groups.
 * → { byAccount: Map(id -> s4), groups: [{ name, total, accounts: [{ id, name, type, balance }] }] } (sidebar order)
 */
function accountBalances(accounts, transactions, today, dateOf = F.txDate) {
  const byAccount = new Map();
  for (const t of transactions || []) {
    if (!t || typeof t.amount !== 'number' || !t.accountId || !t.dateEpoch) continue;
    if (dateOf(t.dateEpoch) > today) continue;
    byAccount.set(t.accountId, (byAccount.get(t.accountId) || 0) + t.amount);
  }
  const groups = [];
  const index = new Map();
  for (const a of accounts || []) {
    if (!a || !a.id) continue;
    const name = groupOf(a);
    if (!index.has(name)) {
      index.set(name, { name, total: 0, accounts: [] });
      groups.push(index.get(name));
    }
    const g = index.get(name);
    const balance = byAccount.get(a.id) || 0;
    g.total += balance;
    g.accounts.push({ id: a.id, name: a.name, type: a.type, balance });
  }
  const last = groups.findIndex((g) => g.name === NO_GROUP);
  if (last >= 0) groups.push(groups.splice(last, 1)[0]); // ungrouped accounts last
  return { byAccount, groups };
}

/** Groups counted by default: everything except homes and vehicles (and their loans), which you can't live off. */
function defaultGroups(groups) {
  return (groups || []).filter((g) => !/propert|vehicle|real estate|home|house|\bcars?\b|\bauto/i.test(g.name)).map((g) => g.name);
}

/** Categories left out of spending by default: ones that look like savings. */
function defaultSkipCategories(categories) {
  return (categories || []).filter((c) => /\b(vault|savings?|invest\w*|retire\w*|emergency fund)\b/i.test(String(c.name || ''))).map((c) => c.id);
}

/**
 * Spending and income over the last `months` full months (the current month
 * left out), cut back to the budget's history when shorter, then made yearly.
 * - spending: net bucket outflow (refunds net off), bucketed transfers included,
 *   on-budget accounts only, skipping categories in `skipCats`
 * - income:   unbucketed TRANSACTIONs with a positive amount, on-budget accounts only
 * `rows` are compact transactions (see LBTForecast.compactTransactions).
 * → { months, from, to, spending, income, monthlySpending, monthlyIncome } (yearly amounts)
 */
function yearlyFlows({ rows, buckets, today, months = 12, offBudgetAccounts = [], skipCats = [], dateOf = F.txDate }) {
  const ym = F.ymOf(today);
  const to = F.addMonths(ym, -1);
  let from = F.addMonths(ym, -months);
  const off = new Set(offBudgetAccounts);
  const skip = new Set(skipCats);
  const catOf = new Map((buckets || []).map((b) => [b.id, b.categoryId]));
  let first = null;
  for (const [acct, epoch, , , bucket] of rows || []) {
    if (!epoch || off.has(acct) || !bucket) continue;
    const m = F.ymOf(dateOf(epoch));
    if (!first || m < first) first = m;
  }
  if (first && first > from) from = first;
  const span = from <= to ? (Number(to.slice(0, 4)) - Number(from.slice(0, 4))) * 12 + (Number(to.slice(5)) - Number(from.slice(5))) + 1 : 0;
  let out = 0;
  let inc = 0;
  for (const [acct, epoch, amount, , bucket, , type] of rows || []) {
    if (!epoch || off.has(acct)) continue;
    const m = F.ymOf(dateOf(epoch));
    if (m < from || m > to) continue;
    if (bucket) {
      const parts = typeof bucket === 'string' ? [[bucket, amount]] : Object.entries(bucket).map(([id, p]) => [id, (amount < 0 ? -1 : 1) * Math.abs(p)]);
      for (const [id, amt] of parts) if (!skip.has(catOf.get(id))) out -= amt;
    } else if (type === 'T' && amount > 0) {
      inc += amount;
    }
  }
  const perYear = span ? 12 / span : 0;
  const spending = Math.max(0, Math.round(out * perYear));
  const income = Math.round(inc * perYear);
  return { months: span, from, to, spending, income, monthlySpending: Math.round(spending / 12), monthlyIncome: Math.round(income / 12) };
}

/**
 * Years until `start`, growing at `growth` a year with `save` added each year,
 * reaches `target`. 0 if already there; null if it never gets there (or not within 100 years).
 */
function yearsTo(start, save, growth, target) {
  if (start >= target) return 0;
  let n;
  if (Math.abs(growth) < 1e-9) {
    n = save > 0 ? (target - start) / save : null;
  } else {
    const k = save / growth;
    const ratio = (target + k) / (start + k);
    n = start + k > 0 && ratio > 0 ? Math.log(ratio) / Math.log(1 + growth) : null;
  }
  return n != null && Number.isFinite(n) && n >= 0 && n <= 100 ? n : null;
}

/**
 * horizon({ invested, spending, saving, rate = 0.04, growth = 0.05, multiple })  (yearly amounts)
 * → { fiNumber, multiple, customMultiple, safeYearly, safeMonthly, progress, gap, years, coastYears }
 *   fiNumber:   spending × multiple; without a multiple, spending ÷ rate (25× spending at 4%)
 *   progress:   invested ÷ fiNumber (also how much of spending the safe withdrawal covers)
 *   years:      until invested reaches fiNumber, growing at `growth` with `saving` added yearly
 *   coastYears: the same with no more saving
 */
function horizon({ invested, spending, saving, rate = 0.04, growth = 0.05, multiple = null }) {
  const r = rate > 0 ? rate : 0.04;
  const custom = Number(multiple) > 0 ? Number(multiple) : null;
  const fiNumber = Math.round(custom ? spending * custom : spending / r);
  const safeYearly = Math.round(Math.max(0, invested) * r);
  return {
    rate: r,
    growth,
    multiple: custom || 1 / r,
    customMultiple: !!custom,
    fiNumber,
    safeYearly,
    safeMonthly: Math.round(safeYearly / 12),
    progress: fiNumber > 0 ? Math.max(0, invested) / fiNumber : null,
    gap: Math.max(0, fiNumber - invested),
    years: spending > 0 ? yearsTo(invested, saving, growth, fiNumber) : 0,
    coastYears: spending > 0 ? yearsTo(invested, 0, growth, fiNumber) : 0,
  };
}

/**
 * If you stopped working today: how long `invested` lasts paying `spending` a year.
 * → { days, years, grownYears }
 *   days, years: with no growth (invested ÷ spending)
 *   grownYears:  with `growth` a year on what's left, spending taken out each year;
 *                null when growth alone covers the spending (it lasts indefinitely)
 */
function runway({ invested, spending, growth = 0 }) {
  if (!(spending > 0)) return { days: null, years: null, grownYears: null };
  const p = Math.max(0, invested);
  const years = p / spending;
  let grownYears = years;
  if (Math.abs(growth) > 1e-9 && p > 0) {
    const left = spending - growth * p; // what growth doesn't cover in the first year
    grownYears = left > 0 ? Math.log(spending / left) / Math.log(1 + growth) : null;
  }
  return { days: Math.floor(years * 365.25), years, grownYears };
}

const api = { accountBalances, defaultGroups, defaultSkipCategories, yearlyFlows, yearsTo, horizon, runway, NO_GROUP };
root.LBTRetire = api;
if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
