// Run with: node --test tests/*.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
require('../lib/forecast-math.js');
const { suggestQuickAssign, quickAssignInfo, niceUp } = require('../lib/quickassign-math.js');

const $ = (d) => Math.round(d * 10000);
const day = (s) => Date.UTC(...s.split('-').map((n, i) => (i === 1 ? n - 1 : +n))) / 1000;
const tx = (date, amt, bucket) => ['acct', day(date), $(amt), 0, bucket, '', 'T'];
const pad = (n) => String(n).padStart(2, '0');
// Months Oct 2025 … Sep 2026 (the 12 before October 2026).
const MONTHS = Array.from({ length: 12 }, (_, i) => { const k = 2025 * 12 + 9 + i; return [Math.floor(k / 12), (k % 12) + 1]; });
const everyMonth = (amt) => MONTHS.map(([y, m]) => ({ amount: $(amt), year: y, month: m }));
const spendEach = (bucket, amts) => MONTHS.map(([y, m], i) => tx(`${y}-${pad(m)}-10`, -amts[i % amts.length], bucket));
const FIXED = (amt, extra) => ({ type: 'FIXED', amount: $(amt), recurrenceMonths: 0, topOff: false, disabled: false, ...extra });

const today = '2026-10-19';

test('tidy rounding', () => {
  assert.equal(niceUp($(238.62)), $(240));
  assert.equal(niceUp($(47)), $(50));
  assert.equal(niceUp($(669)), $(675));
  assert.equal(niceUp($(2510)), $(2550));
  assert.equal(niceUp($(240)), $(240));
});

test('quick assign kinds', () => {
  assert.equal(quickAssignInfo(null).kind, 'none');
  assert.equal(quickAssignInfo(FIXED(50, { disabled: true })).kind, 'none');
  assert.equal(quickAssignInfo(FIXED(50, { topOff: true })).kind, 'refill');
  assert.equal(quickAssignInfo({ type: 'TARGET', amount: $(1200), recurrenceMonths: 0 }).kind, 'target');
  assert.deepEqual(quickAssignInfo({ type: 'TARGET', amount: $(1200), recurrenceMonths: 12 }), { kind: 'recurring', monthly: $(100), every: 12 });
});

test('raise, lower, set; savings and refills left alone', () => {
  const buckets = [
    { id: 'sun', name: 'Sundries', quickAssign: FIXED(50), assignments: everyMonth(239) }, // topped up by hand
    { id: 'rest', name: 'Restaurants', quickAssign: FIXED(300), assignments: everyMonth(300) }, // spends ~$187
    { id: 'save', name: 'Reserves', quickAssign: FIXED(1000), assignments: everyMonth(1000) }, // savings: never spent
    { id: 'top', name: 'Groceries', quickAssign: FIXED(800, { topOff: true }), assignments: everyMonth(400) }, // refill, under
    { id: 'gas', name: 'Gas', quickAssign: null, assignments: everyMonth(120) }, // no quick assign
    { id: 'ok', name: 'Phone', quickAssign: FIXED(47), assignments: everyMonth(47) }, // right on
  ];
  const rows = [
    ...spendEach('sun', [239]),
    ...spendEach('rest', [180, 194]),
    ...spendEach('top', [400]),
    ...spendEach('gas', [118]),
    ...spendEach('ok', [46.5]),
  ];
  const r = suggestQuickAssign({ buckets, rows, today, months: 12 });
  const by = Object.fromEntries(r.suggestions.map((s) => [s.id, s]));
  assert.deepEqual(r.suggestions.map((s) => s.id), ['sun', 'gas', 'rest']);
  assert.equal(by.sun.action, 'raise');
  assert.equal(by.sun.suggested, $(240));
  assert.equal(by.sun.activeMonths, 12);
  assert.equal(by.sun.ranOut, 0); // assignments covered it
  assert.equal(by.gas.action, 'set');
  assert.equal(by.gas.suggested, $(120));
  assert.equal(by.rest.action, 'lower');
  assert.equal(by.rest.suggested, $(190));
  assert.equal(r.months.length, 12);
  assert.equal(r.months[0], '2025-10');
});

