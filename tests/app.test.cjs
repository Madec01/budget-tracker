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
  action,navigate,exportData,startDemo,leaveDemo,showIncomeImport,importIncomePlan,
  checkpointDialog,saveCheckpoint,checkpointEligible,render
};
render();
})();`);

function boot(raw = null) {
  const nodes = new Map();
  const storage = new Map(raw === null ? [] : [[KEY, raw]]);
  const events = {};
  const control = { failSave: false, writeCount: 0, downloads: 0, downloadedBlobs: [], pwaBusy: null };
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
    URL: { createObjectURL(blob) { control.downloads += 1; control.downloadedBlobs.push(blob); return 'blob:test'; }, revokeObjectURL() {} },
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


// Checkpoints are observations of the current month, not changes to its plan.
const localDateKey = date => `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
function checkpointFixture(h, monthOffset = 0) {
  const now=new Date(),date=new Date(now.getFullYear(),now.getMonth()+monthOffset,15);
  const key=localDateKey(date).slice(0,7),state=h.api.getState();
  state.selectedMonth=key;
  const m=h.api.getMonth();
  Object.assign(m,{prepared:true,closed:false,forecast:false,salary:3000,openingCA:450,openingR:150,salaryIncluded:false,savingsOpening:4800,budgetConfirmed:true,carry:{buffer:false,savings:false},executed:{r:662,savings:640}});
  m.budget.forEach((b,i)=>b.amount=i===0?1500:i===4?700:0);
  state.months[key]=m;
  state.plans=[{from:'1900-01',confirmed:true,budget:copy(m.budget),rules:copy(m.rules)}];
  return m;
}
function checkpointFields(h,ca,r) {
  h.element('[name="checkpointCA"]').value=String(ca);
  h.element('[name="checkpointR"]').value=String(r);
}
function checkpointConfirmations(h,r=false,savings=false) {
  h.element('[name="checkpoint-transfer-r"]').checked=r;
  h.element('[name="checkpoint-transfer-savings"]').checked=savings;
}
const money = value => new Intl.NumberFormat('fr-FR',{style:'currency',currency:'EUR',maximumFractionDigits:2}).format(value);

test('legacy exports without checkpoints remain readable and editable',()=>{
  const h=boot(),m=checkpointFixture(h);
  delete m.checkpoints;delete m.checkpointTransfers;
  assert.equal(m.checkpoints,undefined);
  assert.equal(m.checkpointTransfers,undefined);
  const restored=boot(JSON.stringify(h.api.getState()));
  assert.equal(restored.api.flags().loadError,false);
  assert.equal(restored.api.getMonth().salary,3000);
  assert.doesNotThrow(()=>restored.api.validateState(restored.api.getState()));
  assert.equal(restored.api.checkpointEligible(restored.api.getMonth()),true);
});

test('recording today keeps salary, opening balances, allocations and subsequent reports unchanged',async()=>{
  const h=boot(),m=checkpointFixture(h),key=m.key;
  const nextDate=new Date(Number(key.slice(0,4)),Number(key.slice(5)),1),nextKey=localDateKey(nextDate).slice(0,7);
  const before=copy(m),nextBefore=copy(h.api.getMonth(nextKey));
  await h.api.action('checkpoint',{});
  assert.match(h.element('#dialog').innerHTML,/name="checkpointCA"/);
  assert.match(h.element('#dialog').innerHTML,/name="checkpointR"/);
  checkpointFields(h,1234.56,-12.34);
  await h.api.action('save-checkpoint',{});
  const after=h.api.getMonth();
  assert.deepEqual(copy(after.checkpoints),[{date:localDateKey(new Date()),balanceCA:1234.56,balanceR:-12.34}]);
  assert.deepEqual(copy(after.checkpointTransfers),{[localDateKey(new Date())]:{r:662,savings:640}});
  for(const prop of ['salary','openingCA','openingR','savingsOpening','salaryIncluded','carry','budget','rules','executed']) assert.deepEqual(copy(after[prop]),before[prop],prop);
  assert.deepEqual(copy(h.api.getMonth(nextKey)),nextBefore);
  assert.equal(h.control.writeCount,1);
  assert.doesNotThrow(()=>h.api.validateState(h.api.getState()));
});

