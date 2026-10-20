// Toolkit for Liquid Budget — Cash Flow (Sankey) math.
// Works on the app's raw lists (transactions, accounts, buckets, categories)
// for one month, counting every transaction in it: cleared, pending and
// scheduled (dated after today). Money stays in scale-4 integers.
//
// Flows, matching how Reports counts inflow and outflow:
//   income sources → Budget → categories → buckets
// - Income: unbucketed TRANSACTIONs with a positive amount, by payee.
// - Refunds & credits: money coming back into buckets (positive bucket shares).
// - Spending: money out of buckets (negative bucket shares, bucketed transfers
//   such as mortgage or loan payments included), by category and bucket.
// - Unassigned spending: unbucketed TRANSACTIONs with a negative amount.
// Left out: off-budget accounts, and transfers / adjustments without a bucket.
// Each flow is split into `now` (cleared, dated up to today) and `up`
// (pending, or dated after today).
(function (root) {
'use strict';

const pad = (n) => String(n).padStart(2, '0');
const localDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
function txDate(epoch) {
  const d = new Date(epoch * 1000);
  if (epoch % 86400 === 0) return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  return localDate(d);
}

function shares(t) {
  const alloc = t.bucketSplit && t.bucketSplit.allocations;
  if (alloc && typeof alloc === 'object' && Object.keys(alloc).length) {
    const sign = t.amount < 0 ? -1 : 1;
    return Object.entries(alloc).map(([id, part]) => [id, sign * Math.abs(part)]);
  }
  return t.bucketId ? [[t.bucketId, t.amount]] : [];
}

const flow = (name, extra) => ({ name, now: 0, up: 0, ...extra });
const total = (f) => f.now + f.up;
const add = (f, amt, isUp) => { if (isUp) f.up += amt; else f.now += amt; };

/**
 * buildCashFlow({ transactions, accounts, buckets, categories, ym, today, maxSources, maxCategories, maxBuckets })
 * → { ym, sources, categories, inflow, outflow, leftover, drawdown, count }
 *   sources:    [{ name, now, up, kind: 'income'|'refund'|'other' }]
 *   categories: [{ id, name, now, up, buckets: [{ name, now, up }] }]   (biggest first; the rest folded into "Other categories")
 *   leftover:   amount left over (inflow > outflow), else 0
 *   drawdown:   amount spent from existing balances (outflow > inflow), else 0
 */
function buildCashFlow({ transactions, accounts, buckets, categories, ym, today, maxSources = 6, maxCategories = 7, maxBuckets = 4, minShare = 0.03 }) {
  const off = new Set((accounts || []).filter((a) => a && /^OFF_BUDGET/i.test(String(a.type || ''))).map((a) => a.id));
  const bucketById = new Map((buckets || []).map((b) => [b.id, b]));
  const catName = new Map((categories || []).map((c) => [c.id, c.name]));

  const income = new Map(); // payee -> flow
  const refunds = flow('Refunds & credits', { kind: 'refund' });
  const cats = new Map(); // category id -> { flow, buckets: Map(bucketId -> flow) }
  let count = 0;

  const catFlow = (id, name) => {
    if (!cats.has(id)) cats.set(id, { f: flow(name, { id }), buckets: new Map() });
    return cats.get(id);
  };

  for (const t of transactions || []) {
    if (!t || typeof t.amount !== 'number' || !t.dateEpoch || off.has(t.accountId)) continue;
    const date = txDate(t.dateEpoch);
    if (date.slice(0, 7) !== ym) continue;
    const isUp = date > today || t.status === 'PENDING';
    const parts = shares(t);
    if (parts.length) {
      for (const [id, amt] of parts) {
        if (amt > 0) { add(refunds, amt, isUp); continue; }
        if (amt === 0) continue;
        const b = bucketById.get(id);
        const cid = b && b.categoryId ? b.categoryId : '__none';
        const c = catFlow(cid, catName.get(cid) || 'Other');
        add(c.f, -amt, isUp);
        const bname = b ? b.name : 'Unknown bucket';
        if (!c.buckets.has(id)) c.buckets.set(id, flow(bname));
        add(c.buckets.get(id), -amt, isUp);
      }
      count++;
    } else if (t.type !== 'TRANSFER' && t.type !== 'ADJUSTMENT') {
      if (t.amount > 0) {
        const payee = String(t.payee || '').trim() || 'Other income';
        if (!income.has(payee)) income.set(payee, flow(payee, { kind: 'income' }));
        add(income.get(payee), t.amount, isUp);
      } else if (t.amount < 0) {
        const c = catFlow('__unassigned', 'Unassigned spending');
        add(c.f, -t.amount, isUp);
        if (!c.buckets.has('__u')) c.buckets.set('__u', flow('No bucket'));
        add(c.buckets.get('__u'), -t.amount, isUp);
      }
      count++;
    }
  }

  // Income: the biggest payees, the rest folded together.
  const inc = [...income.values()].sort((a, b) => total(b) - total(a));
  const sources = inc.slice(0, maxSources);
  if (inc.length > maxSources) {
    const rest = flow('Other income', { kind: 'other' });
    for (const f of inc.slice(maxSources)) { rest.now += f.now; rest.up += f.up; }
    sources.push(rest);
  }
  if (total(refunds) > 0) sources.push(refunds);

  // Categories: the biggest ones in color, the rest folded into "Other categories".
  const all = [...cats.values()]
    .map(({ f, buckets: bs }) => ({ ...f, buckets: [...bs.values()].sort((a, b) => total(b) - total(a)) }))
    .filter((c) => total(c) > 0)
    .sort((a, b) => total(b) - total(a));
  const shown = all.slice(0, maxCategories);
  if (all.length > maxCategories) {
    const rest = flow('Other categories', { id: '__other', buckets: [] });
    for (const c of all.slice(maxCategories)) {
      rest.now += c.now;
      rest.up += c.up;
      rest.buckets.push(flow(c.name, { now: c.now, up: c.up }));
    }
    rest.buckets.sort((a, b) => total(b) - total(a));
    shown.push(rest);
  }
  const inflow = sources.reduce((s, f) => s + total(f), 0);
  const outflow = shown.reduce((s, c) => s + total(c), 0);

  // Each category shows up to `maxBuckets` of its buckets that are at least
  // `minShare` of all spending; the rest are folded into one node.
  for (const c of shown) {
    const big = c.buckets.filter((b) => total(b) >= outflow * minShare).slice(0, c.buckets.length > maxBuckets ? maxBuckets - 1 : maxBuckets);
    const small = c.buckets.filter((b) => !big.includes(b));
    if (small.length <= 1) continue; // nothing to fold (a single small bucket keeps its name)
    const rest = flow(big.length ? `Other in ${c.name}` : `${c.name} (${small.length} bucket${small.length === 1 ? '' : 's'})`);
    for (const b of small) { rest.now += b.now; rest.up += b.up; }
    c.buckets = [...big, rest];
  }
  return {
    ym,
    sources,
    categories: shown,
    inflow,
    outflow,
    inflowUp: sources.reduce((s, f) => s + f.up, 0),
    outflowUp: shown.reduce((s, c) => s + c.up, 0),
    leftover: Math.max(0, inflow - outflow),
    drawdown: Math.max(0, outflow - inflow),
    count,
  };
}

const api = { buildCashFlow, txDate };
root.LBTCashFlow = api;
if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
