'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const DIST = path.join(__dirname, '../dist');
const swSource = fs.readFileSync(path.join(DIST, 'sw.js'), 'utf8');
const pwaSource = fs.readFileSync(path.join(DIST, 'pwa.js'), 'utf8');
const scope = 'https://madec01.github.io/budget-tracker/';
const flush = () => new Promise(resolve => setImmediate(resolve));

function cacheStorage() {
  const data = new Map();
  const key = value => typeof value === 'string' ? value : value.url;
  return {
    data,
    async open(name) {
      if (!data.has(name)) data.set(name, new Map());
      const entries = data.get(name);
      return {
        async put(request, response) { entries.set(key(request), response.clone()); },
        async match(request) { const value = entries.get(key(request)); return value && value.clone(); }
      };
    },
    async keys() { return [...data.keys()]; },
    async delete(name) { return data.delete(name); }
  };
}

function worker(options = {}) {
  const events = {}, cache = options.cache || cacheStorage();
  const control = { fetches: [], offline: false, failure: null, skip: 0, claimed: 0, clients: [], sent: [] };
  const actualScope = options.scope || scope;
  function fireMessage(client, data) {
    let work = Promise.resolve();
    events.message({ source: client, data, waitUntil(value) { work = value; } });
    return work;
  }
  function client(id, busy = false, url = actualScope, reply = true) {
    const instance = {
      id, url, postMessage(data) {
        control.sent.push({ id, ...data });
        if (data.type === 'MARGE_UPDATE_QUERY' && reply) {
          fireMessage(instance, { type: 'MARGE_UPDATE_STATUS', requestId: data.requestId, busy });
        }
      }
    };
    return instance;
  }
  const self = {
    registration: { scope: actualScope },
    addEventListener(name, handler) { events[name] = handler; },
    clients: {
      async matchAll() { return [...control.clients]; },
      async claim() { control.claimed += 1; }
    },
    async skipWaiting() { control.skip += 1; }
  };
  vm.runInNewContext(swSource, {
    self, caches: cache, URL, Request, Response, Set, Map, Math, Date,
    setTimeout: (fn, delay) => setTimeout(fn, Math.min(delay, 10)), clearTimeout,
    async fetch(request) {
      control.fetches.push(request.url);
      if (control.offline) throw new Error('offline');
      return new Response('asset:' + request.url, { status: request.url === control.failure ? 404 : 200 });
    }
  });
  async function lifecycle(name) {
    let work;
    events[name]({ waitUntil(value) { work = value; } });
    await work;
  }
  function fetchRequest(url, extra = {}) {
    let response;
    events.fetch({ request: { url, method: 'GET', mode: 'navigate', ...extra }, respondWith(value) { response = value; } });
    return response;
  }
  return { events, cache, control, lifecycle, fetchRequest, client, fireMessage };
}

function page(options = {}) {
  const winEvents = {}, docEvents = {}, swEvents = {}, regEvents = {};
  const timers = new Map(); let timerId = 0;
  const control = { reloads: 0, updates: 0, registered: [], status: [], posted: [], dialog: false };
  const waiting = { scriptURL: scope + 'sw.js', postMessage(message) { control.posted.push(message); } };
  const registration = {
    active: options.active === false ? null : {}, waiting: options.waiting === false ? null : waiting,
    async update() { control.updates += 1; }, addEventListener(name, fn) { regEvents[name] = fn; }
  };
  const serviceWorker = {
    controller: options.controller === false ? null : {},
    addEventListener(name, fn) { swEvents[name] = fn; },
    async register(url, config) { control.registered.push({ url, config }); return registration; }
  };
  const location = { protocol: options.protocol || 'https:', reload() { control.reloads += 1; } };
  const document = {
    baseURI: options.baseURI || scope + 'index.html', visibilityState: 'visible', activeElement: null,
    querySelector() { return control.dialog ? {} : null; },
    addEventListener(name, fn) { docEvents[name] = fn; }
  };
  const navigator = {
    serviceWorker, onLine: true, userAgent: options.userAgent || 'Chrome Android', platform: options.platform || 'Linux', maxTouchPoints: 0
  };
  if (options.supported === false) delete navigator.serviceWorker;
  const window = {
    isSecureContext: true,
    matchMedia() { return { matches: !!options.installed, addEventListener() {} }; },
    addEventListener(name, fn) { winEvents[name] = fn; },
    dispatchEvent(event) { control.status.push(event.detail); }
  };
  vm.runInNewContext(pwaSource, {
    window, document, navigator, location, URL, Date,
    CustomEvent: class { constructor(type, { detail }) { this.type = type; this.detail = detail; } },
    setTimeout(fn) { const id = ++timerId; timers.set(id, fn); return id; },
    clearTimeout(id) { timers.delete(id); }
  });
  function runTimers() { const jobs = [...timers.values()]; timers.clear(); for (const fn of jobs) fn(); }
  return { api: window.MargePWA, control, registration, serviceWorker, navigator, document, winEvents, docEvents, swEvents, runTimers, waiting };
}

