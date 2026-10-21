// Run with: node --test tests/*.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
require('../lib/forecast-math.js');
const R = require('../lib/retire-math.js');

const $ = (d) => Math.round(d * 10000);
const day = (s) => Date.UTC(...s.split('-').map((n, i) => (i === 1 ? n - 1 : +n))) / 1000;
const today = '2026-10-20';

test('balances by group, ungrouped last, future-dated left out', () => {
  const accounts = [
    { id: 'chk', name: 'Checking', type: 'CHECKING', accountGroup: 'Liquid' },
    { id: 'misc', name: 'Cash', type: 'CASH', accountGroup: null },
    { id: 'cc', name: 'Visa', type: 'CREDIT_CARD', accountGroup: 'Credit Cards' },
    { id: 'ira', name: 'IRA', type: 'OFF_BUDGET_ASSET', accountGroup: 'Retirement' },
    { id: 'home', name: 'Home', type: 'OFF_BUDGET_ASSET', accountGroup: 'Property' },
    { id: 'mort', name: 'Mortgage', type: 'OFF_BUDGET_LIABILITY', accountGroup: 'Property' },
    { id: 'car', name: 'Car', type: 'OFF_BUDGET_ASSET', accountGroup: 'Vehicles' },
  ];
  const tx = [
    { accountId: 'chk', dateEpoch: day('2026-10-01'), amount: $(5000) },
    { accountId: 'chk', dateEpoch: day('2026-10-25'), amount: $(-1000) }, // future
    { accountId: 'cc', dateEpoch: day('2026-10-10'), amount: $(-800), status: 'PENDING' },
    { accountId: 'ira', dateEpoch: day('2026-01-01'), amount: $(400000) },
    { accountId: 'home', dateEpoch: day('2026-01-01'), amount: $(600000) },
    { accountId: 'mort', dateEpoch: day('2026-01-01'), amount: $(-500000) },
    { accountId: 'misc', dateEpoch: day('2026-01-01'), amount: $(20) },
  ];
  const b = R.accountBalances(accounts, tx, today);
  assert.deepEqual(b.groups.map((g) => [g.name, g.total]), [['Liquid', $(5000)], ['Credit Cards', $(-800)], ['Retirement', $(400000)], ['Property', $(100000)], ['Vehicles', 0], [R.NO_GROUP, $(20)]]);
  assert.deepEqual(R.defaultGroups(b.groups), ['Liquid', 'Credit Cards', 'Retirement', R.NO_GROUP]);
});

test('yearly flows: last full months, savings categories skipped, short history annualized', () => {
  const buckets = [{ id: 'food', categoryId: 'flex' }, { id: 'inv', categoryId: 'vault' }];
  const cats = [{ id: 'flex', name: 'Flexy' }, { id: 'vault', name: '🏦 THE VAULT' }];
  assert.deepEqual(R.defaultSkipCategories(cats), ['vault']);
  const rows = [];
  for (let m = 4; m <= 9; m++) {
    const mm = String(m).padStart(2, '0');
    rows.push(['chk', day(`2026-${mm}-05`), $(-500), 0, 'food', 'Kroger', 'T']);
    rows.push(['chk', day(`2026-${mm}-06`), $(-1000), 0, 'inv', '', 'X']); // to brokerage
    rows.push(['chk', day(`2026-${mm}-15`), $(6000), 0, null, 'Salary', 'T']);
  }
  rows.push(['chk', day('2026-10-02'), $(-9999), 0, 'food', '', 'T']); // this month: left out
  rows.push(['hsa', day('2026-06-01'), $(300), 0, null, 'HSA', 'T']); // off-budget: left out
  const f = R.yearlyFlows({ rows, buckets, today, months: 12, offBudgetAccounts: ['hsa'], skipCats: ['vault'] });
  assert.equal(f.months, 6); // history starts in April
  assert.equal(f.from, '2026-04');
  assert.equal(f.spending, $(6000)); // $500 × 12
  assert.equal(f.income, $(72000));
  const all = R.yearlyFlows({ rows, buckets, today, months: 12, offBudgetAccounts: ['hsa'] });
  assert.equal(all.spending, $(18000));
});

test('horizon: 25x, safe withdrawal, years to FI', () => {
  const h = R.horizon({ invested: $(1000000), spending: $(60000), saving: $(30000), rate: 0.04, growth: 0.05 });
  assert.equal(h.fiNumber, $(1500000));
  assert.equal(h.multiple, 25);
  assert.equal(h.safeYearly, $(40000));
  assert.equal(h.safeMonthly, Math.round($(40000) / 12));
  assert.ok(Math.abs(h.progress - 2 / 3) < 1e-9);
  // 1.0M·1.05^n + 30k·(1.05^n − 1)/0.05 = 1.5M → 1.05^n = 2.1/1.6
  assert.ok(Math.abs(h.years - Math.log(2.1 / 1.6) / Math.log(1.05)) < 1e-9);
  assert.ok(Math.abs(h.coastYears - Math.log(1.5) / Math.log(1.05)) < 1e-9);
  const h3 = R.horizon({ invested: $(1000000), spending: $(60000), saving: 0, rate: 0.03, growth: 0 });
  assert.equal(h3.fiNumber, $(2000000));
  assert.equal(h3.years, null); // no growth, no saving: never
  assert.equal(R.horizon({ invested: $(2000000), spending: $(60000), saving: 0 }).years, 0);
  assert.equal(R.yearsTo($(100), $(-50), 0.05, $(1000)), null); // drawing down
});

test('a custom FI multiple overrides 1 ÷ rate but not the safe withdrawal', () => {
  const h = R.horizon({ invested: $(1000000), spending: $(60000), saving: 0, rate: 0.04, growth: 0.05, multiple: 30 });
  assert.equal(h.fiNumber, $(1800000));
  assert.equal(h.multiple, 30);
  assert.equal(h.customMultiple, true);
  assert.equal(h.safeYearly, $(40000));
  assert.equal(R.horizon({ invested: 0, spending: $(60000), saving: 0, multiple: null }).fiNumber, $(1500000));
});

test('runway: how long the money lasts if you stopped today', () => {
  const flat = R.runway({ invested: $(600000), spending: $(60000), growth: 0 });
  assert.equal(flat.years, 10);
  assert.equal(flat.days, 3652);
  assert.equal(flat.grownYears, 10);
  const grown = R.runway({ invested: $(600000), spending: $(60000), growth: 0.05 });
  assert.ok(Math.abs(grown.grownYears - Math.log(60000 / 30000) / Math.log(1.05)) < 1e-9); // ≈ 14.2 yrs
  assert.equal(R.runway({ invested: $(2000000), spending: $(60000), growth: 0.05 }).grownYears, null); // growth covers it
  assert.equal(R.runway({ invested: $(100), spending: 0 }).days, null);
  assert.equal(R.runway({ invested: -$(5), spending: $(100) }).days, 0);
});
