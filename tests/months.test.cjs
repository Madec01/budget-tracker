'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const E = require('../dist/engine.js');
const M = require('../dist/months.js');
const rules = () => ({ threshold: 500, savingPct: 80, rPct: 70, caPct: 0, tPct: 30 });
const budget = () => [
  { id: 'ca', name: 'CA', category: 'Fixes', account: 'ca', amount: 1700, enabled: true },
  { id: 'r', name: 'Revolut', category: 'Loisirs', account: 'r', amount: 700, enabled: true }
];
function month(key, overrides = {}) {
  return { key, prepared: true, closed: false, salary: 3000, openingCA: 400, openingR: 200,
    salaryIncluded: false, savingsOpening: 1000, budget: budget(), rules: rules(),
    budgetConfirmed: true, useBuffer: false, done: { r: false, savings: false }, ...overrides };
}
function state(months = []) {
  return { selectedMonth: '2026-02', plans: [{ from: '1900-01', confirmed: true, budget: budget(), rules: rules() }],
    months: Object.fromEntries(months.map(m => [m.key, m])) };
}
const linked = (key, extra = {}) => month(key, { carry: { buffer: true, savings: true }, ...extra });
const checkInvalid = fn => assert.throws(fn, e => e.code === 'BUDGET_MONTHS_INVALID' && /Report mensuel impossible/.test(e.message));

test('no prepared predecessor means no carry and no invented balance', () => {
  const s = state([month('2026-01', { prepared: false, salary: 5000 })]);
  assert.equal(M.reportFor(s, '2026-02'), null);
  const next = M.getMonth(s, '2026-02');
  assert.equal(next.salary, 0);
  assert.equal(next.openingCA, 0);
  assert.equal(next.savingsOpening, 0);
  assert.deepEqual(next.carry, { buffer: false, savings: false });
});

test('an open predecessor reports projected savings and buffer without requiring closure', () => {
  const s = state([month('2026-01')]);
  assert.deepEqual(M.reportFor(s, '2026-02'), {
    sourceKey: '2026-01', sourceClosed: false, skipped: 0,
    openingCA: 636, openingR: 0, savingsOpening: 1480, bufferTotal: 636, provisional: true
  });
  const next = M.getMonth(s, '2026-02');
  assert.equal(next.salary, 3000);
  assert.equal(next.openingCA, 636);
  assert.equal(next.savingsOpening, 1480);
  assert.equal(next.salaryIncluded, false);
  assert.deepEqual(next.carry, { buffer: true, savings: true });
});

test('linked prepared months form a live chain without adding the same reserve twice', () => {
  const s = state([month('2026-01'), linked('2026-02'), linked('2026-03')]);
  const feb = M.getMonth(s, '2026-02');
  const mar = M.getMonth(s, '2026-03');
  const apr = M.getMonth(s, '2026-04');
  assert.equal(feb.openingCA, 636);
  assert.equal(mar.openingCA, 672);
  assert.equal(apr.openingCA, 708);
  assert.equal(feb.savingsOpening, 1480);
  assert.equal(mar.savingsOpening, 1960);
  assert.equal(apr.savingsOpening, 2440);
  assert.equal(E.calculate(mar).savingsProjected, 2440);
  assert.equal(M.validateReports(s), true);
});

test('correcting a source recalculates all linked descendants on the next read', () => {
  const s = state([month('2026-01'), linked('2026-02'), linked('2026-03')]);
  assert.equal(M.getMonth(s, '2026-03').savingsOpening, 1960);
  s.months['2026-01'].salary = 3200;
  assert.equal(M.getMonth(s, '2026-02').savingsOpening, 1640);
  assert.equal(M.getMonth(s, '2026-03').savingsOpening, 2120);
  assert.equal(M.getMonth(s, '2026-03').openingCA, 684);
});

test('closing a source replaces its projection with real balances throughout the chain', () => {
  const s = state([month('2026-01'), linked('2026-02'), linked('2026-03')]);
  s.months['2026-01'].closed = true;
  s.months['2026-01'].closing = { closingCA: 500, closingR: 20, savingsActual: 1300 };
  const direct = M.reportFor(s, '2026-02');
  assert.equal(direct.provisional, false);
  assert.equal(direct.sourceClosed, true);
  assert.equal(direct.openingCA, 500);
  assert.equal(direct.openingR, 20);
  assert.equal(direct.savingsOpening, 1300);
  const mar = M.getMonth(s, '2026-03');
  assert.equal(mar.openingCA, 556);
  assert.equal(mar.savingsOpening, 1780);
  assert.equal(M.reportFor(s, '2026-03').provisional, true);
});

