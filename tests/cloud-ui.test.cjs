'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const UI = require('../dist/cloud-ui.js');
const Sync = require('../dist/cloud-sync.js');

const turn = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fixture(options = {}) {
  const calls = [], controls = { configured: options.configured !== false, changes: 0, loadTask: null, loginTask: null, logoutTask: null, authListener: null };
  let syncStatus = { phase: 'disconnected', user: null, dirty: false, conflict: null, remotePending: false,
    remoteRevision: null, remoteSummary: null, lastSynced: null, error: null };
  const controller = {
    getStatus: () => ({ ...syncStatus }),
    connect(user, adapter) { calls.push(['connect', user, adapter]); syncStatus = { ...syncStatus, user, phase: 'ready' }; },
    disconnect() { calls.push(['disconnect']); syncStatus = { ...syncStatus, user: null, phase: 'disconnected' }; },
    localChanged() { calls.push(['localChanged']); },
    resume() { calls.push(['resume']); },
    flush() { calls.push(['flush']); return Promise.resolve(true); },
    chooseLocal(revision) { calls.push(['chooseLocal', revision]); return Promise.resolve(true); },
    chooseRemote(revision) { calls.push(['chooseRemote', revision]); return true; },
    destroy() { calls.push(['destroy']); }
  };
  const client = {
    adapter: { identifier: 'synthetic-adapter' },
    signIn() { calls.push(['signIn']); return controls.loginTask?.promise || Promise.resolve(); },
    signOut() { calls.push(['signOut']); return controls.logoutTask?.promise || Promise.resolve(); },
    onUser(next, error) {
      calls.push(['onUser']); controls.authListener = { next, error };
      if (options.restoredUser !== undefined) next(options.restoredUser);
      return () => calls.push(['unsubscribe']);
    }
  };
  const firebase = {
    isConfigured(config) { calls.push(['isConfigured', config]); return controls.configured; },
    load(config) { calls.push(['load', config]); return controls.loadTask?.promise || Promise.resolve(client); },
    humanMessage(error) { return error?.code === 'unavailable' ? 'Connexion indisponible.' : 'Erreur contrôlée.'; }
  };
  const input = {
    firebase, config: { projectId: 'synthetic-project' }, protocol: options.protocol || 'https:',
    sync: { create(opts) { controls.syncOptions = opts; return controller; } },
    getData: () => ({ months: { '2026-11': {}, '2026-12': {} } }),
    onChange: () => controls.changes++
  };
  const ui = UI.create(input);
  return { ui, calls, controls, client, controller, firebase,
    status(value) { syncStatus = { ...syncStatus, ...value }; } };
}

test('unconfigured Firebase leaves a local-only panel and never loads the SDK', async () => {
  const h = fixture({ configured: false });
  await h.ui.start(); h.ui.retryOnline(); await turn();
  assert.equal(h.ui.status().phase, 'unconfigured');
  assert.equal(h.calls.filter(c => c[0] === 'load').length, 0);
  assert.equal(h.ui.isBusy(), false);
  assert.match(h.ui.panel(), /projet Firebase raccordé/);
  assert.match(h.ui.panel(), /export JSON reste disponible/);
  assert.doesNotMatch(h.ui.panel(), /data-action="cloud-login"/);
});

test('configured startup loads once, exposes loading, then binds restored Google identity', async () => {
  const user = { uid: 'synthetic-user', displayName: 'Example', email: 'example@example.test' };
  const h = fixture({ restoredUser: user }), load = deferred(); h.controls.loadTask = load;
  const startup = h.ui.start();
  assert.equal(h.ui.status().phase, 'connecting'); assert.equal(h.ui.isBusy(), true);
  assert.match(h.ui.panel(), /Préparation…/); assert.match(h.ui.panel(), /disabled/);
  await h.ui.start();
  assert.equal(h.calls.filter(c => c[0] === 'load').length, 1);
  load.resolve(h.client); await startup;
  assert.equal(h.ui.status().phase, 'ready');
  assert.deepEqual(h.calls.find(c => c[0] === 'connect'), ['connect', user, h.client.adapter]);
  await h.ui.start();
  assert.equal(h.calls.filter(c => c[0] === 'load').length, 1);
  assert.equal(h.ui.isBusy(), false);
});

