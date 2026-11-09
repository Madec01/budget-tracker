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