test('closed targets remain frozen even when they previously had automatic carry', () => {
  const closed = linked('2026-02', { closed: true, closing: { closingCA: 80, closingR: 20, savingsActual: 2000 } });
  const s = state([month('2026-01'), closed]);
  s.months['2026-01'].salary = 9000;
  assert.equal(M.getMonth(s, '2026-02'), closed);
  assert.equal(closed.openingCA, 400);
  assert.equal(M.getMonth(s, '2026-03').openingCA, 80);
  assert.equal(M.getMonth(s, '2026-03').savingsOpening, 2000);
});

test('a zero unconfirmed budget carries only normalized opening balances and existing savings', () => {
  const incomplete = month('2026-01', { budget: [], budgetConfirmed: false,
    openingCA: 3400, openingR: 200, salaryIncluded: true });
  const s = state([incomplete]);
  assert.deepEqual(M.reportFor(s, '2026-02'), {
    sourceKey: '2026-01', sourceClosed: false, skipped: 0,
    openingCA: 400, openingR: 200, savingsOpening: 1000, bufferTotal: 600, provisional: true
  });
  delete incomplete.budgetConfirmed;
  assert.equal(M.reportFor(s, '2026-02').savingsOpening, 1000);
  incomplete.budgetConfirmed = true;
  assert.equal(M.reportFor(s, '2026-02').savingsOpening, 3400);
});

test('an unconfirmed intermediate month does not invent a salary contribution', () => {
  const s = state([month('2026-01'), linked('2026-02', { budget: [], budgetConfirmed: false })]);
  const next = M.reportFor(s, '2026-03');
  assert.equal(next.bufferTotal, 636);
  assert.equal(next.savingsOpening, 1480);
});

test('an unfunded source reports a signed negative buffer rather than hiding its deficit', () => {
  const s = state([month('2026-01', { salary: 2100, openingCA: 100, openingR: 0 })]);
  const report = M.reportFor(s, '2026-02');
  assert.equal(report.bufferTotal, -200);
  assert.equal(report.openingCA, -200);
  assert.equal(report.savingsOpening, 1000);
  s.months['2026-02'] = linked('2026-02');
  const next = E.calculate(M.getMonth(s, '2026-02'));
  assert.equal(next.effectiveRemainder, 400);
  assert.equal(next.savingsAdd, 400);
});

test('partial buffer financing and an opening overdraft retain the full uncovered liability', () => {
  const a = state([month('2026-01', { salary: 2100, openingCA: 100, openingR: 0, useBuffer: true })]);
  assert.equal(M.reportFor(a, '2026-02').bufferTotal, -200);
  const b = state([month('2026-01', { salary: 2400, openingCA: -150, openingR: 0 })]);
  assert.equal(M.reportFor(b, '2026-02').bufferTotal, -150);
});

test('gaps use the latest prepared predecessor without inventing missing monthly income', () => {
  const s = state([month('2026-01'), month('2026-03', { prepared: false })]);
  const report = M.reportFor(s, '2026-05');
  assert.equal(report.sourceKey, '2026-01');
  assert.equal(report.skipped, 3);
  assert.equal(report.savingsOpening, 1480);
  assert.equal(report.bufferTotal, 636);
  const acrossYear = M.reportFor(state([month('2025-12')]), '2026-02');
  assert.equal(acrossYear.skipped, 1);
});

test('prepared legacy and explicit manual months preserve every entered balance', () => {
  const legacy = month('2026-02', { openingCA: 900, savingsOpening: 3500, salaryIncluded: true });
  const s = state([month('2026-01'), legacy]);
  assert.equal(M.getMonth(s, '2026-02'), legacy);
  assert.equal(M.getMonth(s, '2026-02').savingsOpening, 3500);
  assert.equal(M.reportFor(s, '2026-02').savingsOpening, 1480);
  legacy.carry = { buffer: false, savings: false };
  assert.equal(M.getMonth(s, '2026-02'), legacy);
});

test('buffer and savings can be linked independently', () => {
  const s = state([month('2026-01'), month('2026-02', {
    openingCA: 3900, openingR: 300, savingsOpening: 5000, salaryIncluded: true,
    carry: { buffer: false, savings: true }
  })]);
  let target = M.getMonth(s, '2026-02');
  assert.equal(target.openingCA, 3900);
  assert.equal(target.openingR, 300);
  assert.equal(target.salaryIncluded, true);
  assert.equal(target.savingsOpening, 1480);
  s.months['2026-02'].carry = { buffer: true, savings: false };
  target = M.getMonth(s, '2026-02');
  assert.equal(target.openingCA, 636);
  assert.equal(target.openingR, 0);
  assert.equal(target.salaryIncluded, false);
  assert.equal(target.savingsOpening, 5000);
});