test('file mode explains the hosted URL requirement without loading Firebase', async () => {
  const h = fixture({ protocol: 'file:' }); await h.ui.start();
  assert.equal(h.calls.some(c => c[0] === 'load'), false);
  assert.equal(h.ui.status().phase, 'error');
  assert.match(h.ui.panel(), /adresse GitHub Pages/);
});

test('failed loading preserves local use and an explicit retry can initialize later', async () => {
  const h = fixture(), load = deferred(); h.controls.loadTask = load;
  const startup = h.ui.start(); load.reject({ code: 'unavailable', message: 'Raw internal detail' }); await startup;
  assert.equal(h.ui.status().phase, 'error'); assert.equal(h.ui.isBusy(), false);
  assert.match(h.ui.panel(), /Connexion indisponible/);
  assert.doesNotMatch(h.ui.panel(), /Raw internal/);
  h.controls.loadTask = null;
  assert.equal(await h.ui.action('cloud-retry'), true);
  assert.equal(h.calls.filter(c => c[0] === 'load').length, 2);
  assert.equal(h.ui.status().phase, 'disconnected');
  assert.match(h.ui.panel(), /Se connecter avec Google/);
});

test('name, email and error content are escaped before entering the account panel', async () => {
  const h = fixture(); await h.ui.start();
  h.status({ phase: 'error', user: { uid: 'synthetic-user', displayName: '<img src=x onerror="attack()">', email: 'x&y<svg>@example.test' }, error: '<script>attack()</script>' });
  const panel = h.ui.panel();
  assert.match(panel, /&lt;img src=x onerror=&quot;attack\(\)&quot;&gt;/);
  assert.match(panel, /x&amp;y&lt;svg&gt;@example.test/);
  assert.match(panel, /&lt;script&gt;attack\(\)&lt;\/script&gt;/);
  assert.doesNotMatch(panel, /<img|<script|<svg>@/);
  assert.match(h.ui.badge(), /is-error/);
});

test('Google popup starts synchronously in the login action after preload and duplicate clicks are ignored', async () => {
  const h = fixture(); await h.ui.start(); h.controls.loginTask = deferred();
  const login = h.ui.action('cloud-login');
  assert.equal(h.calls.at(-1)[0], 'signIn', 'No preceding await loses the browser click gesture.');
  assert.equal(h.ui.isBusy(), true);
  assert.equal(await h.ui.action('cloud-login'), false);
  assert.equal(h.calls.filter(c => c[0] === 'signIn').length, 1);
  h.controls.loginTask.resolve(); assert.equal(await login, true);
  assert.equal(h.ui.isBusy(), false);
});

test('login errors are recoverable and do not expose the original SDK message', async () => {
  const h = fixture(); await h.ui.start(); h.controls.loginTask = deferred();
  const login = h.ui.action('cloud-login');
  h.controls.loginTask.reject({ code: 'auth/popup-blocked', message: 'Private SDK diagnostic' });
  assert.equal(await login, false);
  assert.equal(h.ui.status().phase, 'error');
  assert.match(h.ui.panel(), /Erreur contrôlée/);
  assert.doesNotMatch(h.ui.panel(), /Private SDK/);
  h.controls.loginTask = null;
  assert.equal(await h.ui.action('cloud-login'), true);
  assert.equal(h.ui.status().phase, 'disconnected');
});