test('manifest, icon dimensions and template are relative and installable under a repository path', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(DIST, 'manifest.webmanifest'), 'utf8'));
  assert.equal(manifest.scope, './'); assert.equal(manifest.start_url, './'); assert.equal(manifest.id, './');
  assert.equal(manifest.display, 'standalone');
  for (const icon of manifest.icons) {
    assert.match(icon.src, /^\.\/icons\//);
    const data = fs.readFileSync(path.join(DIST, icon.src));
    const size = Number(icon.sizes.split('x')[0]);
    assert.equal(data.readUInt32BE(16), size); assert.equal(data.readUInt32BE(20), size);
  }
  assert.ok(manifest.icons.some(icon => icon.purpose === 'maskable' && icon.sizes === '512x512'));
  const apple = fs.readFileSync(path.join(DIST, 'icons/apple-touch-icon.png'));
  assert.equal(apple.readUInt32BE(16), 180);
  const template = fs.readFileSync(path.join(__dirname, '../template.html'), 'utf8');
  assert.match(template, /rel="manifest" href="\.\/manifest.webmanifest"/);
  assert.ok(template.indexOf('/* PWA */') < template.indexOf('/* APP */'));
});

test('install precaches only fixed same-scope app assets and does not force activation', async () => {
  const h = worker(); await h.lifecycle('install');
  assert.equal(h.control.fetches.length, 8);
  assert.ok(h.control.fetches.every(url => url.startsWith(scope)));
  const [name] = await h.cache.keys();
  assert.ok(name.startsWith('marge-shell:' + encodeURIComponent(scope) + ':'));
  assert.equal(h.cache.data.get(name).size, 8);
  assert.equal(h.control.skip, 0);
});

test('a missing install asset rejects the release without leaving a partial cache', async () => {
  const h = worker(); h.control.failure = scope + 'icons/icon-512.png';
  await assert.rejects(h.lifecycle('install'), /App asset unavailable/);
  assert.equal((await h.cache.keys()).length, 0);
  assert.equal(h.control.skip, 0);
});

test('offline app-shell fallback stays within this application and never intercepts data or writes', async () => {
  const h = worker(); await h.lifecycle('install'); h.control.offline = true;
  for (const url of [scope, scope + '?installed=1', scope + 'index.html?month=2026-12']) {
    const response = await h.fetchRequest(url);
    assert.match(await response.text(), /asset:.*budget-tracker\/index.html/);
  }
  const icon = await h.fetchRequest(scope + 'icons/icon-192.png', { mode: 'same-origin' });
  assert.ok(icon.ok);
  for (const url of ['https://madec01.github.io/renfo/', 'https://example.org/', scope + 'api/balances', scope + 'backup.json']) {
    assert.equal(h.fetchRequest(url), undefined);
  }
  assert.equal(h.fetchRequest(scope + 'index.html', { method: 'POST' }), undefined);
});

test('activation removes only old releases for this exact repository scope', async () => {
  const h = worker(); await h.lifecycle('install');
  const ownOld = 'marge-shell:' + encodeURIComponent(scope) + ':old';
  const other = 'marge-shell:' + encodeURIComponent('https://madec01.github.io/renfo/') + ':old';
  await h.cache.open(ownOld); await h.cache.open(other); await h.cache.open('unrelated-cache');
  await h.lifecycle('activate');
  assert.ok(!(await h.cache.keys()).includes(ownOld));
  assert.ok((await h.cache.keys()).includes(other));
  assert.ok((await h.cache.keys()).includes('unrelated-cache'));
  assert.equal(h.control.claimed, 1);
});

test('update activation requires all scoped windows to acknowledge clean, ignores other repositories', async () => {
  const h = worker();
  const first = h.client('a'), second = h.client('b');
  h.control.clients = [first, second, h.client('other', true, 'https://madec01.github.io/renfo/')];
  await h.fireMessage(first, { type: 'MARGE_TRY_ACTIVATE' });
  assert.equal(h.control.skip, 1);
  assert.ok(!h.control.sent.some(message => message.id === 'other'));
});

test('a dirty or unresponsive tab prevents activation', async () => {
  for (const unresponsive of [false, true]) {
    const h = worker(), first = h.client('a');
    h.control.clients = [first, h.client('b', true, scope, !unresponsive)];
    await h.fireMessage(first, { type: 'MARGE_TRY_ACTIVATE' });
    assert.equal(h.control.skip, 0);
    assert.ok(h.control.sent.some(message => message.type === 'MARGE_UPDATE_DEFERRED'));
  }
});

