// Run with: node --test tests/*.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildPacing, recentSpending, daysOfBuffer } = require('../lib/pacing-math.js');

const $ = (d) => Math.round(d * 10000);
const day = (s) => Date.UTC(...s.split('-').map((n, i) => (i === 1 ? n - 1 : +n))) / 1000;
const tx = (date, amt, bucket, payee = '', type = 'T', pending = 0) => ['acct', day(date), $(amt), pending, bucket, payee, type];
const A = (amt, m = 10) => ({ amount: $(amt), year: 2026, month: m });

const categories = [{ id: 'flex', name: 'Flexy' }, { id: 'fixed', name: 'Fixed' }, { id: 'vault', name: 'Vault' }];
const buckets = [
  { id: 'g', name: 'Groceries', categoryId: 'flex', assignments: [A(462.48)] },
  { id: 'tu', name: 'Tuition', categoryId: 'fixed', assignments: [A(680, 9), A(700)] },
  { id: 'ph', name: 'Phone', categoryId: 'fixed', assignments: [A(30)] },
  { id: 'r', name: 'Reserves', categoryId: 'vault', assignments: [A(10000, 9)] },
];
const rows = [
  tx('2026-10-01', -150, 'g', 'Kroger'), tx('2026-10-09', -146.79, 'g', 'Kroger'), tx('2026-10-16', -100, 'g', 'Costco'),
  tx('2026-09-23', -680, 'tu'), // previous month, not steady
  tx('2026-10-23', -1355, 'tu', 'UT Tuition', 'T', 1), // future + pending
  tx('2026-10-27', -6.72, 'ph', 'T-Mobile', 'T', 1),
  tx('2026-10-29', 14000, null, 'Salary', 'T', 1),
  tx('2026-10-05', 2000, null, 'Bonus'),
  tx('2026-10-30', -500, null, '', 'X', 1), // transfer: ignored
  tx('2026-11-02', -50, 'g'), // next month: ignored
];
const today = '2026-10-18';

test('future-dated and pending transactions count; transfers and next month do not', () => {
  const p = buildPacing({ categories, buckets, rows, today });
  assert.equal(p.futureCount, 4);
  assert.equal(p.txCount, 8);
  assert.deepEqual(p.income, { received: $(2000), coming: $(14000) });
  assert.deepEqual(p.upcoming.map((u) => u.payee), ['UT Tuition', 'T-Mobile', 'Salary']);
});

test('scheduled bill overdraws a bucket', () => {
  const p = buildPacing({ categories, buckets, rows, today });
  const tu = p.buckets.find((b) => b.id === 'tu');
  assert.equal(tu.availableNow, $(700));
  assert.equal(tu.kind, 'bill');
  assert.equal(tu.pace, 0);
  assert.equal(tu.endBalance, $(700 - 1355));
  assert.equal(tu.runsOutOn, '2026-10-23');
  assert.equal(tu.cause, 'scheduled');
  assert.equal(tu.trigger.payee, 'UT Tuition');
});

test('steady bucket runs out from pace', () => {
  const p = buildPacing({ categories, buckets, rows, today });
  const g = p.buckets.find((b) => b.id === 'g');
  assert.equal(g.kind, 'steady');
  assert.equal(g.runsOutOn, '2026-10-21');
  assert.equal(g.cause, 'pace');
  assert.equal(Math.round(g.endBalance / 100), -22088); // $65.69 − $22.04/day × 13 days
});

test('phone fits, reserves untouched; only at-risk buckets listed, sorted by date', () => {
  const p = buildPacing({ categories, buckets, rows, today });
  assert.deepEqual(p.atRisk.map((b) => b.id), ['g', 'tu']);
  assert.equal(p.buckets.find((b) => b.id === 'ph').atRisk, false);
});

test('hidden categories drop out of totals and the list', () => {
  const p = buildPacing({ categories, buckets, rows, today, hiddenCats: ['fixed', 'vault'] });
  assert.deepEqual(p.atRisk.map((b) => b.id), ['g']);
  assert.equal(p.totals.spent, $(396.79));
  assert.equal(p.upcoming.length, 1); // only Salary (unbucketed) stays
});

test('cumulative series: actual through today, then scheduled + pace', () => {
  const p = buildPacing({ categories, buckets, rows, today, hiddenCats: ['vault'] });
  assert.equal(p.series.length, 31);
  assert.equal(p.series[17].cum, $(396.79));
  assert.equal(p.series[30].cum, p.totals.projectedSpend);
});

test('overspent bucket is flagged as already out', () => {
  const b = [{ id: 'x', name: 'Coffee', categoryId: 'flex', assignments: [A(10)] }];
  const p = buildPacing({ categories, buckets: b, rows: [tx('2026-10-02', -12, 'x')], today });
  assert.equal(p.atRisk[0].cause, 'over');
  assert.equal(p.atRisk[0].runsOutOn, today);
});

