// Run with: node --test tests/*.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { monthInfo, addMonths, bucketActivity, bucketOutflowCounts, isSteady, forecastBucket, buildForecast, paceStatus, compactTransactions } = require('../lib/forecast-math.js');

const $ = (d) => Math.round(d * 10000); // dollars → scale 4
const day = (s) => Date.UTC(...s.split('-').map((n, i) => (i === 1 ? n - 1 : +n))) / 1000; // UTC midnight epoch
const tx = (date, amt, bucket, pending = 0) => ['acct', day(date), $(amt), pending, bucket];

test('monthInfo and addMonths', () => {
  const mi = monthInfo('2026-10-18');
  assert.deepEqual([mi.ym, mi.day, mi.daysInMonth, mi.daysLeft], ['2026-10', 18, 31, 13]);
  assert.equal(addMonths('2026-01', -1), '2025-12');
  assert.equal(addMonths('2026-11', 2), '2027-01');
});

test('splits, pending and future-dated transactions', () => {
  const rows = [
    tx('2026-10-02', -30, { a: $(20), b: $(10) }),
    tx('2026-10-03', 5, 'a'), // refund
    tx('2026-10-04', -7, 'a', 1), // pending
    tx('2026-10-25', -100, 'a'), // future
  ];
  assert.deepEqual(bucketActivity(rows, '2026-10-18'), { a: { '2026-10': $(-22) }, b: { '2026-10': $(-10) } });
  assert.deepEqual(bucketActivity(rows, '2026-10-18', { includePending: false }).a, { '2026-10': $(-15) });
});

// October 2026 numbers from the Liquid Budget screen, as of Oct 18.
const groceries = { id: 'g', name: 'Food & Groceries', categoryId: 'flex', assignments: [{ amount: $(462.48), year: 2026, month: 10 }] };
const coffee = { id: 'c', name: 'Restaurants & Coffee', categoryId: 'flex', assignments: [{ amount: $(299.32), year: 2026, month: 10 }, { amount: $(0.68), year: 2026, month: 9 }] };
const rows = [
  tx('2026-09-12', -0.68, 'c'),
  tx('2026-09-20', 0.68, 'c'),
  tx('2026-10-01', -150, 'g'), tx('2026-10-09', -146.79, 'g'), tx('2026-10-16', -100, 'g'),
  tx('2026-10-05', -34.36, 'c'),
];

test('groceries: runs out around Oct 21', () => {
  const mi = monthInfo('2026-10-18');
  const r = forecastBucket(groceries, bucketActivity(rows, mi.today), mi);
  assert.equal(r.spent, $(396.79));
  assert.equal(r.available, $(65.69));
  assert.equal(Math.round(r.dailyBurn / 100), 2204); // $22.04/day
  assert.equal(Math.round(r.projected / 10000), 683);
  assert.equal(r.lastsDays.toFixed(1), '3.0');
  assert.equal(r.runsOutOn, '2026-10-21');
  assert.equal(Math.round(r.safePerDay / 100), 505); // $5.05/day
  assert.equal(r.status, 'risk');
});

test('restaurants: on pace, carries over September', () => {
  const mi = monthInfo('2026-10-18');
  const r = forecastBucket(coffee, bucketActivity(rows, mi.today), mi);
  assert.equal(r.available, $(265.64));
  assert.equal(r.runsOutOn, null);
  assert.equal(r.status, 'ok');
  assert.equal(Math.round(r.safePerDay / 100), 2043);
});

test('3-month average uses previous full months only', () => {
  const b = { id: 'x', assignments: [] };
  const act = { x: { '2026-07': $(-90), '2026-08': $(-60), '2026-09': $(-30), '2026-10': $(-500), '2026-06': $(-999) } };
  assert.equal(forecastBucket(b, act, monthInfo('2026-10-18')).avg3, $(60));
});

test('paceStatus', () => {
  assert.equal(paceStatus({ spent: 0, available: 0, spendable: 0, projected: 0 }), 'idle');
  assert.equal(paceStatus({ spent: 10, available: 0, spendable: 10, projected: 20 }), 'done');
  assert.equal(paceStatus({ spent: 10, available: -1, spendable: 9, projected: 20 }), 'over');
  assert.equal(paceStatus({ spent: 50, available: 50, spendable: 100, projected: 105 }), 'watch');
});

test('buildForecast groups by category and skips archived', () => {
  const f = buildForecast({
    categories: [{ id: 'flex', name: 'Flexy' }],
    buckets: [groceries, coffee, { id: 'z', name: 'Old', categoryId: 'flex', archived: true }, { id: 'o', name: 'Loose', categoryId: 'gone' }],
    rows,
    today: '2026-10-18',
  });
  assert.deepEqual(f.groups.map((g) => [g.name, g.rows.length]), [['Flexy', 2], ['Other', 1]]);
  assert.equal(f.groups[0].totals.spent, $(431.15));
});

test('bills are not projected forward; steady spending is', () => {
  const mi = monthInfo('2026-10-18');
  const elec = { id: 'e', name: 'Electric', assignments: [[7, 230], [8, 250], [9, 190], [10, 300]].map(([month, d]) => ({ amount: $(d), year: 2026, month })) };
  const r = [
    tx('2026-07-07', -230, 'e'), tx('2026-08-07', -250, 'e'), tx('2026-09-07', -190, 'e'),
    tx('2026-10-07', -260.60, 'e'),
    ...rows,
  ];
  const counts = bucketOutflowCounts(r, mi.today);
  assert.equal(isSteady(counts.e, mi.ym), false);
  assert.equal(isSteady(counts.g, mi.ym), true); // 3 trips this month
  const e = forecastBucket(elec, bucketActivity(r, mi.today), mi, counts);
  assert.equal(e.kind, 'bill');
  assert.equal(e.projected, $(260.60));
  assert.equal(e.runsOutOn, null);
  assert.equal(e.status, 'billed');
  const g = forecastBucket(groceries, bucketActivity(r, mi.today), mi, counts);
  assert.equal(g.status, 'risk');
});

test('an emptied steady envelope projects to what was spent', () => {
  const mi = monthInfo('2026-10-18');
  const b = { id: 's', assignments: [{ amount: $(50), year: 2026, month: 10 }] };
  const r = [tx('2026-10-03', -20, 's'), tx('2026-10-09', -30, 's')];
  const f = forecastBucket(b, bucketActivity(r, mi.today), mi, bucketOutflowCounts(r, mi.today));
  assert.equal(f.projected, $(50));
  assert.equal(f.status, 'done');
});

test('compactTransactions keeps bucket and split info', () => {
  const rows = compactTransactions([
    { accountId: 'a', dateEpoch: 10, amount: -5, status: 'PENDING', bucketId: 'g' },
    { accountId: 'a', dateEpoch: 11, amount: -9, status: 'CLEARED', bucketSplit: { allocations: { g: 4, c: 5 } } },
    { accountId: 'a', dateEpoch: 12, amount: 100, status: 'CLEARED', type: 'TRANSFER', payee: 'Savings' },
    { dateEpoch: 13, amount: 1 },
  ]);
  assert.deepEqual(rows, [['a', 10, -5, 1, 'g', '', 'T'], ['a', 11, -9, 0, { g: 4, c: 5 }, '', 'T'], ['a', 12, 100, 0, null, 'Savings', 'X']]);
});
