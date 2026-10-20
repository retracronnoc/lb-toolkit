// Run with: node --test tests/*.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildCashFlow } = require('../lib/cashflow-math.js');

const $ = (d) => Math.round(d * 10000);
const day = (s) => Date.UTC(...s.split('-').map((n, i) => (i === 1 ? n - 1 : +n))) / 1000;
const T = (date, amt, extra = {}) => ({ accountId: 'chk', dateEpoch: day(date), amount: $(amt), type: 'TRANSACTION', status: 'RECONCILED', ...extra });
const accounts = [{ id: 'chk', type: 'CHECKING' }, { id: 'hsa', type: 'OFF_BUDGET_ASSET' }];
const categories = [{ id: 'flex', name: 'Flexy' }, { id: 'fixed', name: 'Fixed' }];
const buckets = [{ id: 'g', name: 'Groceries', categoryId: 'flex' }, { id: 'm', name: 'Mortgage', categoryId: 'fixed' }, { id: 'u', name: 'Water', categoryId: 'fixed' }];

const tx = [
  T('2026-10-01', 2000, { payee: 'Bonus' }),
  T('2026-10-29', 14000, { payee: 'Salary', status: 'PENDING' }),
  T('2026-10-05', -150, { bucketId: 'g' }),
  T('2026-10-06', 20, { bucketId: 'g' }), // refund
  T('2026-10-01', -4243.14, { bucketId: 'm', type: 'TRANSFER' }), // bucketed transfer counts
  T('2026-10-21', -134.98, { bucketId: 'u' }), // scheduled
  T('2026-10-10', -60, { payee: 'Cash', status: 'PENDING' }), // unassigned, pending
  T('2026-10-30', -500, { type: 'TRANSFER' }), // unbucketed transfer: out
  T('2026-10-31', 645.83, { accountId: 'hsa', payee: 'HSA' }), // off budget: out
  T('2026-11-02', -50, { bucketId: 'g' }), // other month: out
];

test('flows, splits and what is left out', () => {
  const f = buildCashFlow({ transactions: tx, accounts, buckets, categories, ym: '2026-10', today: '2026-10-19' });
  assert.deepEqual(f.sources.map((s) => [s.name, s.now / 1e4, s.up / 1e4]), [['Salary', 0, 14000], ['Bonus', 2000, 0], ['Refunds & credits', 20, 0]]);
  assert.deepEqual(f.categories.map((c) => [c.name, c.now / 1e4, Math.round(c.up) / 1e4]), [['Fixed', 4243.14, 134.98], ['Flexy', 150, 0], ['Unassigned spending', 0, 60]]);
  assert.equal(f.inflow, $(16020));
  assert.equal(f.outflow, $(4588.12));
  assert.equal(f.leftover, $(16020 - 4588.12));
  assert.equal(f.drawdown, 0);
});

test('folds small categories and buckets', () => {
  const many = [];
  const bs = [];
  const cs = [];
  for (let i = 0; i < 10; i++) {
    cs.push({ id: 'c' + i, name: 'Cat ' + i });
    for (let j = 0; j < 6; j++) {
      bs.push({ id: `b${i}_${j}`, name: `B${i}.${j}`, categoryId: 'c' + i });
      many.push(T('2026-10-03', -(100 - i * 5 - j), { bucketId: `b${i}_${j}` }));
    }
  }
  const f = buildCashFlow({ transactions: many, accounts, buckets: bs, categories: cs, ym: '2026-10', today: '2026-10-19', minShare: 0.01 });
  assert.equal(buildCashFlow({ transactions: many, accounts, buckets: bs, categories: cs, ym: '2026-10', today: '2026-10-19' }).categories[0].buckets[0].name, 'Cat 0 (6 buckets)');
  assert.equal(f.categories.length, 8);
  assert.equal(f.categories[7].name, 'Other categories');
  assert.equal(f.categories[0].buckets.length <= 4, true);
  assert.equal(f.categories[0].buckets.at(-1).name, 'Other in Cat 0');
  assert.equal(f.drawdown, f.outflow);
});