test('a budget-only stored month is linked automatically while retaining its own budget and rules', () => {
  const draft = month('2026-02', { prepared: false, budget: budget().map(b => ({ ...b, amount: 10 })),
    rules: { ...rules(), savingPct: 90 }, budgetConfirmed: false });
  const s = state([month('2026-01'), draft]);
  const resolved = M.getMonth(s, '2026-02');
  assert.equal(resolved.budget, draft.budget);
  assert.equal(resolved.rules, draft.rules);
  assert.equal(resolved.budgetConfirmed, false);
  assert.deepEqual(resolved.carry, { buffer: true, savings: true });
  assert.equal(resolved.openingCA, 636);
  assert.equal(resolved.savingsOpening, 1480);
});

test('new months select and clone the effective budget plan', () => {
  const s = state([month('2026-01')]);
  s.plans.push({ from: '2026-03', confirmed: false, budget: [], rules: { ...rules(), rPct: 90, tPct: 10 } });
  const feb = M.getMonth(s, '2026-02');
  const mar = M.getMonth(s, '2026-03');
  assert.equal(feb.budget.length, 2);
  assert.equal(feb.budgetConfirmed, true);
  assert.equal(mar.budget.length, 0);
  assert.equal(mar.budgetConfirmed, false);
  assert.equal(mar.rules.rPct, 90);
  feb.budget[0].amount = 1;
  feb.rules.savingPct = 1;
  assert.equal(s.plans[0].budget[0].amount, 1700);
  assert.equal(s.plans[0].rules.savingPct, 80);
});

test('all public reads leave deeply frozen input state unchanged', () => {
  const s = state([month('2026-01'), linked('2026-02')]);
  const before = JSON.stringify(s);
  function freeze(value) {
    if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  }
  freeze(s);
  assert.equal(M.getMonth(s, '2026-03').savingsOpening, 1960);
  assert.equal(M.reportFor(s, '2026-03').bufferTotal, 672);
  assert.equal(M.validateReports(s), true);
  assert.equal(JSON.stringify(s), before);
});

test('a long chronological chain is iterative and counts each salary exactly once', () => {
  const months = [];
  for (let i = 0; i < 1500; i += 1) {
    const key = `${1900 + Math.floor(i / 12)}-${String(i % 12 + 1).padStart(2, '0')}`;
    months.push(linked(key, { salary: 1, budget: [], budgetConfirmed: true,
      openingCA: 0, openingR: 0, savingsOpening: 0 }));
  }
  const s = state(months);
  assert.equal(M.reportFor(s, '2025-01').savingsOpening, 1500);
  assert.equal(M.validateReports(s), true);
});

test('malformed dates, carry flags, source amounts and closings fail explicitly', () => {
  checkInvalid(() => M.getMonth(state(), '2026-13'));
  checkInvalid(() => M.reportFor({}, '2026-02'));
  checkInvalid(() => M.reportFor(state([month('2026-01', { salary: NaN })]), '2026-02'));
  checkInvalid(() => M.reportFor(state([month('2026-01', { carry: { buffer: true } })]), '2026-02'));
  checkInvalid(() => M.reportFor(state([month('2026-01', { closed: true })]), '2026-02'));
  checkInvalid(() => M.validateReports(state([month('2026-01', { closed: true, prepared: false })])));
  checkInvalid(() => M.getMonth({ months: {}, plans: [] }, '2026-02'));
});

test('projected balances beyond the engine input limit cannot silently become future inputs', () => {
  const savingsTooLarge = state([month('2026-01', { savingsOpening: 1000000000 })]);
  checkInvalid(() => M.reportFor(savingsTooLarge, '2026-02'));
  checkInvalid(() => M.validateReports(savingsTooLarge));
  const bufferTooLarge = state([month('2026-01', { openingCA: 1000000000, openingR: 1 })]);
  checkInvalid(() => M.reportFor(bufferTooLarge, '2026-02'));
  const normalizedTooLarge = state([month('2026-01', { openingCA: -1000000000, salaryIncluded: true,
    budget: [], budgetConfirmed: false })]);
  checkInvalid(() => M.reportFor(normalizedTooLarge, '2026-02'));
});

test('validateReports also validates stored unprepared or manual months, without creating gaps', () => {
  const s = state([month('2026-01'), month('2026-05', { prepared: false, savingsOpening: 0 })]);
  const originalKeys = Object.keys(s.months);
  assert.equal(M.validateReports(s), true);
  assert.deepEqual(Object.keys(s.months), originalKeys);
  s.months['2026-05'].budget[0].amount = -1;
  checkInvalid(() => M.validateReports(s));
  s.months['2026-05'].prepared = true;
  checkInvalid(() => M.validateReports(s));
});