test('a second observation today replaces the previous one and its transfer snapshot',async()=>{
  const h=boot();checkpointFixture(h);
  await h.api.action('checkpoint',{});checkpointFields(h,1400,500);
  await h.api.action('save-checkpoint',{});
  h.api.getState().months[h.api.getState().selectedMonth].executed={r:700,savings:660};
  await h.api.action('checkpoint',{});checkpointFields(h,1350.5,480.25);
  await h.api.action('save-checkpoint',{});
  const m=h.api.getMonth();
  assert.equal(m.checkpoints.length,1);
  assert.deepEqual(copy(m.checkpoints[0]),{date:localDateKey(new Date()),balanceCA:1350.5,balanceR:480.25});
  assert.equal(Object.keys(m.checkpointTransfers).length,1);
  assert.deepEqual(copy(m.checkpointTransfers[localDateKey(new Date())]),{r:700,savings:660});
});

test('checkpoint observations and snapshots survive a real JSON export and import roundtrip',async()=>{
  const h=boot();checkpointFixture(h);
  await h.api.action('checkpoint',{});checkpointFields(h,980.75,260.99);
  await h.api.action('save-checkpoint',{});
  const snapshot=copy(h.api.getMonth());
  h.api.exportData();
  const raw=await h.control.downloadedBlobs.at(-1).text();
  const imported=boot();
  const input=imported.element('#import-file');
  await input.listeners.change({target:{files:[{size:Buffer.byteLength(raw),text:async()=>raw}],value:'checkpoint.json'}});
  await imported.api.action('confirm-import',{});
  assert.deepEqual(copy(imported.api.getMonth().checkpoints),snapshot.checkpoints);
  assert.deepEqual(copy(imported.api.getMonth().checkpointTransfers),snapshot.checkpointTransfers);
  const reloaded=boot(imported.storage.get(KEY));
  assert.equal(reloaded.api.flags().loadError,false);
  assert.deepEqual(copy(reloaded.api.getMonth().checkpoints),snapshot.checkpoints);
  assert.deepEqual(copy(reloaded.api.getMonth().checkpointTransfers),snapshot.checkpointTransfers);
});

test('checkpoint validation rejects impossible dates, injected strings, invalid money and orphan snapshots',()=>{
  const h=boot();checkpointFixture(h);
  const base=copy(h.api.getState()),key=base.selectedMonth,validDate=localDateKey(new Date());
  const cases=[
    {date:key+'-32',balanceCA:10,balanceR:20},
    {date:validDate+'"><img src=x onerror=alert(1)>',balanceCA:10,balanceR:20},
    {date:validDate,balanceCA:'<svg onload=alert(1)>',balanceR:20},
    {date:validDate,balanceCA:NaN,balanceR:20},
    {date:validDate,balanceCA:10,balanceR:Infinity},
    {date:validDate,balanceCA:10.001,balanceR:20},
    {date:validDate,balanceCA:1000000000.01,balanceR:20}
  ];
  for(const point of cases){const data=copy(base);data.months[key].checkpoints=[point];assert.throws(()=>h.api.validateState(data));}
  const orphan=copy(base);orphan.months[key].checkpoints=[];orphan.months[key].checkpointTransfers={[validDate]:{r:10,savings:20}};
  assert.throws(()=>h.api.validateState(orphan));
  const tooMany=copy(base);tooMany.months[key].checkpoints=Array.from({length:94},()=>({date:validDate,balanceCA:1,balanceR:2}));
  assert.throws(()=>h.api.validateState(tooMany));
});

test('invalid checkpoint form values do not save or inject markup into the view',async()=>{
  const h=boot();checkpointFixture(h);
  await h.api.action('checkpoint',{});
  for(const value of ['100.001','Infinity','<img src=x onerror=alert(1)>']){
    checkpointFields(h,value,50);
    await h.api.action('save-checkpoint',{});
    assert.equal(h.control.writeCount,0);
    assert.equal((h.api.getMonth().checkpoints||[]).length,0);
    assert.doesNotMatch(h.element('#app').innerHTML,/<img src=x/);
    assert.doesNotMatch(h.element('#dialog').innerHTML,/<img src=x/);
  }
});