test('overspending in a past month does not carry forward (matches Available on the budget screen)', () => {
  const b = [{ id: 'x', name: 'Groceries', categoryId: 'flex', assignments: [A(400, 9), A(462.48, 10)] }];
  const r = [tx('2026-09-10', -411.96, 'x'), tx('2026-10-05', -396.79, 'x')];
  const p = buildPacing({ categories, buckets: b, rows: r, today });
  assert.equal(p.buckets[0].availableNow, $(65.69)); // not $53.73
  assert.equal(p.buckets[0].had, $(462.48));
});

test('previous month running total for the chart', () => {
  const r = [tx('2026-09-02', -100, 'g'), tx('2026-09-18', -50, 'g'), tx('2026-09-25', -30, 'g'), tx('2026-09-26', 10, 'g'), tx('2026-10-02', -5, 'g')];
  const p = buildPacing({ categories, buckets, rows: r, today });
  assert.equal(p.prev.ym, '2026-09');
  assert.equal(p.prev.series.length, 30);
  assert.equal(p.prev.byToday, $(150));
  assert.equal(p.prev.total, $(170));
  const hiddenFlex = buildPacing({ categories, buckets, rows: r, today, hiddenCats: ['flex'] });
  assert.equal(hiddenFlex.prev.total, 0);
});

test('recent spending: last 90 days including today, net of refunds, bucketed only', () => {
  const r = [
    tx('2026-07-20', -999, 'g'), // day 91 back: outside
    tx('2026-07-21', -100, 'g'), // first day of the window
    tx('2026-09-01', -4243.14, 'mort', 'Mortgage', 'X'), // bucketed transfer counts
    tx('2026-10-18', -20, 'g'),
    tx('2026-10-10', 20, 'g'), // refund
    tx('2026-10-11', -500, null), // unbucketed: ignored
    tx('2026-10-19', -70, 'g'), // future: ignored
  ];
  const s = recentSpending(r, today, 90);
  assert.equal(s.start, '2026-07-21');
  assert.equal(s.total, $(4343.14));
  assert.equal(daysOfBuffer($(26006.43), s.perDay), 538);
  assert.equal(daysOfBuffer($(100), 0), null);
});

test('off-budget accounts are left out of upcoming, income and counts', () => {
  const r = [
    tx('2026-10-29', 14000, null, 'Salary', 'T', 1),
    ['hsa', day('2026-10-31'), $(645.83), 0, null, 'HSA Contribution', 'T'],
    ['hsa', day('2026-10-05'), $(100), 0, null, 'HSA interest', 'T'],
  ];
  const p = buildPacing({ categories, buckets, rows: r, today, offBudgetAccounts: ['hsa'] });
  assert.deepEqual(p.upcoming.map((u) => u.payee), ['Salary']);
  assert.deepEqual(p.income, { received: 0, coming: $(14000) });
  assert.equal(p.txCount, 1);
  const { offBudgetIds } = require('../lib/forecast-math.js');
  assert.deepEqual(offBudgetIds([{ id: 'a', type: 'CHECKING' }, { id: 'b', type: 'OFF_BUDGET_ASSET' }, { id: 'c', type: 'OFF_BUDGET_LIABILITY' }]), ['b', 'c']);
});

test('usual range by today from previous months, and per-bucket history', () => {
  const b = [{ id: 'g', name: 'Groceries', categoryId: 'flex', assignments: [4, 5, 6, 7, 8, 9, 10].map((m) => A(400, m)) }];
  const r = [];
  // Previous six months: $200 by the 10th, $400 by month end (runs to $0 → "ran out" for a steady bucket).
  for (const m of ['04', '05', '06', '07', '08', '09']) {
    r.push(tx(`2026-${m}-05`, -100, 'g'), tx(`2026-${m}-10`, -100, 'g'), tx(`2026-${m}-25`, -200, 'g'));
  }
  r.push(tx('2026-10-03', -150, 'g'), tx('2026-10-12', -150, 'g'));
  const p = buildPacing({ categories, buckets: b, rows: r, today });
  assert.equal(p.typical.months, 6);
  assert.equal(p.typical.byToday.mid, $(200)); // by Oct 18: usual $200
  assert.equal(p.typical.actual, $(300));
  assert.equal(p.typical.status, 'alarm'); // 300 > 200 + 15%
  const g = p.buckets[0];
  assert.equal(g.history.usualByToday, $(200));
  assert.equal(g.history.usualMonth, $(400));
  assert.equal(g.history.ranOut, 3);
  assert.equal(g.history.checked, 3);
});

test('no usual range with under three months of history', () => {
  const b = [{ id: 'g', name: 'Groceries', categoryId: 'flex', assignments: [A(400, 9), A(400, 10)] }];
  const p = buildPacing({ categories, buckets: b, rows: [tx('2026-09-05', -100, 'g'), tx('2026-10-05', -100, 'g')], today });
  assert.equal(p.typical, null);
});
