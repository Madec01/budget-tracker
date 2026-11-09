'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const Engine = require('../dist/engine.js');

const cents = n => Math.round(n * 100);
const row = (id, account, amount, enabled = true) => ({ id, name: id, category: 'Divers', account, amount, enabled });
function month(overrides = {}) {
  return {
    salary: 3000, openingCA: 400, openingR: 200, salaryIncluded: false,
    savingsOpening: 1000,
    budget: [row('Fixes', 'ca', 1700), row('Loisirs', 'r', 700)],
    rules: { threshold: 500, savingPct: 80, rPct: 70, caPct: 0, tPct: 30 },
    useBuffer: false, ...overrides
  };
}
function conservation(m, result) {
  assert.equal(result.valid, true, result.errors.join('\n'));
  assert.equal(cents(result.savingsAdd) + cents(result.surplus), Math.max(0, cents(result.effectiveRemainder)));
  assert.equal(cents(result.caBonus) + cents(result.rBonus) + cents(result.tamponBonus), cents(result.surplus));
  assert.equal(
    cents(result.availableCA) + cents(result.availableR) + cents(result.savingsAdd) + cents(result.bufferEndPlan),
    cents(result.openingTotal) + cents(m.salary) + cents(result.shortfall)
  );
  assert.equal(cents(m.openingR) + cents(result.transferR), cents(result.availableR));
  assert.equal(
    cents(result.openingCANormalized) + cents(m.salary) - cents(result.transferR) - cents(result.transferSavings),
    cents(result.bankCATarget) - cents(result.shortfall)
  );
}

test('baseline: 600 remainder produces 480 savings and a 70/30 surplus split', () => {
  const m = month();
  const r = Engine.calculate(m);
  assert.equal(r.valid, true);
  assert.equal(r.funded, true);
  assert.equal(r.remainder, 600);
  assert.equal(r.savingsAdd, 480);
  assert.equal(r.surplus, 120);
  assert.equal(r.rBonus, 84);
  assert.equal(r.caBonus, 0);
  assert.equal(r.tamponBonus, 36);
  assert.equal(r.availableCA, 1700);
  assert.equal(r.availableR, 784);
  assert.equal(r.bufferEndPlan, 636);
  assert.equal(r.transferR, 584);
  assert.equal(r.bankCATarget, 2336);
  assert.equal(r.savingsProjected, 1480);
  conservation(m, r);
});

test('499 euros is saved entirely; the 500-euro threshold applies to the entire remainder', () => {
  const below = Engine.calculate(month({ salary: 2899 }));
  const at = Engine.calculate(month({ salary: 2900 }));
  assert.equal(below.savingsAdd, 499);
  assert.equal(below.surplus, 0);
  assert.equal(at.savingsAdd, 400);
  assert.equal(at.surplus, 100);
  assert.equal(at.rBonus, 70);
  assert.equal(at.tamponBonus, 30);
});

test('a deficit can be funded by the buffer only when explicitly enabled', () => {
  const m = month({ salary: 2200 });
  const blocked = Engine.calculate(m);
  assert.equal(blocked.funded, false);
  assert.equal(blocked.deficit, 200);
  assert.equal(blocked.bufferUsed, 0);
  assert.equal(blocked.shortfall, 200);
  assert.equal(blocked.savingsAdd, 0);
  conservation(m, blocked);
  const enabled = month({ salary: 2200, useBuffer: true });
  const funded = Engine.calculate(enabled);
  assert.equal(funded.funded, true);
  assert.equal(funded.bufferUsed, 200);
  assert.equal(funded.bufferEndPlan, 400);
  assert.equal(funded.shortfall, 0);
  conservation(enabled, funded);
});

test('an insufficient buffer exposes the remaining shortfall without creating savings', () => {
  const m = month({ salary: 2200, openingCA: 60, openingR: 40, useBuffer: true });
  const r = Engine.calculate(m);
  assert.equal(r.funded, false);
  assert.equal(r.bufferUsed, 100);
  assert.equal(r.shortfall, 100);
  assert.equal(r.bufferEndPlan, 0);
  assert.equal(r.savingsAdd, 0);
  assert.equal(r.surplus, 0);
  conservation(m, r);
});