test('conflict controls carry the reviewed revision and delegate decisions without an automatic choice', async () => {
  const h = fixture(); await h.ui.start();
  h.status({ phase: 'conflict', user: { uid: 'synthetic-user' }, conflict: { reason: 'first-connection' }, remoteRevision: 8,
    remoteSummary: { months: 3, updatedAt: 1700000000000 } });
  const panel = h.ui.panel();
  assert.match(panel, /Quelle sauvegarde utiliser/);
  assert.match(panel, /Cet appareil : 2 mois/);
  assert.match(panel, /Compte Google : 3 mois/);
  assert.match(panel, /data-action="cloud-use-remote" data-revision="8"/);
  assert.match(panel, /data-action="cloud-use-local" data-revision="8"/);
  assert.match(panel, /Exporter cet appareil/);
  assert.equal(h.calls.some(c => c[0] === 'chooseLocal' || c[0] === 'chooseRemote' || c[0] === 'flush'), false);
  assert.equal(await h.ui.action('cloud-use-remote', 8), true);
  assert.deepEqual(h.calls.at(-1), ['chooseRemote', 8]);
  assert.equal(await h.ui.action('cloud-use-local', 8), true);
  assert.deepEqual(h.calls.at(-1), ['chooseLocal', 8]);
  h.status({ remoteRevision: 0, remoteSummary: { months: 0 }, conflict: { reason: 'first-connection' } });
  assert.doesNotMatch(h.ui.panel(), /data-action="cloud-use-remote"/);
  assert.match(h.ui.panel(), /Sauvegarder cet appareil sur Google/);
});

test('status badges distinguish pending writes, offline use and delayed remote updates', async () => {
  const h = fixture(); await h.ui.start();
  h.status({ phase: 'ready', user: { uid: 'synthetic-user' }, dirty: true });
  assert.match(h.ui.badge(), /À synchroniser/);
  h.status({ dirty: false, remotePending: true });
  assert.match(h.ui.badge(), /Mise à jour reçue/);
  assert.match(h.ui.panel(), /Termine ta saisie/);
  h.status({ phase: 'offline', remotePending: false, dirty: true });
  assert.match(h.ui.badge(), /Hors connexion/);
  assert.match(h.ui.panel(), /retour de la connexion/);
  h.status({ phase: 'syncing' });
  assert.equal(h.ui.isBusy(), true);
  assert.match(h.ui.panel(), /data-action="cloud-logout" disabled/);
});

test('signout stops synchronization and destroying the UI releases auth and sync listeners', async () => {
  const h = fixture({ restoredUser: { uid: 'synthetic-user' } }); await h.ui.start();
  assert.equal(await h.ui.action('cloud-logout'), true);
  assert.equal(h.calls.some(c => c[0] === 'signOut'), true);
  assert.equal(h.calls.at(-1)[0], 'disconnect');
  h.ui.destroy();
  assert.deepEqual(h.calls.slice(-2), [['unsubscribe'], ['destroy']]);
});

test('a first real controller connection does not upload existing local data without a choice', async () => {
  let local = { version: 1, months: { '2026-11': { salary: 2500 } } };
  const writes = [], memory = new Map();
  const adapter = {
    listen(uid, next) { queueMicrotask(() => next(null)); return () => {}; },
    async read() { return null; },
    async write(uid, revision, data) { writes.push({ uid, revision, data }); return { revision: revision + 1, data, updatedAt: Date.now() }; }
  };
  const ui = UI.create({
    config: { projectId: 'synthetic' }, protocol: 'https:', sync: Sync,
    firebase: {
      isConfigured: () => true,
      load: async () => ({ adapter, onUser(next) { next({ uid: 'synthetic-user' }); return () => {}; } }),
      humanMessage: () => 'Erreur.'
    },
    getData: () => local, validate: data => { assert.equal(data.version, 1); },
    applyRemote: data => { local = data; return true; }, isBusy: () => false, isEnabled: () => true,
    hasLocalData: () => true, storage: { getItem: key => memory.get(key) || null, setItem: (key, value) => memory.set(key, value) }
  });
  await ui.start(); await turn();
  assert.equal(ui.status().phase, 'conflict');
  assert.equal(ui.status().conflict.reason, 'first-connection');
  assert.equal(writes.length, 0);
  await ui.action('cloud-sync'); assert.equal(writes.length, 0);
  assert.equal(await ui.action('cloud-use-local', 0), true);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].uid, 'synthetic-user');
  assert.equal(writes[0].data.months['2026-11'].salary, 2500);
  ui.destroy();
});

test('browser export initializes without touching a real Firebase account', () => {
  const context = {}; vm.createContext(context);
  vm.runInContext(fs.readFileSync(require.resolve('../dist/cloud-ui.js'), 'utf8'), context);
  assert.equal(typeof context.MargeCloudUI.create, 'function');
});
