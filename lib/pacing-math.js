// Toolkit for Liquid Budget — Pacing math (current month, every transaction).
// Builds on lib/forecast-math.js (LBTForecast). Unlike the old Forecast, this
// counts every transaction dated in the current month, including ones dated
// after today (scheduled bills, upcoming paychecks) and pending ones.
// Money stays in Liquid Budget's scale-4 integers (123400 = $12.34).
(function (root) {
'use strict';

const F = root.LBTForecast || (typeof require !== 'undefined' ? require('./forecast-math.js') : null);
const pad = (n) => String(n).padStart(2, '0');
const CENT = 100; // scale-4
const HISTORY = 6; // months of history for "usual"

function quantile(values, q) {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return 0;
  const pos = (v.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return v[lo] + (v[hi] - v[lo]) * (pos - lo);
}
const median = (values) => Math.round(quantile(values, 0.5));

/** Per-bucket signed shares of one compact row: [[bucketId, amount], …]. */
function shares(bucket, amount) {
  if (!bucket) return [];
  if (typeof bucket === 'string') return [[bucket, amount]];
  const sign = amount < 0 ? -1 : 1;
  return Object.entries(bucket).map(([id, part]) => [id, sign * Math.abs(part)]);
}

/**
 * Pacing for the month containing `today`.
 * rows: compact transactions [accountId, dateEpoch, amount, pending, bucket, payee, type]
 *   (type: 'T' transaction, 'X' transfer, 'A' adjustment; older rows may lack payee/type).
 * hiddenCats: category IDs left out of totals, the chart and the at-risk list.
 * offBudgetAccounts: account IDs to ignore entirely (off-budget assets and liabilities).
 *
 * Per bucket:
 *   spent        net outflow dated this month up to and including today
 *   availableNow the budget screen's Available today (overspending doesn't carry
 *                into a new month; see LBTForecast.availableAt)
 *   had          availableNow + spent (what the month started with plus assignments)
 *   scheduled    transactions dated after today but still this month (signed net)
 *   pace         steady buckets only: spent ÷ days elapsed × days left, minus what's
 *                already scheduled (so a scheduled grocery run isn't counted twice)
 *   endBalance   availableNow + scheduled − pace
 *   runsOutOn    first day the balance drops below $0, walking the rest of the month
 */
function buildPacing({ categories, buckets, rows, today, hiddenCats = [], offBudgetAccounts = [], dateOf = F.txDate }) {
  const mi = F.monthInfo(today);
  const opts = { includePending: true, dateOf };
  const activity = F.bucketActivity(rows, today, opts);
  const counts = F.bucketOutflowCounts(rows, today, opts);
  const hidden = new Set(hiddenCats);

  const live = (buckets || []).filter((b) => !b.archived);
  const known = new Set((categories || []).map((c) => c.id));
  const catName = new Map((categories || []).map((c) => [c.id, c.name]));
  const catOf = (b) => (known.has(b.categoryId) ? b.categoryId : '__none');
  const bucketById = new Map(live.map((b) => [b.id, b]));
  const included = (id) => {
    const b = bucketById.get(id);
    return !!b && !hidden.has(catOf(b));
  };

  // Walk this month's transactions once.
  const dim = mi.daysInMonth;
  const prevYm = F.addMonths(mi.ym, -1);
  const prevDim = F.monthInfo(`${prevYm}-01`).daysInMonth;
  const prevNet = new Array(prevDim + 1).fill(0); // last month, included buckets, by day
  const future = {}; // bucketId -> [{ day, date, amount, payee }]
  const dailyNet = new Array(dim + 1).fill(0); // included buckets, signed, by day of month
  const upcoming = [];
  const income = { received: 0, coming: 0 };
  let txCount = 0;
  let futureCount = 0;
  const offBudget = new Set(offBudgetAccounts);
  for (const row of rows || []) {
    const [accountId, epoch, amount, , bucket, payee, type] = row;
    if (!epoch) continue;
    if (offBudget.has(accountId)) continue; // assets/liabilities tracked off budget (HSA, loans, vehicles…)
    const date = dateOf(epoch);
    if (F.ymOf(date) === prevYm) {
      for (const [id, amt] of shares(bucket, amount)) if (included(id)) prevNet[Number(date.slice(8, 10))] += amt;
      continue;
    }
    if (F.ymOf(date) !== mi.ym) continue;
    txCount++;
    const day = Number(date.slice(8, 10));
    const isFuture = date > today;
    if (isFuture) futureCount++;
    const parts = shares(bucket, amount);
    if (parts.length) {
      const mine = [];
      for (const [id, amt] of parts) {
        if (!bucketById.has(id)) continue;
        if (included(id)) dailyNet[day] += amt;
        if (isFuture) (future[id] ||= []).push({ day, date, amount: amt, payee: payee || '' });
        mine.push({ id, amount: amt });
      }
      if (isFuture && mine.some((m) => included(m.id))) {
        upcoming.push({ date, payee: payee || '', amount, kind: 'bucket', buckets: mine.map((m) => ({ ...m, name: bucketById.get(m.id).name })) });
      }
    } else if (type !== 'X' && type !== 'A') {
      // No bucket and not a transfer/adjustment: income, or spending nobody assigned yet.
      if (amount > 0) income[isFuture ? 'coming' : 'received'] += amount;
      if (isFuture) upcoming.push({ date, payee: payee || '', amount, kind: amount > 0 ? 'income' : 'unassigned', buckets: [] });
    }
  }
  upcoming.sort((a, b) => a.date.localeCompare(b.date) || a.amount - b.amount);

  const dateFor = (d) => `${mi.ym}-${pad(d)}`;

  // ---- History: the previous HISTORY months, day by day, for "usual by today" ----
  const histYms = [];
  for (let i = 1; i <= HISTORY; i++) histYms.push(F.addMonths(mi.ym, -i));
  const histSet = new Set(histYms);
  const histDim = Object.fromEntries(histYms.map((ym) => [ym, F.monthInfo(`${ym}-01`).daysInMonth]));
  const hist = {}; // bucketId -> ym -> Float64Array(dim + 1) of outflow (positive = spent)
  for (const [accountId, epoch, amount, , bucket] of rows || []) {
    if (!bucket || !epoch || offBudget.has(accountId)) continue;
    const date = dateOf(epoch);
    const ym = F.ymOf(date);
    if (!histSet.has(ym)) continue;
    const d = Number(date.slice(8, 10));
    for (const [id, amt] of shares(bucket, amount)) {
      if (!bucketById.has(id)) continue;
      const byYm = (hist[id] ||= {});
      const arr = (byYm[ym] ||= new Float64Array(histDim[ym] + 1));
      arr[d] += -amt;
    }
  }
  // Running total of a month's spending through day d (clamped to that month's length).
  const cumThrough = (arr, dimOf, d) => {
    let c = 0;
    const last = Math.min(d, dimOf);
    for (let i = 1; i <= last; i++) c += arr[i];
    return c;
  };

  function bucketHistory(b) {
    const byYm = hist[b.id] || {};
    const used = histYms.filter((ym) => byYm[ym]);
    if (!used.length) return null;
    const byToday = used.map((ym) => Math.max(0, cumThrough(byYm[ym], histDim[ym], mi.day)));
    const month = used.map((ym) => Math.max(0, cumThrough(byYm[ym], histDim[ym], histDim[ym])));
    // Ran out: ended the month at or below $0 having spent from it (overspent counts for bills only).
    const months = activity[b.id] || {};
    const steady = F.isSteady(counts[b.id], mi.ym);
    const last3 = histYms.slice(0, 3);
    let ranOut = 0;
    let checked = 0;
    for (const ym of last3) {
      const spentThen = Math.max(0, -(months[ym] || 0));
      if (!spentThen) continue;
      checked++;
      const end = F.availableAt(b, months, ym);
      if (end < -CENT / 2 || (steady && end <= CENT / 2)) ranOut++;
    }
    return { months: used.length, usualByToday: median(byToday), usualMonth: median(month), ranOut, checked };
  }

  function paceBucket(b) {
    const months = activity[b.id] || {};
    const activityNow = months[mi.ym] || 0;
    const availableNow = F.availableAt(b, months, mi.ym); // matches the budget screen's Available
    const spent = Math.max(0, -activityNow);
    const had = availableNow + spent;
    const sched = (future[b.id] || []).slice().sort((x, y) => x.day - y.day);
    let scheduled = 0;
    let scheduledOut = 0;
    for (const s of sched) {
      scheduled += s.amount;
      if (s.amount < 0) scheduledOut -= s.amount;
    }
    const kind = F.isSteady(counts[b.id], mi.ym) ? 'steady' : 'bill';
    const dailyBurn = kind === 'steady' ? spent / mi.day : 0;
    // An envelope that's been spent to exactly $0 is treated as done for the
    // month, as on the budget screen: more spending means moving money in.
    const settled = spent > 0 && availableNow === 0;
    const pace = kind === 'steady' && !settled && mi.daysLeft ? Math.max(0, Math.round(dailyBurn * mi.daysLeft) - scheduledOut) : 0;
    const endBalance = availableNow + scheduled - pace;

    // Walk the rest of the month: scheduled amounts on their dates, pace spread evenly.
    let runsOutOn = null;
    let trigger = null;
    if (availableNow < 0) {
      runsOutOn = today;
    } else if (mi.daysLeft) {
      const perDay = pace / mi.daysLeft;
      let bal = availableNow;
      for (let d = mi.day + 1; d <= dim && !runsOutOn; d++) {
        const todays = sched.filter((s) => s.day === d);
        for (const s of todays) bal += s.amount;
        bal -= perDay;
        if (bal < -CENT / 2) {
          runsOutOn = dateFor(d);
          const big = todays.filter((s) => s.amount < 0).sort((x, y) => x.amount - y.amount)[0];
          if (big) trigger = big;
        }
      }
    }
    let cause = null;
    if (runsOutOn) cause = availableNow < 0 ? 'over' : availableNow + scheduled < -CENT / 2 ? 'scheduled' : 'pace';

    return {
      id: b.id,
      name: b.name,
      categoryId: catOf(b),
      categoryName: catName.get(b.categoryId) || 'Other',
      kind,
      spent,
      had,
      availableNow,
      scheduled,
      scheduledOut,
      scheduledItems: sched,
      dailyBurn,
      pace,
      projectedSpend: spent - scheduled + pace,
      endBalance,
      runsOutOn,
      trigger,
      cause,
      atRisk: !!runsOutOn,
      history: bucketHistory(b),
    };
  }

  const all = live.map(paceBucket);
  const inc = all.filter((r) => included(r.id));

  const t = { spent: 0, had: 0, availableNow: 0, scheduled: 0, scheduledOut: 0, pace: 0, projectedSpend: 0, endBalance: 0 };
  for (const r of inc) for (const k of Object.keys(t)) t[k] += r[k];
  let liveSpend = 0;
  for (const r of inc) if (r.kind === 'steady' && !(r.spent > 0 && r.availableNow === 0)) liveSpend += r.spent;
  t.dailyBurn = liveSpend / mi.day;
  // What's left to spend per day once scheduled transactions clear.
  const freeAfterScheduled = t.availableNow + t.scheduled;
  t.safePerDay = mi.daysLeft && freeAfterScheduled > 0 ? Math.round(freeAfterScheduled / mi.daysLeft) : 0;

  // Cumulative spending by day: actual through today, then scheduled + pace.
  const pacePerDay = mi.daysLeft ? t.pace / mi.daysLeft : 0;
  const series = [];
  let cum = 0;
  for (let d = 1; d <= dim; d++) {
    cum += -dailyNet[d] + (d > mi.day ? pacePerDay : 0);
    series.push({ day: d, date: dateFor(d), cum: Math.round(cum), net: -dailyNet[d], actual: d <= mi.day });
  }

  // Last month's running total by day, for comparison on the chart.
  const prevSeries = [];
  let pcum = 0;
  for (let d = 1; d <= prevDim; d++) {
    pcum += -prevNet[d];
    prevSeries.push({ day: d, date: `${prevYm}-${pad(d)}`, cum: Math.round(pcum), net: -prevNet[d] });
  }
  const sameDay = prevSeries[Math.min(mi.day, prevDim) - 1];
  const prev = { ym: prevYm, daysInMonth: prevDim, series: prevSeries, total: Math.round(pcum), byToday: sameDay ? sameDay.cum : 0 };

  // Usual range by each day of the month, across the previous months that had spending.
  const incIds = inc.map((r) => r.id);
  const monthsWithData = histYms.filter((ym) => incIds.some((id) => hist[id] && hist[id][ym]));
  let typical = null;
  if (monthsWithData.length >= 3) {
    const curves = monthsWithData.map((ym) => {
      const dimOf = histDim[ym];
      const curve = new Array(dim + 1).fill(0);
      let c = 0;
      for (let d = 1; d <= dim; d++) {
        if (d <= dimOf) for (const id of incIds) { const a = hist[id] && hist[id][ym]; if (a) c += a[d]; }
        curve[d] = c;
      }
      return curve;
    });
    const band = [];
    for (let d = 1; d <= dim; d++) {
      const v = curves.map((c) => c[d]);
      band.push({ day: d, low: Math.round(quantile(v, 0.25)), mid: Math.round(quantile(v, 0.5)), high: Math.round(quantile(v, 0.75)) });
    }
    const today = band[mi.day - 1];
    const actual = series[mi.day - 1].cum;
    const end = band[dim - 1];
    // A little slack around the usual range (5% of the median) so tiny
    // differences don't flip the verdict; "watch" until 15% past it.
    const slack = today.mid * 0.05;
    let status = 'ok';
    if (actual > today.high + today.mid * 0.15) status = 'alarm';
    else if (actual > today.high + slack) status = 'watch';
    else if (actual < today.low - slack) status = 'below';
    typical = {
      months: monthsWithData.length,
      band,
      byToday: today,
      endOfMonth: end,
      actual,
      diffPct: today.mid > 0 ? (actual - today.mid) / today.mid : null,
      status,
      early: mi.day < 7,
    };
  }

  const atRisk = inc
    .filter((r) => r.atRisk)
    .sort((a, b) => a.runsOutOn.localeCompare(b.runsOutOn) || a.endBalance - b.endBalance);

  const groups = [];
  const cats = [...(categories || [])];
  if (live.some((b) => catOf(b) === '__none')) cats.push({ id: '__none', name: 'Other' });
  for (const c of cats) if (live.some((b) => catOf(b) === c.id)) groups.push({ id: c.id, name: c.name });

  return { month: mi, buckets: all, atRisk, totals: t, income, series, prev, typical, upcoming, txCount, futureCount, groups };
}

/**
 * Bucket spending over the last `days` days, today included (Days of Buffer).
 * Net of refunds, every bucket, transfers with a bucket included (mortgage and
 * loan payments are often recorded that way); nothing dated after today.
 */
function recentSpending(rows, today, days = 90, dateOf = F.txDate) {
  const [y, m, d] = today.split('-').map(Number);
  const s = new Date(y, m - 1, d - (days - 1));
  const start = `${s.getFullYear()}-${pad(s.getMonth() + 1)}-${pad(s.getDate())}`;
  let net = 0;
  for (const [, epoch, amount, , bucket] of rows || []) {
    if (!bucket || !epoch) continue;
    const date = dateOf(epoch);
    if (date < start || date > today) continue;
    for (const [, amt] of shares(bucket, amount)) net += amt;
  }
  const total = Math.max(0, -net);
  return { start, end: today, days, total, perDay: total / days };
}

/** Whole days a balance lasts at `perDay` (null when there's no spending to measure). */
function daysOfBuffer(balance, perDay) {
  if (!(perDay > 0)) return null;
  return Math.max(0, Math.floor(balance / perDay));
}

const api = { shares, buildPacing, recentSpending, daysOfBuffer, quantile };
root.LBTPacing = api;
if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