test('a net opening overdraft is settled before savings and changes the effective threshold', () => {
  const m = month({ openingCA: -250, openingR: 100 });
  const r = Engine.calculate(m);
  assert.equal(r.openingTotal, -150);
  assert.equal(r.remainder, 600);
  assert.equal(r.effectiveRemainder, 450);
  assert.equal(r.bufferAvailable, 0);
  assert.equal(r.savingsAdd, 450);
  assert.equal(r.surplus, 0);
  assert.equal(r.bufferEndPlan, 0);
  conservation(m, r);
});

test('an uncovered opening overdraft blocks a seemingly affordable salary budget', () => {
  const m = month({ openingCA: -900, openingR: 100, useBuffer: true });
  const r = Engine.calculate(m);
  assert.equal(r.remainder, 600);
  assert.equal(r.effectiveRemainder, -200);
  assert.equal(r.funded, false);
  assert.equal(r.shortfall, 200);
  assert.equal(r.bufferUsed, 0);
  conservation(m, r);
});

test('an individual negative account is covered by transfers when combined opening balances are positive', () => {
  const m = month({ openingCA: 800, openingR: -200 });
  const r = Engine.calculate(m);
  assert.equal(r.openingTotal, 600);
  assert.equal(r.funded, true);
  assert.equal(r.transferR, 984);
  conservation(m, r);
});

test('salary already included in CA is removed exactly once', () => {
  const raw = month();
  const included = month({ openingCA: 3400, salaryIncluded: true });
  assert.deepEqual(Engine.calculate(included), Engine.calculate(raw));
  conservation(included, Engine.calculate(included));
});

test('salary-included normalization can reveal a pre-existing overdraft', () => {
  const m = month({ openingCA: 2500, openingR: 0, salaryIncluded: true });
  const r = Engine.calculate(m);
  assert.equal(r.openingCANormalized, -500);
  assert.equal(r.savingsAdd, 100);
  assert.equal(r.bufferEndPlan, 0);
  conservation(m, r);
});

test('a negative Revolut transfer means returning the excess to CA', () => {
  const m = month({ openingCA: 100, openingR: 1000 });
  const r = Engine.calculate(m);
  assert.equal(r.transferR, -216);
  assert.equal(r.bufferEndPlan, 1136);
  conservation(m, r);
});

test('disabled budget rows do not contribute and zero remainder is fully funded', () => {
  const m = month({ salary: 2400, budget: [...month().budget, row('Désactivé', 'r', 300, false)] });
  const r = Engine.calculate(m);
  assert.equal(r.budgetTotal, 2400);
  assert.equal(r.funded, true);
  assert.equal(r.savingsAdd, 0);
  assert.equal(r.surplus, 0);
  conservation(m, r);
});

test('one-decimal percentages and cent rounding conserve money', () => {
  const m = month({
    salary: 500.01, budget: [], openingCA: 0.03, openingR: 0.02,
    rules: { threshold: 500, savingPct: 79.9, caPct: 33.3, rPct: 33.3, tPct: 33.4 }
  });
  const r = Engine.calculate(m);
  assert.equal(r.savingsAdd, 399.51);
  assert.equal(r.surplus, 100.50);
  assert.equal(r.caBonus, 33.47);
  assert.equal(r.rBonus, 33.46);
  assert.equal(r.tamponBonus, 33.57);
  conservation(m, r);
});

test('cent ties prefer the buffer without exceeding the surplus', () => {
  const m = month({ salary: 0.01, budget: [], rules: { threshold: 0, savingPct: 0, rPct: 50, caPct: 0, tPct: 50 } });
  const r = Engine.calculate(m);
  assert.equal(r.rBonus, 0);
  assert.equal(r.tamponBonus, 0.01);
  conservation(m, r);
});

test('floating-point noise is accepted, while precision beyond cents is rejected', () => {
  const valid = Engine.calculate(month({ salary: 0.1 + 0.2, budget: [] }));
  assert.equal(valid.valid, true);
  assert.equal(valid.remainder, 0.3);
  const invalid = Engine.calculate(month({ salary: 1.005 }));
  assert.equal(invalid.valid, false);
});