test('a window becoming busy during coordination cancels activation', async () => {
  const h = worker(), first = h.client('a');
  const second = h.client('b');
  const original = second.postMessage;
  second.postMessage = data => {
    original(data);
    if (data.type === 'MARGE_UPDATE_QUERY') {
      h.fireMessage(second, { type: 'MARGE_UPDATE_STATUS', requestId: data.requestId, busy: true });
    }
  };
  h.control.clients = [first, second];
  await h.fireMessage(first, { type: 'MARGE_TRY_ACTIVATE' });
  assert.equal(h.control.skip, 0);
});

test('client registers the repository scope and waits for setBusy(false) before requesting update', async () => {
  const h = page(); await flush(); h.runTimers();
  assert.equal(h.control.registered[0].url, scope + 'sw.js');
  assert.equal(h.control.registered[0].config.scope, scope);
  assert.equal(h.control.registered[0].config.updateViaCache, 'none');
  assert.equal(h.api.getStatus().busy, true); assert.equal(h.control.posted.length, 0);
  h.api.setBusy(false); h.runTimers();
  assert.ok(h.control.posted.some(message => message.type === 'MARGE_TRY_ACTIVATE'));
});

test('controller changes never reload busy, hidden or editing pages; a clean visible page reloads once', async () => {
  const h = page(); await flush();
  h.swEvents.controllerchange(); h.runTimers(); assert.equal(h.control.reloads, 0);
  h.document.visibilityState = 'hidden'; h.api.setBusy(false); h.runTimers(); assert.equal(h.control.reloads, 0);
  h.document.visibilityState = 'visible'; h.control.dialog = true;
  h.docEvents.visibilitychange(); h.runTimers(); assert.equal(h.control.reloads, 0);
  h.control.dialog = false; h.document.activeElement = { tagName: 'INPUT' };
  h.api.setBusy(false); h.runTimers(); assert.equal(h.control.reloads, 0);
  h.document.activeElement = null; h.api.setBusy(false); h.runTimers(); assert.equal(h.control.reloads, 1);
  h.api.setBusy(false); h.runTimers(); assert.equal(h.control.reloads, 1);
});

test('first service-worker control does not reload the initial page', async () => {
  const h = page({ controller: false, active: false, waiting: false }); await flush();
  h.api.setBusy(false); h.serviceWorker.controller = {};
  h.swEvents.controllerchange(); h.runTimers();
  assert.equal(h.control.reloads, 0); assert.equal(h.api.getStatus().offlineReady, true);
});

test('first install is not labelled an update and matching activation clears deferred status', async () => {
  const first = page({ controller: false, active: false }); await flush();
  assert.equal(first.api.getStatus().updateAvailable, false);
  const h = page(); await flush();
  h.swEvents.message({ source: h.waiting, data: { type: 'MARGE_UPDATE_DEFERRED' } });
  assert.equal(h.api.getStatus().updateDeferred, true);
  h.swEvents.message({ source: h.waiting, data: { type: 'MARGE_ACTIVE', version: h.api.getStatus().version } });
  assert.equal(h.api.getStatus().updateAvailable, false);
  assert.equal(h.api.getStatus().updateDeferred, false);
  assert.equal(h.api.getStatus().offlineReady, true);
});

test('client update query reports its busy state and revises consent when editing starts', async () => {
  const h = page(); await flush(); h.api.setBusy(false);
  h.swEvents.message({ source: h.waiting, data: { type: 'MARGE_UPDATE_QUERY', requestId: 'probe' } });
  assert.equal(h.control.posted.at(-1).busy, false);
  h.api.setBusy(true);
  assert.equal(h.control.posted.at(-1).busy, true);
  assert.equal(h.control.posted.at(-1).requestId, 'probe');
});

test('returning online checks updates and install stays explicitly user initiated', async () => {
  const h = page(); await flush();
  const before = h.control.updates; h.winEvents.online(); await flush();
  assert.equal(h.control.updates, before + 1);
  let prompts = 0, prevented = false;
  h.winEvents.beforeinstallprompt({ preventDefault() { prevented = true; }, async prompt() { prompts += 1; return { outcome: 'accepted' }; } });
  assert.equal(prevented, true); assert.equal(prompts, 0); assert.equal(h.api.canInstall(), true);
  assert.equal((await h.api.install()).outcome, 'accepted');
  assert.equal(prompts, 1); assert.equal(h.api.canInstall(), false);
  h.winEvents.appinstalled(); assert.equal(h.api.isInstalled(), true);
});

test('unsupported/file and iOS environments receive instructions without attempted installation', async () => {
  const local = page({ supported: false, protocol: 'file:', baseURI: 'file:///tmp/index.html' });
  assert.equal(local.control.registered.length, 0);
  assert.equal((await local.api.install()).platform, 'local');
  const ios = page({ supported: false, userAgent: 'iPhone Safari' });
  assert.equal((await ios.api.install()).platform, 'ios');
  const android = page({ supported: false });
  assert.equal((await android.api.install()).platform, 'android');
});