test('lumpy bills use the monthly average; short history is cut back or skipped', () => {
  const buckets = [
    { id: 'tu', name: 'Tuition', quickAssign: FIXED(300), assignments: everyMonth(300) },
    { id: 'new', name: 'New one', quickAssign: FIXED(10), assignments: [{ amount: $(10), year: 2026, month: 8 }] },
  ];
  const rows = [tx('2026-01-05', -4400, 'tu'), tx('2026-08-05', -4400, 'tu'), tx('2026-08-07', -500, 'new'), tx('2026-09-07', -500, 'new')];
  const r = suggestQuickAssign({ buckets, rows, today, months: 12 });
  assert.deepEqual(r.suggestions.map((s) => s.id), ['tu']);
  assert.equal(r.suggestions[0].action, 'raise');
  assert.equal(r.suggestions[0].suggested, $(750)); // $8,800 / 12 = $733 → $750
  assert.ok(r.suggestions[0].ranOut >= 1);
  const six = suggestQuickAssign({ buckets, rows, today, months: 6 });
  assert.equal(six.suggestions[0].n, 6);
  assert.equal(six.suggestions[0].suggested, $(750)); // only August in window: $4,400 / 6 = $733
});

test('refunds in later months offset spending; a $0 quick assign counts as none', () => {
  const buckets = [
    { id: 'wt', name: 'Work Travel', quickAssign: FIXED(0), assignments: everyMonth(0) },
    { id: 'gift', name: 'Gifts', quickAssign: FIXED(50), assignments: everyMonth(50) },
  ];
  const rows = [
    tx('2026-03-05', -900, 'wt'), tx('2026-04-05', 900, 'wt'), tx('2026-06-05', -600, 'wt'), tx('2026-07-05', 600, 'wt'),
    ...spendEach('gift', [150]), tx('2026-09-20', 600, 'gift'),
  ];
  const r = suggestQuickAssign({ buckets, rows, today, months: 12 });
  assert.deepEqual(r.suggestions.map((s) => s.id), ['gift']);
  assert.equal(r.suggestions[0].avgSpend, $(100)); // ($1,800 − $600) / 12
});

test('month funding: fixed, top-off, target, snoozed', () => {
  const { monthNeed, monthFunding } = require('../lib/quickassign-math.js');
  const A = (amt, y, m) => ({ amount: $(amt), year: y, month: m });
  const buckets = [
    { id: 'res', quickAssign: FIXED(1000), assignments: [A(11000, 2026, 9)] },
    { id: 'food', quickAssign: FIXED(500, { topOff: true }), assignments: [A(462.48, 2026, 10)] },
    { id: 'trip', quickAssign: { type: 'TARGET', amount: $(1500), target: '2027-04-30', recurrenceMonths: 0, snoozedUntil: '2026-11-01' }, assignments: [A(170.24, 2026, 10), A(50, 2026, 11)] },
    { id: 'zz', quickAssign: FIXED(75, { snoozedUntil: '2027-01-01' }), assignments: [] },
    { id: 'none', quickAssign: null, assignments: [A(10, 2026, 11)] },
  ];
  const activity = { food: { '2026-10': -$(396.79) } };
  assert.equal(monthNeed(buckets[0], {}, '2026-11'), $(1000));
  assert.equal(monthNeed(buckets[1], activity.food, '2026-11'), $(500 - 65.69));
  assert.equal(monthNeed(buckets[2], {}, '2026-11'), Math.round($(1500 - 170.24) / 6)); // Nov … Apr
  assert.equal(monthNeed(buckets[2], {}, '2026-10'), 0); // snoozed
  assert.equal(monthNeed(buckets[3], {}, '2026-12'), 0);
  assert.equal(monthNeed(buckets[3], {}, '2027-01'), $(75));
  const f = monthFunding(buckets, activity, '2026-11');
  assert.equal(f.need, $(1000) + $(434.31) + Math.round($(1329.76) / 6));
  assert.equal(f.funded, $(50));
  assert.ok(Math.abs(f.pct - $(50) / f.need) < 1e-12);
  assert.equal(monthFunding([], {}, '2026-11').pct, null);
});