test('closed, past, future, forecast and unprepared months cannot record current-day observations',async()=>{
  for(const mode of ['closed','past','future','forecast','unprepared']){
    const h=boot(),m=checkpointFixture(h,mode==='past'?-1:mode==='future'?1:0);
    if(mode==='closed'){m.closed=true;m.closing={closingCA:500,closingR:20,savingsActual:5440};}
    if(mode==='forecast')m.forecast=true;
    if(mode==='unprepared')m.prepared=false;
    assert.equal(h.api.checkpointEligible(m),false,mode);
    const before=JSON.stringify(h.api.getState());
    await h.api.action('checkpoint',{});checkpointFields(h,100,20);
    await h.api.action('save-checkpoint',{});
    assert.equal(JSON.stringify(h.api.getState()),before,mode);
    assert.equal(h.control.writeCount,0,mode);
  }
});

test('checkpoint save failure remains visible and prevents automatic PWA reload',async()=>{
  const h=boot();checkpointFixture(h);
  const stored=JSON.stringify(h.api.getState());h.storage.set(KEY,stored);
  await h.api.action('checkpoint',{});checkpointFields(h,100,20);
  h.control.failSave=true;
  await h.api.action('save-checkpoint',{});
  assert.equal(h.storage.get(KEY),stored);
  assert.equal(h.api.flags().saveFailed,true);
  assert.equal(h.control.pwaBusy,true);
  assert.match(h.element('#toast').textContent,/Sauvegarde impossible/);
  assert.doesNotMatch(h.element('#toast').textContent,/pointage enregistré|soldes enregistrés/i);
});

test('another tab changing storage blocks checkpoint edits without overwriting it',async()=>{
  const h=boot();checkpointFixture(h);
  await h.api.action('checkpoint',{});checkpointFields(h,100,20);
  const incoming=JSON.stringify({otherTab:'new financial data'});h.storage.set(KEY,incoming);h.events.storage({key:KEY});
  const before=JSON.stringify(h.api.getState());
  await h.api.action('save-checkpoint',{});
  assert.equal(h.storage.get(KEY),incoming);
  assert.equal(JSON.stringify(h.api.getState()),before);
  assert.equal(h.control.writeCount,0);
  assert.equal(h.control.pwaBusy,true);
});

test('a new month starts with an empty checkpoint history and never inherits prior observations',async()=>{
  const h=boot(),m=checkpointFixture(h);
  await h.api.action('checkpoint',{});checkpointFields(h,1000,300);
  await h.api.action('save-checkpoint',{});
  const nextDate=new Date(Number(m.key.slice(0,4)),Number(m.key.slice(5)),1);
  const next=h.api.getMonth(localDateKey(nextDate).slice(0,7));
  assert.deepEqual(copy(next.checkpoints),[]);
  assert.equal(Object.keys(next.checkpointTransfers||{}).length,0);
  assert.equal(h.api.getMonth(m.key).checkpoints.length,1);
});

test('reading a closed historical month preserves its checkpoint metadata unchanged',()=>{
  const h=boot(),m=checkpointFixture(h,-1),date=m.key+'-15';
  m.checkpoints=[{date,balanceCA:1100.12,balanceR:340.56}];
  m.checkpointTransfers={[date]:{r:662,savings:640}};
  m.closed=true;m.closing={closingCA:500,closingR:20,savingsActual:5440};
  const raw=JSON.stringify(h.api.getState()),restored=boot(raw);
  assert.equal(restored.api.flags().loadError,false);
  const original=JSON.stringify(restored.api.getState().months[m.key]);
  restored.api.render();restored.api.getMonth(m.key);restored.api.navigate('budget');
  assert.equal(JSON.stringify(restored.api.getState().months[m.key]),original);
  assert.equal(restored.control.writeCount,0);
  assert.equal(restored.storage.get(KEY),raw);
  assert.deepEqual(copy(restored.api.getMonth().checkpointTransfers),{[date]:{r:662,savings:640}});
});