test('invalid values cannot generate a plausible funded plan', () => {
  const bad = [
    null, undefined, [], {},
    month({ salary: NaN }), month({ salary: Infinity }), month({ salary: '3000' }),
    month({ salary: -1 }), month({ salary: 1000000000.01 }),
    month({ openingCA: -1000000000.01 }), month({ savingsOpening: -1 }),
    month({ salaryIncluded: 'false' }), month({ useBuffer: 1 }),
    month({ rules: { ...month().rules, savingPct: 80.01 } }),
    month({ rules: { ...month().rules, rPct: 60 } }),
    month({ rules: { ...month().rules, threshold: -1 } }),
    month({ budget: [row('Bad', 'other', 3)] }),
    month({ budget: [row('Bad', 'ca', -3)] }),
    month({ budget: [row('Same', 'ca', 1), row('Same', 'r', 1)] }),
    month({ budget: [row('a', 'ca', 1000000000), row('b', 'r', 0.01)] }),
    month({ budget: Array.from({ length: 1001 }, (_, n) => row(String(n), 'r', 0)) })
  ];
  for (const input of bad) {
    const r = Engine.calculate(input);
    assert.equal(r.valid, false);
    assert.equal(r.funded, false);
    assert.ok(r.errors.length > 0);
    assert.equal(r.transferR, null);
    assert.equal(r.savingsAdd, null);
  }
});

test('calculate is pure, including nested arrays and rules', () => {
  const m = month();
  m.budget.forEach(Object.freeze);
  Object.freeze(m.budget);
  Object.freeze(m.rules);
  Object.freeze(m);
  const serialized = JSON.stringify(m);
  assert.deepEqual(Engine.calculate(m), Engine.calculate(m));
  assert.equal(JSON.stringify(m), serialized);
});

test('closing uses real account balances rather than adding old reserves again', () => {
  const m = month();
  const actual = { closingCA: 610, closingR: 40, savingsActual: 1480 };
  const original = JSON.stringify({ m, actual });
  const r = Engine.closeMonth(m, actual);
  assert.deepEqual(r, {
    valid: true, errors: [], planFunded: true,
    closingCA: 610, closingR: 40, bufferActual: 650,
    deltaVsOpening: 50, deltaVsPlan: 14,
    savingsActual: 1480, savingsDelta: 480
  });
  assert.equal(JSON.stringify({ m, actual }), original);
});

test('closing handles negative cash and actual savings withdrawals', () => {
  const r = Engine.closeMonth(month(), { closingCA: -120, closingR: 20, savingsActual: 900 });
  assert.equal(r.valid, true);
  assert.equal(r.bufferActual, -100);
  assert.equal(r.deltaVsOpening, -700);
  assert.equal(r.deltaVsPlan, -736);
  assert.equal(r.savingsDelta, -100);
});

test('closing validates every actual balance and the original plan', () => {
  const actual = { closingCA: 1, closingR: 2, savingsActual: 3 };
  for (const [m, a] of [
    [month(), null], [month(), { ...actual, closingCA: '1' }],
    [month(), { ...actual, closingR: NaN }], [month(), { ...actual, savingsActual: -1 }],
    [month({ salary: NaN }), actual], [month(), { closingCA: 1, closingR: 2 }]
  ]) {
    const r = Engine.closeMonth(m, a);
    assert.equal(r.valid, false);
    assert.ok(r.errors.length);
    assert.equal(r.bufferActual, null);
  }
});

test('whole-cent conservation across 1000 deterministic budget scenarios', () => {
  let seed = 29137;
  const rand = limit => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % limit; };
  for (let n = 0; n < 1000; n += 1) {
    const caPct = rand(1001);
    const rPct = rand(1001 - caPct);
    const m = month({
      salary: rand(800001) / 100,
      openingCA: (rand(300001) - 100000) / 100,
      openingR: (rand(200001) - 100000) / 100,
      salaryIncluded: n % 7 === 0,
      budget: [row('ca', 'ca', rand(300001) / 100), row('r', 'r', rand(300001) / 100)],
      rules: { threshold: rand(100001) / 100, savingPct: rand(1001) / 10, caPct: caPct / 10, rPct: rPct / 10, tPct: (1000 - caPct - rPct) / 10 },
      useBuffer: n % 2 === 0
    });
    const r = Engine.calculate(m);
    conservation(m, r);
    assert.equal(r.funded, r.shortfall === 0);
    assert.ok(r.bufferUsed >= 0 && r.bufferUsed <= r.bufferAvailable);
    assert.ok(r.bufferEndPlan >= 0);
    assert.ok(r.savingsAdd >= 0);
  }
});