test('browser UMD export works after BudgetEngine and fails clearly without it', () => {
  const source = fs.readFileSync(require.resolve('../dist/months.js'), 'utf8');
  const sandbox = { BudgetEngine: E };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  assert.equal(typeof sandbox.BudgetMonths.getMonth, 'function');
  assert.equal(sandbox.BudgetMonths.reportFor(state([month('2026-01')]), '2026-02').savingsOpening, 1480);
  const missing = {};
  vm.createContext(missing);
  checkInvalid(() => vm.runInContext(source, missing));
});

const income = (salary, sourcePayroll = '2025-12', estimated = true) => ({ salary, sourcePayroll, estimated });

test('planned salaries prefill inputs but create no forecast before a real prepared anchor', () => {
  const s = state();
  s.incomePlan = { '2026-01': income(3000), '2026-02': income(3100, '2026-01') };
  const feb = M.getMonth(s, '2026-02');
  assert.equal(feb.salary, 3100);
  assert.equal(feb.prepared, false);
  assert.equal(feb.forecast, false);
  assert.equal(feb.savingsOpening, 0);
  assert.deepEqual(feb.salaryReference, s.incomePlan['2026-02']);
  assert.equal(M.reportFor(s, '2026-03'), null);
  assert.deepEqual(M.projectionMonths(s), []);
});

test('a salary plan builds virtual chained forecasts after the real anchor without storing them', () => {
  const s = state([month('2026-01')]);
  s.incomePlan = { '2026-02': income(3100, '2026-01'), '2026-03': income(3200, '2026-02') };
  const before = JSON.stringify(s);
  const feb = M.getMonth(s, '2026-02');
  assert.equal(feb.prepared, true);
  assert.equal(feb.forecast, true);
  assert.equal(feb.salary, 3100);
  assert.equal(feb.openingCA, 636);
  assert.equal(feb.savingsOpening, 1480);
  const mar = M.getMonth(s, '2026-03');
  assert.equal(mar.openingCA, 678);
  assert.equal(mar.savingsOpening, 2040);
  const report = M.reportFor(s, '2026-04');
  assert.equal(report.sourceKey, '2026-03');
  assert.equal(report.bufferTotal, 726);
  assert.equal(report.savingsOpening, 2680);
  assert.equal(report.provisional, true);
  assert.deepEqual(M.projectionMonths(s).map(m => m.key), ['2026-01', '2026-02', '2026-03']);
  assert.equal(JSON.stringify(s), before);
  assert.equal(M.validateReports(s), true);
  const april = M.getMonth(s, '2026-04');
  assert.equal(april.prepared, false);
  assert.notEqual(april.forecast, true);
});

test('salary plan months before the anchor and missing plan dates generate no extra income', () => {
  const s = state([month('2026-02')]);
  s.incomePlan = { '2026-01': income(9000), '2026-04': income(3000, '2026-03') };
  assert.deepEqual(M.projectionMonths(s).map(m => m.key), ['2026-02', '2026-04']);
  assert.equal(M.getMonth(s, '2026-04').savingsOpening, 1480);
  assert.equal(M.reportFor(s, '2026-04').skipped, 1);
  assert.equal(M.reportFor(s, '2026-05').savingsOpening, 1960);
});

test('an actual prepared month wins over a salary plan entry', () => {
  const actual = linked('2026-02', { salary: 3500, forecast: false });
  const s = state([month('2026-01'), actual]);
  s.incomePlan = { '2026-02': income(3100), '2026-03': income(3200) };
  const feb = M.getMonth(s, '2026-02');
  assert.equal(feb.salary, 3500);
  assert.equal(feb.forecast, false);
  assert.equal(feb.salaryReference, undefined);
  assert.equal(M.getMonth(s, '2026-03').savingsOpening, 2360);
  actual.closed = true;
  actual.closing = { closingCA: 50, closingR: 10, savingsActual: 2200 };
  assert.equal(M.getMonth(s, '2026-02'), actual);
  assert.equal(M.getMonth(s, '2026-03').savingsOpening, 2200);
});

test('a prepared stored forecast preserves its customized salary and budget snapshot', () => {
  const stored = linked('2026-02', { salary: 3300, forecast: true, budget: [] });
  const s = state([month('2026-01'), stored]);
  s.incomePlan = { '2026-02': income(3100), '2026-03': income(3200) };
  const feb = M.getMonth(s, '2026-02');
  assert.equal(feb.salary, 3300);
  assert.equal(feb.budget, stored.budget);
  assert.equal(feb.forecast, true);
  assert.equal(M.getMonth(s, '2026-03').savingsOpening, 4120);
});