test('checkpoint confirmations start unchecked and live previews never mutate balances or transfers',async()=>{
  const h=boot(),m=checkpointFixture(h);
  m.executed={r:0,savings:0};m.done={r:false,savings:false};
  const before=JSON.stringify(h.api.getState());
  await h.api.action('checkpoint',{});
  const inputs=h.element('#dialog').innerHTML.match(/<input[^>]*name="checkpoint-transfer-(?:r|savings)"[^>]*>/g);
  assert.equal(inputs.length,2);
  for(const input of inputs)assert.doesNotMatch(input,/\bchecked\b/);
  assert.equal(JSON.stringify(h.api.getState()),before);
  checkpointFields(h,1948,612);
  const dialog=h.element('#dialog');
  dialog.listeners.input({target:h.element('[name="checkpointCA"]')});
  assert.ok(h.element('#checkpoint-preview').innerHTML.includes(money(1502)));
  assert.ok(h.element('#checkpoint-preview').innerHTML.includes(`+ ${money(462)} entrants`));
  checkpointConfirmations(h,true,true);
  dialog.listeners.input({target:h.element('[name="checkpoint-transfer-r"]')});
  const confirmedPreview=h.element('#checkpoint-preview').innerHTML;
  assert.equal(confirmedPreview.split(`<strong>${money(200)}</strong>`).length-1,2);
  checkpointFields(h,1848,612);
  dialog.listeners.input({target:h.element('[name="checkpointCA"]')});
  assert.ok(h.element('#checkpoint-preview').innerHTML.includes(`<strong>${money(300)}</strong>`));
  assert.equal(JSON.stringify(h.api.getState()),before);
  assert.equal(h.control.writeCount,0);
  await h.api.action('close-dialog',{});
  assert.equal(JSON.stringify(h.api.getState()),before);
  assert.equal(h.control.writeCount,0);
});

test('confirmed transfers are excluded from spending and persist with the checkpoint in one save',async()=>{
  const h=boot(),m=checkpointFixture(h);
  m.executed={r:0,savings:0};m.done={r:false,savings:false};
  const before=copy(m),date=localDateKey(new Date());
  await h.api.action('checkpoint',{});checkpointFields(h,1948,612);checkpointConfirmations(h,true,true);
  await h.api.action('save-checkpoint',{});
  const saved=h.api.getMonth(),tracking=E.checkpointTracking(saved);
  assert.deepEqual(copy(saved.executed),{r:662,savings:640});
  assert.deepEqual(copy(saved.done),{r:true,savings:true});
  assert.deepEqual(copy(saved.checkpointTransfers),{[date]:{r:662,savings:640}});
  assert.equal(tracking.accounts.ca.spent,200);
  assert.equal(tracking.accounts.r.spent,200);
  for(const prop of ['salary','openingCA','openingR','savingsOpening','salaryIncluded','carry','budget','rules'])assert.deepEqual(copy(saved[prop]),before[prop],prop);
  assert.equal(h.control.writeCount,1);
  const reloaded=boot(h.storage.get(KEY));
  assert.equal(reloaded.api.flags().loadError,false);
  assert.deepEqual(copy(reloaded.api.getMonth().executed),{r:662,savings:640});
  assert.deepEqual(copy(reloaded.api.getMonth().checkpointTransfers),{[date]:{r:662,savings:640}});
  assert.equal(E.checkpointTracking(reloaded.api.getMonth()).accounts.ca.spent,200);
});

test('confirming only Revolut leaves the Livret A movement unrecorded',async()=>{
  const h=boot(),m=checkpointFixture(h);
  m.executed={r:0,savings:0};m.done={r:false,savings:false};
  await h.api.action('checkpoint',{});checkpointFields(h,1948,612);checkpointConfirmations(h,true,false);
  await h.api.action('save-checkpoint',{});
  const saved=h.api.getMonth(),tracking=E.checkpointTracking(saved);
  assert.deepEqual(copy(saved.executed),{r:662,savings:0});
  assert.deepEqual(copy(saved.done),{r:true,savings:false});
  assert.deepEqual(copy(saved.checkpointTransfers[localDateKey(new Date())]),{r:662,savings:0});
  assert.equal(tracking.accounts.ca.spent,840);
  assert.equal(tracking.accounts.r.spent,200);
});

