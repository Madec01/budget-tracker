'use strict';
// Logic-only integration tests: no browser and no production-only test hooks.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const crypto = require('node:crypto');
const E = require('../dist/engine.js');
const M = require('../dist/months.js');
const KEY = 'marge.budget.v1';
const originalSource = fs.readFileSync(require.resolve('../dist/app.js'), 'utf8');
const ending = '\nrender();\n})();';
assert.ok(originalSource.includes(ending), 'The test hook must replace only the final render call.');
const source = originalSource.replace(ending, `
window.__test = {
  getState:()=>state, setState:s=>{state=s;persistent=s;},
  flags:()=>({loadError,saveFailed,storageConflict,demo,dirty}),
  setDraft:d=>{draft=d;}, setPendingImport:x=>{pendingImport=x;},
  getMonth,calc,operation,changeMonth,saveBudget,saveMonth,saveClosing,validateState,
  action,navigate,exportData,startDemo,leaveDemo,showIncomeImport,importIncomePlan
};
render();
})();`);

function boot(raw = null) {
  const nodes = new Map();
  const storage = new Map(raw === null ? [] : [[KEY, raw]]);
  const events = {};
  const control = { failSave: false, writeCount: 0, downloads: 0, pwaBusy: null };
  const element = selector => {
    if (!nodes.has(selector)) nodes.set(selector, {
      value: '', checked: false, textContent: '', innerHTML: '', dataset: {},
      classList: { add() {}, remove() {}, toggle() {} },
      listeners: {}, addEventListener(name,fn) { this.listeners[name]=fn; }, querySelector: element, querySelectorAll() { return []; },
      scrollIntoView() {}, focus() {}, click() {},
      showModal() { this.open = true; }, close() { this.open = false; this.listeners.close?.(); }
    });
    return nodes.get(selector);
  };
  const window = {
    BudgetEngine: E, BudgetMonths: M,
    MargePWA: { setBusy(value) { control.pwaBusy=!!value; }, getStatus() { return {supported:true,offlineReady:true}; } },
    addEventListener(name, fn) { events[name] = fn; },
    scrollTo() {}
  };
  const sandbox = {
    window, document: { querySelector: element, body: { dataset: {} }, createElement: element },
    localStorage: {
      getItem: key => storage.get(key) || null,
      setItem(key, value) {
        if (control.failSave) throw new Error('Storage quota exceeded');
        control.writeCount += 1;
        storage.set(key, value);
      }
    },
    Intl, Date, Math, Number, JSON, crypto, Blob,
    URL: { createObjectURL() { control.downloads += 1; return 'blob:test'; }, revokeObjectURL() {} },
    setTimeout() { return 1; }, clearTimeout() {}
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  return { api: window.__test, element, storage, events, control };
}

const copy = value => JSON.parse(JSON.stringify(value));
const budgetWith = (budget, amount) => budget.map((b, i) => ({ ...b, amount: i === 0 ? amount : 0 }));
function editBudget(h, amount, scope = 'month') {
  const m = h.api.getMonth();
  h.api.setDraft({ key: m.key, budget: budgetWith(m.budget, amount), rules: copy(m.rules) });
  h.element('#budget-scope').value = scope;
}
function monthFields(h, values) {
  for (const key of ['salary', 'openingCA', 'openingR', 'savingsOpening']) {
    h.element(`[name="${key}"]`).value = String(values[key] ?? 0);
  }
  h.element('[name=salaryIncluded]').checked = !!values.salaryIncluded;
}
function closingFields(h, values) {
  for (const key of ['closingCA', 'closingR', 'savingsActual']) {
    h.element(`[name="${key}"]`).value = String(values[key]);
  }
  h.element('[name=closingConfirmed]').checked = true;
}

test('the default app month satisfies the engine contract, including valid:true', () => {
  const h = boot();
  const result = h.api.calc(h.api.getMonth());
  assert.equal(result.valid, true);
  assert.equal(result.errors.length, 0);
  assert.doesNotThrow(() => h.api.validateState(h.api.getState()));
});

test('unreadable storage survives navigation, blocked changes and recovery export', async () => {
  const raw = '{broken JSON: important recovery data';
  const h = boot(raw);
  assert.equal(h.api.flags().loadError, true);
  h.api.changeMonth('2026-12');
  await h.api.action('theme', {});
  editBudget(h, 200);
  h.api.saveBudget();
  h.api.exportData();
  assert.equal(h.storage.get(KEY), raw);
  assert.equal(h.control.writeCount, 0);
  assert.equal(h.control.downloads, 1);
  assert.match(h.element('#app').innerHTML, /Elle n’a pas été écrasée/);
});

test('a budget-only future month receives real balances when its predecessor closes', () => {
  const h = boot();
  const state = h.api.getState();
  state.selectedMonth = '2026-11';
  const previous = h.api.getMonth();
  previous.prepared = true;
  previous.salary = 3000;
  previous.savingsOpening = 1000;
  state.months[previous.key] = previous;
  h.api.changeMonth('2026-12');
  editBudget(h, 250);
  h.api.saveBudget();
  assert.equal(state.months['2026-12'].prepared, false);
  h.api.changeMonth('2026-11');
  closingFields(h, { closingCA: 500, closingR: 20, savingsActual: 1300 });
  h.api.saveClosing();
  assert.equal(state.months['2026-11'].closed, true);
  const next = h.api.getMonth('2026-12');
  assert.equal(next.openingCA, 500);
  assert.equal(next.openingR, 20);
  assert.equal(next.savingsOpening, 1300);
  assert.equal(next.salaryIncluded, false);
  assert.equal(E.calculate(next).budgetTotal, 250);
  assert.equal(E.calculate(next).openingTotal, 520);
});

test('an already prepared future month keeps its explicitly entered opening balances', () => {
  const h = boot();
  const state = h.api.getState();
  const previous = h.api.getMonth('2026-11');
  previous.prepared = previous.closed = true;
  previous.closing = { closingCA: 500, closingR: 20, savingsActual: 1300 };
  state.months[previous.key] = previous;
  const next = h.api.getMonth('2026-12');
  next.prepared = true;
  next.openingCA = 900;
  next.savingsOpening = 1900;
  delete next.carry; // A legacy month had no automatic-link flags.
  state.months[next.key] = next;
  assert.equal(h.api.getMonth('2026-12').openingCA, 900);
  assert.equal(h.api.getMonth('2026-12').savingsOpening, 1900);
});

test('future scope replaces later budget plans, resets open actions and preserves closed months', () => {
  const h = boot();
  const state = h.api.getState();
  state.selectedMonth = '2026-11';
  const m = h.api.getMonth();
  state.plans.push({ from: '2026-12', budget: budgetWith(m.budget, 200), rules: copy(m.rules) });
  const december = h.api.getMonth('2026-12');
  december.prepared = true;
  december.done = { r: true, savings: true };
  state.months[december.key] = december;
  const january = h.api.getMonth('2027-01');
  january.prepared = january.closed = true;
  january.closing = { closingCA: 0, closingR: 0, savingsActual: 0 };
  state.months[january.key] = january;
  const closedSnapshot = JSON.stringify(january);
  editBudget(h, 300, 'future');
  h.api.saveBudget();
  assert.equal(E.calculate(h.api.getMonth('2026-12')).budgetTotal, 300);
  assert.equal(E.calculate(h.api.getMonth('2027-02')).budgetTotal, 300);
  assert.equal(state.plans.some(p => p.from === '2026-12'), false);
  assert.equal(december.done.r, false);
  assert.equal(december.done.savings, false);
  assert.equal(JSON.stringify(january), closedSnapshot);
});

test('imported identifiers cannot inject HTML attributes', () => {
  const h = boot();
  const data = copy(h.api.getState());
  data.plans[0].budget[0].id = 'x" onmouseover="alert(1)';
  assert.throws(() => h.api.validateState(data), /Dépense invalide/);
  // Rendering also escapes identifiers as defense in depth.
  h.api.setState(data);
  h.api.navigate('budget');
  assert.equal(h.element('#app').innerHTML.includes('data-row="x" onmouseover='), false);
  assert.match(h.element('#app').innerHTML, /data-row="x&amp;quot;|data-row="x&quot;/);
});

test('failed saving is visible, cannot claim success, and can be retried', () => {
  const h = boot();
  h.control.failSave = true;
  editBudget(h, 350);
  h.api.saveBudget();
  assert.equal(h.control.writeCount, 0);
  assert.equal(h.api.flags().saveFailed, true);
  assert.equal(h.api.flags().dirty, true);
  assert.match(h.element('#toast').textContent, /Sauvegarde impossible/);
  assert.match(h.element('#app').innerHTML, /dernières modifications ne sont pas sauvegardées/);
  assert.doesNotMatch(h.element('#toast').textContent, /Budget enregistré/);
  h.control.failSave = false;
  h.api.saveBudget();
  assert.equal(h.api.flags().saveFailed, false);
  assert.equal(h.api.flags().dirty, false);
  assert.equal(h.control.writeCount, 1);
  assert.match(h.element('#toast').textContent, /Budget enregistré/);
  assert.doesNotMatch(h.element('#app').innerHTML, /dernières modifications ne sont pas sauvegardées/);
});

test('another tab changing storage blocks writes, including export metadata and import', async () => {
  const h = boot();
  const incoming = JSON.stringify({ changedInAnotherTab: true });
  h.storage.set(KEY, incoming);
  h.events.storage({ key: KEY });
  assert.equal(h.api.flags().storageConflict, true);
  await h.api.action('theme', {});
  h.api.changeMonth('2026-12');
  editBudget(h, 450);
  h.api.saveBudget();
  h.api.exportData();
  h.api.setPendingImport(copy(h.api.getState()));
  await h.api.action('confirm-import', {});
  assert.equal(h.storage.get(KEY), incoming);
  assert.equal(h.control.writeCount, 0);
  assert.equal(h.api.getState().settings.theme, 'light');
  assert.match(h.element('#app').innerHTML, /lecture seule/);
});

test('a storage change while demo is open still protects real data when returning', () => {
  const h = boot();
  h.api.startDemo();
  const incoming = '{new other-tab data}';
  h.storage.set(KEY, incoming);
  h.events.storage({ key: KEY });
  h.api.leaveDemo();
  h.api.changeMonth('2027-01');
  assert.equal(h.api.flags().storageConflict, true);
  assert.equal(h.storage.get(KEY), incoming);
  assert.match(h.element('#app').innerHTML, /lecture seule/);
});

test('a failed import leaves the current state and stored backup intact', async () => {
  const h = boot();
  const before = h.api.getState();
  const raw = JSON.stringify(before);
  h.storage.set(KEY, raw);
  const imported = copy(before);
  imported.settings.goal = 6000;
  h.api.setPendingImport(imported);
  h.control.failSave = true;
  await h.api.action('confirm-import', {});
  assert.equal(h.api.getState(), before);
  assert.equal(h.storage.get(KEY), raw);
  assert.equal(h.api.flags().saveFailed, true);
  assert.doesNotMatch(h.element('#toast').textContent, /Sauvegarde importée/);
  h.control.failSave = false;
  await h.api.action('confirm-import', {});
  assert.equal(h.api.getState().settings.goal, 6000);
  assert.equal(JSON.parse(h.storage.get(KEY)).settings.goal, 6000);
});

test('failed reset preserves unreadable recoverable data; successful explicit reset replaces it', async () => {
  const raw = '{recover me}';
  const h = boot(raw);
  h.element('#reset-word').value = 'EFFACER';
  h.control.failSave = true;
  await h.api.action('reset', {});
  assert.equal(h.storage.get(KEY), raw);
  assert.equal(h.api.flags().loadError, true);
  h.control.failSave = false;
  await h.api.action('reset', {});
  assert.equal(h.api.flags().loadError, false);
  assert.equal(JSON.parse(h.storage.get(KEY)).version, 1);
});

test('preparing an underfunded month reports the shortfall instead of claiming it is ready', () => {
  const h = boot();
  const m = h.api.getMonth();
  m.budget = budgetWith(m.budget, 200);
  h.api.getState().months[m.key] = m;
  monthFields(h, { salary: 100 });
  h.api.saveMonth();
  assert.equal(h.api.calc(h.api.getMonth()).funded, false);
  assert.match(h.element('#toast').textContent, /à financer/);
  assert.doesNotMatch(h.element('#toast').textContent, /mois est prêt/);
});

test('invalid month input does not save and exact salary inclusion remains supported', () => {
  const h = boot();
  monthFields(h, { salary: 100.001 });
  h.api.saveMonth();
  assert.equal(h.control.writeCount, 0);
  monthFields(h, { salary: 3000, openingCA: 3400, openingR: 200, salaryIncluded: true, savingsOpening: 1000 });
  h.api.saveMonth();
  assert.equal(h.control.writeCount, 1);
  assert.equal(h.api.calc(h.api.getMonth()).openingTotal, 600);
});

test('marked transfers are retained and only the adjustment remains after a budget change', async () => {
  const h=boot();
  const m=h.api.getMonth();m.prepared=true;m.salary=3000;m.openingCA=450;m.openingR=150;m.savingsOpening=4800;
  m.budget.forEach((b,i)=>b.amount=i===0?1500:i===4?700:0);
  h.api.getState().months[m.key]=m;
  assert.equal(h.api.operation(m,'r').remaining,662);
  await h.api.action('toggle-done',{dataset:{id:'r'}});
  await h.api.action('toggle-done',{dataset:{id:'savings'}});
  assert.equal(m.executed.r,662);assert.equal(m.executed.savings,640);
  assert.equal(h.api.operation(m,'r').remaining,0);
  const next=copy(m.budget);next[4].amount=800;
  h.api.setDraft({key:m.key,budget:next,rules:copy(m.rules)});
  h.element('#budget-scope').value='month';h.api.saveBudget();
  const updated=h.api.getMonth();
  assert.equal(h.api.operation(updated,'r').remaining,86);
  assert.equal(h.api.operation(updated,'savings').remaining,-80);
  assert.match(h.element('#app').innerHTML,/Ajuster depuis le Livret A/);
  await h.api.action('toggle-done',{dataset:{id:'r'}});
  await h.api.action('toggle-done',{dataset:{id:'savings'}});
  assert.equal(h.api.operation(h.api.getMonth(),'r').remaining,0);
  assert.equal(h.api.operation(h.api.getMonth(),'savings').remaining,0);
  assert.doesNotThrow(()=>h.api.validateState(h.api.getState()));
  const reloaded=boot(h.storage.get(KEY));
  assert.equal(reloaded.api.operation(reloaded.api.getMonth(),'r').remaining,0);
});

test('import rejects malformed executed transfer amounts',()=>{
  const h=boot(),m=h.api.getMonth();m.prepared=true;m.executed={r:NaN,savings:0};h.api.getState().months[m.key]=m;
  assert.throws(()=>h.api.validateState(h.api.getState()),/virements invalide/);
  m.executed={r:0,savings:-1};assert.throws(()=>h.api.validateState(h.api.getState()),/virements invalide/);
});


function preparedSource(h, key = '2026-11') {
  const state=h.api.getState();state.selectedMonth=key;
  const m=h.api.getMonth();m.prepared=true;m.salary=3000;m.openingCA=450;m.openingR=150;m.savingsOpening=4800;
  m.budget.forEach((b,i)=>b.amount=i===0?1500:i===4?700:0);
  state.months[key]=m;
  state.plans=[{from:'1900-01',confirmed:true,budget:copy(m.budget),rules:copy(m.rules)}];
  return m;
}

function saveAutomaticMonth(h,key,salary=3000) {
  h.api.changeMonth(key);
  monthFields(h,{salary,openingCA:0,openingR:0,savingsOpening:0});
  h.element('[name=carryBuffer]').checked=true;
  h.element('[name=carrySavings]').checked=true;
  h.api.saveMonth();
  return h.api.getMonth();
}

test('a month before closure visibly carries both balances and saves the automatic links', async()=>{
  const h=boot();preparedSource(h);
  h.api.changeMonth('2026-12');
  assert.match(h.element('#app').innerHTML,/Reports de novembre 2026/);
  assert.match(h.element('#app').innerHTML,/Prévisionnels/);
  await h.api.action('prepare',{});
  assert.match(h.element('#dialog').innerHTML,/name="carryBuffer" checked/);
  assert.match(h.element('#dialog').innerHTML,/name="carrySavings" checked/);
  const m=saveAutomaticMonth(h,'2026-12');
  assert.equal(m.openingCA,648);assert.equal(m.openingR,0);
  assert.equal(m.savingsOpening,5440);
  assert.equal(h.api.calc(m).bufferEndPlan,696);
  assert.equal(h.api.calc(m).savingsProjected,6080);
  const reloaded=boot(h.storage.get(KEY));
  assert.equal(reloaded.api.getMonth().savingsOpening,5440);
  assert.equal(reloaded.api.calc(reloaded.api.getMonth()).openingTotal,648);
});

test('closing a predecessor refreshes prepared linked months and retains executed transfers', async()=>{
  const h=boot();preparedSource(h);saveAutomaticMonth(h,'2026-12');
  await h.api.action('toggle-done',{dataset:{id:'r'}});
  const paid=h.api.getMonth().executed.r;
  h.api.changeMonth('2026-11');
  closingFields(h,{closingCA:500,closingR:20,savingsActual:5300});h.api.saveClosing();
  const next=h.api.getMonth('2026-12');
  assert.equal(next.openingCA,500);assert.equal(next.openingR,20);assert.equal(next.savingsOpening,5300);
  assert.equal(next.executed.r,paid);
  assert.equal(h.api.operation(next,'r').remaining,-20);
  h.api.changeMonth('2026-12');
  assert.doesNotMatch(h.element('#app').innerHTML,/· prévisionnel/);
});

test('editing earlier salary updates all linked open months without accumulating twice',()=>{
  const h=boot();preparedSource(h);saveAutomaticMonth(h,'2026-12');saveAutomaticMonth(h,'2027-01');
  h.api.changeMonth('2026-11');
  monthFields(h,{salary:3200,openingCA:450,openingR:150,savingsOpening:4800});
  h.element('[name=carryBuffer]').checked=false;h.element('[name=carrySavings]').checked=false;h.api.saveMonth();
  assert.equal(h.api.getMonth('2026-12').savingsOpening,5600);
  assert.equal(h.api.getMonth('2027-01').savingsOpening,6240);
  assert.equal(h.api.calc(h.api.getMonth('2027-01')).openingTotal,708);
  for(let i=0;i<4;i++)h.api.changeMonth(i%2?'2027-01':'2026-12');
  assert.equal(h.api.calc(h.api.getMonth()).openingTotal,708);
});

test('manual correction can replace just the tampon while savings keep carrying',()=>{
  const h=boot();preparedSource(h);h.api.changeMonth('2026-12');
  monthFields(h,{salary:3000,openingCA:3200,openingR:35,salaryIncluded:true,savingsOpening:0});
  h.element('[name=carryBuffer]').checked=false;h.element('[name=carrySavings]').checked=true;
  h.api.saveMonth();
  const next=h.api.getMonth();
  assert.equal(h.api.calc(next).openingTotal,235);assert.equal(next.savingsOpening,5440);
  h.api.getState().months['2026-11'].savingsOpening=4900;
  assert.equal(h.api.getMonth().savingsOpening,5540);
  assert.equal(h.api.calc(h.api.getMonth()).openingTotal,235);
});

test('imports reject malformed carry modes while legacy backups still load',()=>{
  const h=boot();const m=preparedSource(h);
  assert.doesNotThrow(()=>h.api.validateState(h.api.getState()));
  m.carry={buffer:'true',savings:true};
  assert.throws(()=>h.api.validateState(h.api.getState()),/Reports mensuels invalides/);
});

const salaryPlan=()=>({kind:'marge-income-plan',version:1,months:{
  '2026-11':{salary:2750,sourcePayroll:'2026-10',estimated:false},
  '2026-12':{salary:3100,sourcePayroll:'2025-11',estimated:true},
  '2027-01':{salary:2450,sourcePayroll:'2025-12',estimated:true}
}});

test('salary import merges only the calendar, preserves real months and yields linked estimates',()=>{
  const h=boot();preparedSource(h);const before=JSON.stringify(h.api.getState().months);
  h.api.showIncomeImport(salaryPlan());h.api.importIncomePlan();
  assert.equal(JSON.stringify(h.api.getState().months),before);
  assert.equal(h.api.getMonth('2026-11').salary,3000);
  const dec=h.api.getMonth('2026-12'),jan=h.api.getMonth('2027-01');
  assert.equal(dec.salary,3100);assert.equal(dec.forecast,true);
  assert.equal(dec.savingsOpening,5440);assert.equal(h.api.calc(dec).savingsAdd,720);
  assert.equal(jan.savingsOpening,6160);assert.equal(jan.salary,2450);
  assert.match(h.element('#app').innerHTML,/La suite/);
  assert.match(h.element('#app').innerHTML,/Revenu estimé/);
  const reloaded=boot(h.storage.get(KEY));assert.equal(reloaded.api.getMonth('2027-01').savingsOpening,6160);
});

test('salary import without a starting month pre-fills income without inventing savings',()=>{
  const h=boot();h.api.showIncomeImport(salaryPlan());h.api.importIncomePlan();
  assert.equal(h.api.getMonth('2026-11').salary,2750);
  assert.equal(h.api.getMonth('2026-11').prepared,false);
  assert.equal(h.api.getMonth('2027-01').prepared,false);
  assert.match(h.element('#app').innerHTML,/Renseigne d’abord ton point de départ/);
  assert.equal(Object.keys(h.api.getState().months).length,0);
});

test('confirming a forecast month replaces only its income estimate with entered income',()=>{
  const h=boot();preparedSource(h);h.api.showIncomeImport(salaryPlan());h.api.importIncomePlan();
  saveAutomaticMonth(h,'2026-12',3250);
  assert.equal(h.api.getMonth().forecast,false);assert.equal(h.api.getMonth().salary,3250);
  assert.equal(h.api.getMonth('2027-01').savingsOpening,6280);
  h.api.showIncomeImport(salaryPlan());h.api.importIncomePlan();
  assert.equal(h.api.getMonth('2026-12').salary,3250);
});

test('invalid or failed salary import cannot change stored months or income plan',()=>{
  const h=boot();preparedSource(h);const before=JSON.stringify(h.api.getState());
  const invalid=salaryPlan();invalid.months['2026-12'].sourcePayroll='2025-12';
  assert.throws(()=>h.api.showIncomeImport(invalid),/suivre le mois de paie/);
  h.api.showIncomeImport(salaryPlan());h.control.failSave=true;h.api.importIncomePlan();
  assert.equal(JSON.stringify(h.api.getState()),before);
});

test('re-import updates an unconfirmed income forecast without replacing its custom budget',()=>{
  const h=boot();preparedSource(h);h.api.showIncomeImport(salaryPlan());h.api.importIncomePlan();
  h.api.changeMonth('2026-12');editBudget(h,2100);h.api.saveBudget();
  assert.equal(h.api.getMonth().forecast,true);
  const updated=salaryPlan();updated.months['2026-12'].salary=4000;
  h.api.showIncomeImport(updated);h.api.importIncomePlan();
  const dec=h.api.getMonth('2026-12');
  assert.equal(dec.salary,4000);assert.equal(h.api.calc(dec).budgetTotal,2100);
  assert.equal(dec.salaryReference.salary,4000);
});

test('a customized future forecast does not prevent reopening its real predecessor',async()=>{
  const h=boot();const nov=preparedSource(h);nov.closed=true;nov.closing={closingCA:500,closingR:20,savingsActual:5300};
  h.api.showIncomeImport(salaryPlan());h.api.importIncomePlan();h.api.changeMonth('2026-12');
  editBudget(h,2100);h.api.saveBudget();
  assert.equal(h.api.getMonth().forecast,true);
  h.api.changeMonth('2026-11');await h.api.action('show-closing',{});
  assert.match(h.element('#dialog').innerHTML,/data-action="reopen"/);
  await h.api.action('reopen',{});
  assert.equal(h.api.getMonth().closed,false);
  assert.equal(h.api.getMonth('2026-12').savingsOpening,5440);
});


test('PWA updates pause during a dialog or dirty budget and resume after saving', async () => {
  const h=boot();
  assert.equal(h.control.pwaBusy,false);
  await h.api.action('prepare',{});
  assert.equal(h.control.pwaBusy,true);
  await h.api.action('close-dialog',{});
  assert.equal(h.control.pwaBusy,false);
  await h.api.action('budget',{});
  await h.api.action('add-line',{dataset:{account:'ca'}});
  assert.equal(h.control.pwaBusy,true);
  editBudget(h,100);
  h.api.saveBudget();
  assert.equal(h.control.pwaBusy,false);
});

test('PWA reload stays blocked after storage errors or another tab changes data', async () => {
  const h=boot();
  h.control.failSave=true;
  editBudget(h,100);
  h.api.saveBudget();
  assert.equal(h.control.pwaBusy,true);
  h.control.failSave=false;
  h.api.saveBudget();
  assert.equal(h.control.pwaBusy,false);
  h.events.storage({key:KEY});
  assert.equal(h.control.pwaBusy,true);
  const broken=boot('{broken');
  assert.equal(broken.control.pwaBusy,true);
});