test('the same implementation exposes BudgetEngine in a standalone browser script', () => {
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(require.resolve('../dist/engine.js'), 'utf8'), sandbox);
  assert.equal(typeof sandbox.BudgetEngine.calculate, 'function');
  assert.equal(typeof sandbox.BudgetEngine.closeMonth, 'function');
  assert.equal(sandbox.BudgetEngine.calculate(month()).savingsAdd, 480);
});

const checkpoint = (date, balanceCA, balanceR) => ({ date, balanceCA, balanceR });
function observed(overrides = {}) {
  return month({ key: '2026-11',
    checkpoints: [checkpoint('2026-11-09', 1336, 384)],
    checkpointTransfers: { '2026-11-09': { r: 584, savings: 480 } },
    executed: { r: 584, savings: 480 }, ...overrides });
}

test('checkpoint consumption neutralizes actual CA/Revolut and CA/savings transfers', () => {
  const m = observed();
  const r = Engine.checkpointTracking(m, '2026-11-09');
  assert.equal(r.valid, true);
  assert.equal(r.elapsedPct, 30);
  assert.equal(r.transferSnapshotSource, 'checkpoint');
  assert.equal(r.accounts.ca.spent, 1000);
  assert.equal(r.accounts.r.spent, 400);
  assert.equal(r.accounts.ca.budget, 1700);
  assert.equal(r.accounts.r.budget, 784);
  assert.equal(r.accounts.ca.remaining, 700);
  assert.equal(r.accounts.r.remaining, 384);
  assert.equal(r.accounts.ca.ahead, true);
  assert.equal(r.accounts.ca.spentPct, 1000 / 1700 * 100);
  assert.equal(cents(r.accounts.ca.spent) + cents(r.accounts.r.spent),
    cents(600 + 3000 - 480 - 1336 - 384));
});

test('a snapshot freezes transfer effects when later transfers are marked complete', () => {
  const m = observed();
  const before = Engine.checkpointTracking(m, '2026-11-09');
  m.executed = { r: 900, savings: 700 };
  const after = Engine.checkpointTracking(m, '2026-11-09');
  assert.deepEqual(after.accounts, before.accounts);
  assert.deepEqual(after.transferSnapshot, { r: 584, savings: 480 });
});

test('missing snapshots explicitly fall back to executed amounts, including legacy zero', () => {
  const m = observed({ checkpointTransfers: undefined, executed: { r: 900, savings: 700 } });
  let r = Engine.checkpointTracking(m, '2026-11-09');
  assert.equal(r.transferSnapshotSource, 'executed-fallback');
  assert.equal(r.accounts.ca.spent, 464);
  assert.equal(r.accounts.r.spent, 716);
  delete m.executed;
  r = Engine.checkpointTracking(m, '2026-11-09');
  assert.deepEqual(r.transferSnapshot, { r: 0, savings: 0 });
  assert.equal(r.accounts.ca.spent, 2064);
  assert.equal(r.accounts.r.spent, -184);
});

test('reverse Revolut and savings movements are neutralized with their signed amounts', () => {
  const returned = observed({ openingR: 1000,
    checkpoints: [checkpoint('2026-11-09', 2136, 484)],
    checkpointTransfers: { '2026-11-09': { r: -216, savings: 480 } } });
  let r = Engine.checkpointTracking(returned, '2026-11-09');
  assert.equal(r.accounts.ca.spent, 1000);
  assert.equal(r.accounts.r.spent, 300);
  const withdrawal = observed({
    checkpoints: [checkpoint('2026-11-09', 3350, 280)],
    checkpointTransfers: { '2026-11-09': { r: 100, savings: -100 } } });
  r = Engine.checkpointTracking(withdrawal, '2026-11-09');
  assert.equal(r.accounts.ca.spent, 50);
  assert.equal(r.accounts.r.spent, 20);
});

test('salary already included in the opening CA balance is counted exactly once', () => {
  const before = Engine.checkpointTracking(observed(), '2026-11-09');
  const included = Engine.checkpointTracking(observed({ openingCA: 3400, salaryIncluded: true }), '2026-11-09');
  assert.deepEqual(included.accounts, before.accounts);
});