test('repairing a checkpoint keeps its original date, balances and earlier history',async()=>{
  const h=boot(),m=checkpointFixture(h),early=m.key+'-01T08:30:00Z',last=m.key+'-01T09:30:00Z';
  m.executed={r:0,savings:0};m.done={r:false,savings:false};
  m.checkpoints=[{date:early,balanceCA:3440,balanceR:140},{date:last,balanceCA:1948,balanceR:612}];
  m.checkpointTransfers={[early]:{r:0,savings:0},[last]:{r:0,savings:0}};
  const points=copy(m.checkpoints),before=copy(m),stateBefore=JSON.stringify(h.api.getState());
  await h.api.action('repair-checkpoint',{});
  const html=h.element('#dialog').innerHTML;
  assert.match(html,/Vérifier ce relevé/);
  for(const name of ['checkpointCA','checkpointR'])assert.match(html,new RegExp(`<input[^>]*name="${name}"[^>]*disabled`));
  assert.equal(JSON.stringify(h.api.getState()),stateBefore);
  checkpointFields(h,1,2); // Even a forged disabled input cannot replace the saved balances.
  checkpointConfirmations(h,true,true);
  await h.api.action('save-checkpoint',{});
  const saved=h.api.getMonth();
  assert.deepEqual(copy(saved.checkpoints),points);
  assert.deepEqual(copy(saved.checkpointTransfers[early]),{r:0,savings:0});
  assert.deepEqual(copy(saved.checkpointTransfers[last]),{r:662,savings:640});
  assert.deepEqual(copy(saved.executed),{r:662,savings:640});
  for(const prop of ['salary','openingCA','openingR','savingsOpening','carry','budget','rules'])assert.deepEqual(copy(saved[prop]),before[prop],prop);
  assert.equal(E.checkpointTracking(saved).accounts.ca.spent,200);
  assert.equal(E.checkpointTracking(saved).accounts.r.spent,200);
  assert.match(h.element('#toast').textContent,/Relevé corrigé/);
});

test('a movement marked after a checkpoint changes its snapshot only with explicit repair confirmation',async()=>{
  const h=boot(),m=checkpointFixture(h),date=m.key+'-01T09:30:00Z';
  m.executed={r:0,savings:0};m.done={r:false,savings:false};
  m.checkpoints=[{date,balanceCA:1948,balanceR:612}];
  m.checkpointTransfers={[date]:{r:0,savings:0}};
  const originalPoints=copy(m.checkpoints),originalTracking=E.checkpointTracking(m);
  await h.api.action('toggle-done',{dataset:{id:'r'}});
  assert.deepEqual(copy(h.api.getMonth().executed),{r:662,savings:0});
  assert.deepEqual(copy(h.api.getMonth().checkpointTransfers[date]),{r:0,savings:0});
  assert.equal(E.checkpointTracking(h.api.getMonth()).accounts.ca.spent,originalTracking.accounts.ca.spent);
  await h.api.action('repair-checkpoint',{});
  assert.match(h.element('#dialog').innerHTML,/Déjà pointé : effectué avant ce relevé/);
  checkpointConfirmations(h,false,false);
  await h.api.action('save-checkpoint',{});
  assert.deepEqual(copy(h.api.getMonth().checkpointTransfers[date]),{r:0,savings:0});
  assert.deepEqual(copy(h.api.getMonth().executed),{r:662,savings:0});
  assert.deepEqual(copy(h.api.getMonth().checkpoints),originalPoints);
  await h.api.action('repair-checkpoint',{});checkpointConfirmations(h,true,false);
  await h.api.action('save-checkpoint',{});
  const saved=h.api.getMonth();
  assert.deepEqual(copy(saved.checkpoints),originalPoints);
  assert.deepEqual(copy(saved.checkpointTransfers[date]),{r:662,savings:0});
  assert.deepEqual(copy(saved.executed),{r:662,savings:0});
  assert.equal(E.checkpointTracking(saved).accounts.r.spent,200);
});