test('a planned month keeps an existing budget-only customization', () => {
  const stored = month('2026-02', { prepared: false, budget: budget().map((b, i) => ({ ...b, amount: i === 0 ? 500 : 0 })) });
  const s = state([month('2026-01'), stored]);
  s.incomePlan = { '2026-02': income(3100) };
  const feb = M.getMonth(s, '2026-02');
  assert.equal(feb.prepared, true);
  assert.equal(feb.forecast, true);
  assert.equal(feb.budget, stored.budget);
  assert.equal(M.reportFor(s, '2026-03').savingsOpening, 3560);
  assert.equal(M.reportFor(s, '2026-03').bufferTotal, 792);
});

test('virtual months use the budget and rules applicable to their own dates', () => {
  const s = state([month('2026-01')]);
  s.incomePlan = { '2026-02': income(3100), '2026-03': income(3200) };
  s.plans.push({ from: '2026-03', confirmed: true, budget: [], rules: { ...rules(), savingPct: 100 } });
  const mar = M.getMonth(s, '2026-03');
  assert.equal(mar.budget.length, 0);
  assert.equal(mar.rules.savingPct, 100);
  assert.equal(M.reportFor(s, '2026-04').savingsOpening, 5240);
  assert.equal(M.reportFor(s, '2026-04').bufferTotal, 678);
});

test('an unready budget cannot anchor forecasts, but an explicitly confirmed zero budget can', () => {
  const anchor = month('2026-01', { budget: [], budgetConfirmed: false });
  const s = state([anchor]);
  s.incomePlan = { '2026-02': income(3000) };
  assert.equal(M.getMonth(s, '2026-02').prepared, false);
  assert.equal(M.getMonth(s, '2026-02').savingsOpening, 1000);
  assert.deepEqual(M.projectionMonths(s).map(m => m.key), ['2026-01']);
  anchor.budgetConfirmed = true;
  assert.equal(M.getMonth(s, '2026-02').forecast, true);
  assert.equal(M.getMonth(s, '2026-02').savingsOpening, 3400);
});

test('a stored forecast without any real anchor does not authorize additional virtual forecasts', () => {
  const s = state([linked('2026-01', { forecast: true })]);
  s.incomePlan = { '2026-02': income(3000) };
  assert.equal(M.getMonth(s, '2026-02').prepared, false);
  assert.deepEqual(M.projectionMonths(s).map(m => m.key), ['2026-01']);
});

test('zero forecast income preserves deficits through the forecast chain', () => {
  const s = state([month('2026-01')]);
  s.incomePlan = { '2026-02': income(0), '2026-03': income(3000) };
  const march = M.getMonth(s, '2026-03');
  assert.equal(march.openingCA, -1764);
  assert.equal(march.savingsOpening, 1480);
  assert.equal(M.reportFor(s, '2026-04').bufferTotal, -1164);
  assert.equal(M.reportFor(s, '2026-04').savingsOpening, 1480);
});

test('invalid forecast schema and cumulative forecast overflow fail explicitly', () => {
  for (const reference of [income(-1), income(NaN), income(1.001), income(3000, 'bad'), { salary: 3000, sourcePayroll: '2025-12', estimated: 'yes' }]) {
    const s = state([month('2026-01')]);
    s.incomePlan = { '2026-02': reference };
    checkInvalid(() => M.validateReports(s));
  }
  const s = state([month('2026-01', { savingsOpening: 999999000 })]);
  s.incomePlan = { '2026-02': income(3000), '2026-03': income(3000) };
  checkInvalid(() => M.projectionMonths(s));
});

test('projectionMonths validates a large forecast calendar in one engine pass', () => {
  const s = state([month('2025-12')]);
  s.incomePlan = {};
  for (let i = 0; i < 300; i += 1) {
    const key = `${2026 + Math.floor(i / 12)}-${String(i % 12 + 1).padStart(2, '0')}`;
    s.incomePlan[key] = income(3000);
  }
  let calculations = 0;
  const sandbox = { BudgetEngine: { calculate(m) { calculations += 1; return E.calculate(m); }, closeMonth: E.closeMonth } };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(require.resolve('../dist/months.js'), 'utf8'), sandbox);
  const projected = sandbox.BudgetMonths.projectionMonths(s);
  assert.equal(projected.length, 301);
  assert.equal(calculations, 301);
  assert.equal(projected[300].savingsOpening, 145000);
});
