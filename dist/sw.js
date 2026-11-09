/* Marge PWA: immutable app shell; financial data never enter this cache. */
'use strict';
const APP_VERSION = '147a5f5c2b1d8a43';
const SCOPE = new URL(self.registration.scope);
const CACHE_PREFIX = 'marge-shell:' + encodeURIComponent(SCOPE.href) + ':';
const CACHE_NAME = CACHE_PREFIX + APP_VERSION;
const ASSETS = [
  'index.html', 'manifest.webmanifest', 'icons/icon.svg',
  'icons/icon-192.png', 'icons/icon-512.png',
  'icons/maskable-192.png', 'icons/maskable-512.png', 'icons/apple-touch-icon.png'
].map(path => new URL(path, SCOPE).href);
const SHELL = ASSETS[0];
const ALLOWED_ASSETS = new Set(ASSETS);
let activationAttempt = null;

function inScope(url) {
  return url.origin === SCOPE.origin && url.pathname.startsWith(SCOPE.pathname);
}
function canonical(url) {
  const value = new URL(url);
  value.search = ''; value.hash = '';
  return value.href;
}
function appClients() {
  return self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    .then(clients => clients.filter(client => inScope(new URL(client.url))));
}
function send(client, type, extra = {}) {
  try { client.postMessage({ type, version: APP_VERSION, ...extra }); } catch (_) { /* Closed tab. */ }
}

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    try {
      // Fetch the entire release before making it an offline candidate.
      const responses = await Promise.all(ASSETS.map(async url => {
        const response = await fetch(new Request(url, { cache: 'reload', credentials: 'same-origin' }));
        if (!response.ok || response.type === 'opaque' || (response.url && !inScope(new URL(response.url)))) {
          throw new Error('App asset unavailable: ' + url);
        }
        return response;
      }));
      const cache = await caches.open(CACHE_NAME);
      await Promise.all(responses.map((response, i) => cache.put(ASSETS[i], response)));
      // Updates stay waiting until every open app window explicitly reports clean.
      // Initial installation activates naturally when no old worker exists.
    } catch (error) {
      await caches.delete(CACHE_NAME);
      throw error;
    }
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    await Promise.all((await caches.keys()).filter(name => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME).map(name => caches.delete(name)));
    await self.clients.claim();
    for (const client of await appClients()) send(client, 'MARGE_ACTIVE');
  })());
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (!inScope(url)) return;
  const isShell = request.mode === 'navigate' && (url.pathname === SCOPE.pathname || canonical(url) === SHELL);
  const key = isShell ? SHELL : canonical(url);
  if (!isShell && !ALLOWED_ASSETS.has(key)) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(key);
    if (cached) return cached;
    // Recover an evicted resource without ever caching API calls or user files.
    try {
      const response = await fetch(request);
      if (response.ok && response.type !== 'opaque' && (!response.url || inScope(new URL(response.url)))) return response;
      return response;
    } catch (_) {
      return Response.error();
    }
  })());
});

async function tryActivate() {
  if (activationAttempt) return activationAttempt.promise;
  const attempt = { id: APP_VERSION + ':' + Date.now() + ':' + Math.random().toString(36).slice(2), statuses: new Map(), clients: [], resolve: null, timer: null, promise: null };
  activationAttempt = attempt;
  attempt.promise = (async () => {
    try {
      attempt.clients = await appClients();
      if (!attempt.clients.length) { await self.skipWaiting(); return; }
      const complete = new Promise(resolve => { attempt.resolve = resolve; attempt.timer = setTimeout(() => resolve(false), 3000); });
      for (const client of attempt.clients) send(client, 'MARGE_UPDATE_QUERY', { requestId: attempt.id });
      const allClean = await complete;
      clearTimeout(attempt.timer);
      // A short second check catches typing/new tabs between acknowledgements.
      if (allClean) await new Promise(resolve => setTimeout(resolve, 120));
      const current = await appClients();
      const clean = allClean && current.every(client => attempt.statuses.get(client.id) === false);
      if (clean) await self.skipWaiting();
      else for (const client of current) send(client, 'MARGE_UPDATE_DEFERRED');
    } finally { activationAttempt = null; }
  })();
  return attempt.promise;
}

self.addEventListener('message', event => {
  const data = event.data || {}, client = event.source;
  if (!client || !client.url || !inScope(new URL(client.url))) return;
  if (data.type === 'MARGE_TRY_ACTIVATE') event.waitUntil(tryActivate());
  if (data.type === 'MARGE_UPDATE_STATUS' && activationAttempt && data.requestId === activationAttempt.id) {
    const attempt = activationAttempt;
    if (!attempt.clients.some(item => item.id === client.id)) return;
    attempt.statuses.set(client.id, data.busy !== false);
    if (data.busy !== false) attempt.resolve(false);
    else if (attempt.clients.every(item => attempt.statuses.get(item.id) === false)) attempt.resolve(true);
  }
  if (data.type === 'MARGE_VERSION') send(client, 'MARGE_ACTIVE');
});