test('budget percentages use both CA and Revolut surplus additions', () => {
  const m = observed({ rules: { ...month().rules, caPct: 20, rPct: 60, tPct: 20 } });
  const r = Engine.checkpointTracking(m, '2026-11-09');
  assert.equal(r.accounts.ca.budget, 1724);
  assert.equal(r.accounts.r.budget, 772);
  assert.equal(r.accounts.ca.spentPct, 1000 / 1724 * 100);
  assert.equal(r.accounts.r.spentPct, 400 / 772 * 100);
});

test('net outside inflows remain signed while their visual bars stay at zero', () => {
  const m = observed({ checkpoints: [checkpoint('2026-11-09', 2386, 809)] });
  const r = Engine.checkpointTracking(m, '2026-11-09');
  assert.equal(r.accounts.ca.spent, -50);
  assert.equal(r.accounts.r.spent, -25);
  assert.ok(r.accounts.ca.spentPct < 0);
  assert.equal(r.accounts.ca.barPct, 0);
  assert.equal(r.accounts.ca.netInflow, true);
  assert.equal(r.accounts.ca.ahead, false);
  assert.equal(r.accounts.ca.remaining, 1750);
});

test('overspending keeps its percentage above 100 and clamps only the bar', () => {
  const m = observed({ checkpoints: [checkpoint('2026-11-09', 336, -16)] });
  const r = Engine.checkpointTracking(m, '2026-11-09');
  assert.equal(r.accounts.ca.spent, 2000);
  assert.equal(r.accounts.r.spent, 800);
  assert.ok(r.accounts.ca.spentPct > 100);
  assert.ok(r.accounts.r.spentPct > 100);
  assert.equal(r.accounts.ca.barPct, 100);
  assert.equal(r.accounts.ca.remaining, -300);
  assert.equal(r.accounts.ca.netInflow, false);
  assert.equal(r.accounts.ca.ahead, true);
});

test('zero budgets have no percentage or pacing difference and do not divide by zero', () => {
  const m = observed({ salary: 100, budget: [],
    checkpoints: [checkpoint('2026-11-09', 390, 195)],
    checkpointTransfers: { '2026-11-09': { r: 0, savings: 100 } } });
  const r = Engine.checkpointTracking(m, '2026-11-09');
  assert.equal(r.accounts.ca.spent, 10);
  assert.equal(r.accounts.r.spent, 5);
  for (const account of Object.values(r.accounts)) {
    assert.equal(account.spentPct, null);
    assert.equal(account.paceDifferencePct, null);
    assert.equal(account.barPct, 0);
    assert.equal(account.ahead, false);
  }
});

test('checkpoint arithmetic is exact at the cent, including ordinary binary float noise', () => {
  const m = observed({ salary: 0.1 + 0.2, openingCA: 0.2, openingR: 0.1,
    budget: [row('ca', 'ca', 0.1), row('r', 'r', 0.1)],
    checkpoints: [checkpoint('2026-11-09', 0.2, 0.15)],
    checkpointTransfers: { '2026-11-09': { r: 0.1, savings: 0.1 } } });
  const r = Engine.checkpointTracking(m, '2026-11-09');
  assert.equal(r.accounts.ca.spent, 0.1);
  assert.equal(r.accounts.r.spent, 0.05);
  assert.equal(r.accounts.ca.spentPct, 100);
  assert.equal(r.accounts.r.spentPct, 50);
});

test('latest observation is selected by actual instant, not insertion or textual date order', () => {
  const m = observed({ checkpoints: [
    checkpoint('2026-11-01T00:00:00-12:00', 100, 200),
    checkpoint('2026-11-01T01:00:00+14:00', 300, 400)
  ], checkpointTransfers: {}, executed: { r: 0, savings: 0 } });
  assert.equal(Engine.validateCheckpoints(m).length, 0);
  const r = Engine.checkpointTracking(m, '2026-11-02');
  assert.equal(r.latest.date, '2026-11-01T00:00:00-12:00');
  assert.notEqual(r.latest, m.checkpoints[0]);
  assert.equal(r.accounts.ca.spent, 3300);
});