test('loading legacy checkmarks freezes their amounts before a later budget edit',()=>{
  const initial=boot(),m=checkpointFixture(initial);
  delete m.executed;m.done={r:true,savings:true};
  const raw=JSON.stringify(initial.api.getState()),h=boot(raw);
  assert.equal(h.api.flags().loadError,false);
  assert.deepEqual(copy(h.api.getMonth().executed),{r:662,savings:640});
  assert.equal(h.storage.get(KEY),raw);
  assert.equal(h.control.writeCount,0);
  editBudget(h,1400);h.api.saveBudget();
  const edited=h.api.getMonth(),plan=h.api.calc(edited);
  assert.deepEqual(copy(edited.executed),{r:662,savings:640});
  assert.notEqual(plan.transferR,662);
  assert.equal(h.api.operation(edited,'r').remaining,Math.round((plan.transferR-662)*100)/100);
  assert.equal(h.api.operation(edited,'savings').remaining,Math.round((plan.savingsAdd-640)*100)/100);
  assert.deepEqual(JSON.parse(h.storage.get(KEY)).months[m.key].executed,{r:662,savings:640});
});

test('importing legacy checkmarks materializes the original targets before changing the budget',async()=>{
  const initial=boot(),m=checkpointFixture(initial);
  delete m.executed;m.done={r:true,savings:true};
  const raw=JSON.stringify(initial.api.getState()),h=boot();
  await h.element('#import-file').listeners.change({target:{files:[{size:Buffer.byteLength(raw),text:async()=>raw}],value:'legacy.json'}});
  await h.api.action('confirm-import',{});
  assert.deepEqual(copy(h.api.getMonth().executed),{r:662,savings:640});
  assert.deepEqual(JSON.parse(h.storage.get(KEY)).months[m.key].executed,{r:662,savings:640});
  editBudget(h,1400);h.api.saveBudget();
  assert.deepEqual(copy(h.api.getMonth().executed),{r:662,savings:640});
  assert.equal(h.api.operation(h.api.getMonth(),'savings').paid,640);
});

test('explicit executed amounts take priority over old checkmarks on both load and import',async()=>{
  for(const route of ['load','import']){
    const initial=boot(),m=checkpointFixture(initial);
    m.executed={r:0,savings:123.45};m.done={r:true,savings:true};
    const raw=JSON.stringify(initial.api.getState()),h=boot(route==='load'?raw:null);
    if(route==='import'){
      await h.element('#import-file').listeners.change({target:{files:[{size:Buffer.byteLength(raw),text:async()=>raw}],value:'explicit.json'}});
      await h.api.action('confirm-import',{});
    }
    assert.equal(h.api.flags().loadError,false,route);
    assert.deepEqual(copy(h.api.getMonth().executed),{r:0,savings:123.45},route);
    editBudget(h,1400);h.api.saveBudget();
    assert.deepEqual(copy(h.api.getMonth().executed),{r:0,savings:123.45},route);
    assert.equal(h.api.operation(h.api.getMonth(),'r').paid,0,route);
    assert.equal(h.api.operation(h.api.getMonth(),'savings').paid,123.45,route);
  }
});

test('account cards show the latest observed balance and date separately from the monthly budget',()=>{
  const h=boot(),m=checkpointFixture(h),date=m.key+'-01T09:30:00Z';
  m.checkpoints=[{date,balanceCA:1234.56,balanceR:321.09}];
  m.checkpointTransfers={[date]:{r:662,savings:640}};
  h.api.render();
  const html=h.element('#app').innerHTML,label=new Date(`${date.slice(0,10)}T12:00:00`).toLocaleDateString('fr-FR',{day:'numeric',month:'long'}),plan=h.api.calc(m);
  for(const [id,balance,budget] of [['ca',1234.56,plan.availableCA],['r',321.09,plan.availableR]]){
    const card=html.match(new RegExp(`<article class="account-card ${id}">([\\s\\S]*?)<\\/article>`))?.[1];
    assert.ok(card,id);
    assert.ok(card.includes(`<strong class="account-balance">${money(balance)}<small>Solde relevé · ${label}</small>`),id);
    const budgetLine=card.match(/<div class="checkpoint-budget-line">([\s\S]*?)<\/div>/)?.[1];
    assert.ok(budgetLine,id);
    assert.match(budgetLine,/Budget alloué au mois/);
    assert.ok(budgetLine.includes(`<strong>${money(budget)}</strong>`),id);
  }
});