test('ISO dates belong to their written local month even when UTC is in another month', () => {
  const m = observed({ checkpoints: [checkpoint('2026-11-01T00:30:00+14:00', 1, 2)], checkpointTransfers: {} });
  assert.deepEqual(Engine.validateCheckpoints(m), []);
  assert.equal(Engine.elapsedMonthPct('2026-11', '2026-11-01T00:30:00+14:00'), 100 / 30);
});

test('elapsed month includes today, handles leap years and clamps past/future months', () => {
  assert.equal(Engine.elapsedMonthPct('2024-02', '2024-02-01'), 100 / 29);
  assert.equal(Engine.elapsedMonthPct('2024-02', '2024-02-29T23:59:59-08:00'), 100);
  assert.equal(Engine.elapsedMonthPct('2026-02', '2026-02-14'), 50);
  assert.equal(Engine.elapsedMonthPct('2026-11', '2026-11-30'), 100);
  assert.equal(Engine.elapsedMonthPct('2026-10', '2026-11-01'), 100);
  assert.equal(Engine.elapsedMonthPct('2026-12', '2026-11-30'), 0);
  assert.equal(Engine.elapsedMonthPct('2027-01', '2026-12-31'), 0);
  assert.equal(Engine.elapsedMonthPct('2025-12', '2026-01-01'), 100);
});

test('Date pacing uses the runtime local calendar across timezone day boundaries', () => {
  const { execFileSync } = require('node:child_process');
  const enginePath = require.resolve('../dist/engine.js');
  const script = `const E=require(${JSON.stringify(enginePath)}); process.stdout.write(String(E.elapsedMonthPct('2026-11',new Date('2026-11-01T01:00:00Z'))));`;
  const west = Number(execFileSync(process.execPath, ['-e', script], { env: { ...process.env, TZ: 'America/Los_Angeles' } }).toString());
  const east = Number(execFileSync(process.execPath, ['-e', script], { env: { ...process.env, TZ: 'Pacific/Kiritimati' } }).toString());
  assert.equal(west, 0);
  assert.equal(east, 100 / 30);
});

test('legacy absence and an empty checkpoint array are accepted with no invented tracking', () => {
  assert.deepEqual(Engine.validateCheckpoints(month()), []);
  const m = month({ key: '2026-11' });
  const r = Engine.checkpointTracking(m, '2026-11-09');
  assert.equal(r.valid, true);
  assert.equal(r.latest, null);
  assert.equal(r.accounts, null);
  assert.equal(r.transferSnapshot, null);
  assert.equal(r.transferSnapshotSource, null);
  assert.equal(r.elapsedPct, 30);
});

test('checkpoint imports reject rollovers, missing timezone, duplicates and invalid amounts', () => {
  const invalidDates = ['2026-11-31', '2026-02-29', '2026-11-00', '2026-00-01',
    '2026-11-09T24:00:00Z', '2026-11-09T12:60:00Z', '2026-11-09T12:00:60Z',
    '2026-11-09T12:00:00+25:00', '2026-11-09T12:00:00+01:60',
    '2026-11-09T12:00:00', '2026-11-9', 'not-a-date'];
  for (const date of invalidDates) {
    assert.ok(Engine.validateCheckpoints(observed({ checkpoints: [checkpoint(date, 0, 0)], checkpointTransfers: undefined })).length, date);
  }
  for (const value of [NaN, Infinity, '10', 0.001, 1000000000.01, -1000000000.01]) {
    assert.ok(Engine.validateCheckpoints(observed({ checkpoints: [checkpoint('2026-11-09', value, 0)] })).length);
  }
  const duplicates = observed({ checkpoints: [checkpoint('2026-11-09T10:00:00+01:00', 0, 0), checkpoint('2026-11-09T09:00:00Z', 0, 0)], checkpointTransfers: {} });
  assert.ok(Engine.validateCheckpoints(duplicates).some(e => /déjà utilisée/.test(e)));
  assert.ok(Engine.validateCheckpoints(observed({ checkpoints: [checkpoint('2026-10-31', 0, 0)], checkpointTransfers: {} })).length);
  assert.ok(Engine.validateCheckpoints(observed({ checkpoints: null })).length);
  assert.ok(Engine.validateCheckpoints(observed({ checkpoints: [null] })).length);
});

test('leap dates follow Gregorian calendar rules without Date rollover', () => {
  for (const [key, date, valid] of [
    ['2000-02', '2000-02-29', true], ['1900-02', '1900-02-29', false],
    ['2024-02', '2024-02-29', true], ['2026-02', '2026-02-29', false]
  ]) {
    const m = observed({ key, checkpoints: [checkpoint(date, 0, 0)], checkpointTransfers: {} });
    assert.equal(Engine.validateCheckpoints(m).length === 0, valid);
  }
});

test('snapshots reject orphan keys and malformed values, while signed values are valid', () => {
  const valid = observed({ checkpointTransfers: { '2026-11-09': { r: -10.25, savings: -5.50 } } });
  assert.deepEqual(Engine.validateCheckpoints(valid), []);
  for (const checkpointTransfers of [null, [], { '2026-11-10': { r: 0, savings: 0 } },
    { '2026-11-09': {} }, { '2026-11-09': { r: 0, savings: NaN } },
    { '2026-11-09': { r: 0.001, savings: 0 } }, { '2026-11-09': null }]) {
    assert.ok(Engine.validateCheckpoints(observed({ checkpointTransfers })).length);
  }
});

test('checkpoint history allows 93 observations and rejects a 94th', () => {
  const checkpoints = Array.from({ length: 93 }, (_, i) => checkpoint(new Date(Date.UTC(2026, 10, 1, i)).toISOString(), 0, 0));
  assert.deepEqual(Engine.validateCheckpoints(observed({ checkpoints, checkpointTransfers: {} })), []);
  checkpoints.push(checkpoint(new Date(Date.UTC(2026, 10, 1, 93)).toISOString(), 0, 0));
  assert.ok(Engine.validateCheckpoints(observed({ checkpoints, checkpointTransfers: {} })).length);
});

test('tracking fails explicitly for bad fallback transfers and invalid current date', () => {
  for (const executed of [null, { r: NaN, savings: 0 }, { r: 0, savings: 0.001 }]) {
    const result = Engine.checkpointTracking(observed({ checkpointTransfers: {}, executed }), '2026-11-09');
    assert.equal(result.valid, false);
    assert.equal(result.accounts, null);
    assert.ok(result.errors.length);
  }
  for (const now of ['2026-11-31', new Date(NaN), 123, null]) {
    assert.equal(Engine.elapsedMonthPct('2026-11', now), null);
    assert.equal(Engine.checkpointTracking(observed(), now).valid, false);
  }
  assert.equal(Engine.elapsedMonthPct('2026-13', '2026-11-09'), null);
});

test('checkpoint tracking does not mutate sorted history, snapshots or nested state', () => {
  const m = observed({ checkpoints: [checkpoint('2026-11-10', 1200, 300), checkpoint('2026-11-09', 1336, 384)] });
  const before = JSON.stringify(m);
  function freeze(value) { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } }
  freeze(m);
  const r = Engine.checkpointTracking(m, '2026-11-10');
  assert.equal(r.latest.date, '2026-11-10');
  assert.equal(r.transferSnapshotSource, 'executed-fallback');
  assert.equal(JSON.stringify(m), before);
});

test('500 signed transfer scenarios conserve consumption at the cent', () => {
  let seed = 10973;
  const rand = limit => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % limit; };
  for (let i = 0; i < 500; i += 1) {
    const rCents = rand(300001) - 100000, savingsCents = rand(200001) - 100000;
    const spentCA = rand(400001) - 100000, spentR = rand(200001) - 100000;
    const m = observed({
      checkpoints: [checkpoint('2026-11-09', (340000 - rCents - savingsCents - spentCA) / 100, (20000 + rCents - spentR) / 100)],
      checkpointTransfers: { '2026-11-09': { r: rCents / 100, savings: savingsCents / 100 } }
    });
    const result = Engine.checkpointTracking(m, '2026-11-09');
    assert.equal(result.valid, true, result.errors.join(' '));
    assert.equal(cents(result.accounts.ca.spent), spentCA);
    assert.equal(cents(result.accounts.r.spent), spentR);
    assert.equal(cents(result.accounts.ca.spent) + cents(result.accounts.r.spent), spentCA + spentR);
  }
});
