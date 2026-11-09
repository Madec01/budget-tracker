/* Marge PWA integration. Load before app.js; the app owns the explicit busy flag. */
(function () {
  'use strict';
  const VERSION = '__MARGE_BUILD_VERSION__';
  const BASE = new URL('./', document.baseURI);
  const supported = 'serviceWorker' in navigator && window.isSecureContext && /^https?:$/.test(location.protocol);
  let busy = true, registration = null, installPrompt = null, installed = false;
  let offlineReady = false, updateAvailable = false, updateDeferred = false, error = null;
  let lastCheck = 0, checking = null, activateTimer = null, reloadTimer = null, reloading = false;
  let hadController = !!(navigator.serviceWorker && navigator.serviceWorker.controller), reloadPending = false;
  let probe = null;
  const standalone = window.matchMedia ? window.matchMedia('(display-mode: standalone)') : null;

  function isInstalled() { return installed || !!(standalone && standalone.matches) || navigator.standalone === true; }
  function canInstall() { return !!installPrompt && !isInstalled(); }
  function editing() {
    const active = document.activeElement;
    return !!document.querySelector('dialog[open]') || !!(active && (active.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName)));
  }
  function isBusy() { return busy || editing(); }
  function getStatus() {
    return { version: VERSION, supported, registered: !!registration, offlineReady, updateAvailable, updateDeferred,
      busy: isBusy(), canInstall: canInstall(), isInstalled: isInstalled(), lastCheck, error, scope: BASE.href };
  }
  function emit() { window.dispatchEvent(new CustomEvent('marge:pwa-status', { detail: getStatus() })); }
  function answerProbe() {
    if (probe) try { probe.worker.postMessage({ type: 'MARGE_UPDATE_STATUS', requestId: probe.id, busy: isBusy() }); } catch (_) { /* Worker replaced. */ }
  }
  function safeReload() {
    clearTimeout(reloadTimer);
    if (!reloadPending || reloading || isBusy() || document.visibilityState === 'hidden') return;
    reloadTimer = setTimeout(() => {
      if (!reloadPending || reloading || isBusy() || document.visibilityState === 'hidden') return;
      reloading = true;
      location.reload();
    }, 200);
  }
  function requestActivation() {
    clearTimeout(activateTimer);
    safeReload();
    if (!registration || !registration.waiting || isBusy() || document.visibilityState === 'hidden') return;
    activateTimer = setTimeout(() => {
      if (registration && registration.waiting && !isBusy() && document.visibilityState !== 'hidden') {
        registration.waiting.postMessage({ type: 'MARGE_TRY_ACTIVATE' });
      }
    }, 600);
  }
  function setBusy(value) {
    busy = !!value;
    if (busy) { clearTimeout(activateTimer); clearTimeout(reloadTimer); }
    answerProbe(); emit();
    if (!busy) requestActivation();
  }
  function noticeWaiting() {
    if (registration && registration.waiting && (registration.active || navigator.serviceWorker.controller)) {
      updateAvailable = true; emit(); requestActivation();
    }
  }
  async function checkForUpdates(force = false) {
    if (!registration || navigator.onLine === false) return getStatus();
    if (checking) return checking;
    if (!force && Date.now() - lastCheck < 60000) { noticeWaiting(); return getStatus(); }
    lastCheck = Date.now();
    checking = (async () => {
      try { await registration.update(); error = null; noticeWaiting(); }
      catch (_) { error = 'La vérification de mise à jour sera réessayée au retour de la connexion.'; }
      finally { checking = null; emit(); }
      return getStatus();
    })();
    return checking;
  }
  function instructions() {
    if (location.protocol === 'file:') return { outcome: 'instructions', platform: 'local', instructions: 'Ouvre l’adresse HTTPS de Marge dans ton navigateur pour l’installer sur cet appareil.' };
    const ios = /iPad|iPhone|iPod/.test(navigator.userAgent || '') || (/Mac/.test(navigator.platform || '') && navigator.maxTouchPoints > 1);
    if (ios) return { outcome: 'instructions', platform: 'ios', instructions: 'Dans Safari, ouvre Partager, puis « Sur l’écran d’accueil ». Active « Ouvrir comme app web » si cette option apparaît, puis touche Ajouter.' };
    if (/Android/.test(navigator.userAgent || '')) return { outcome: 'instructions', platform: 'android', instructions: 'Dans le menu ⋮ du navigateur, choisis « Installer l’application » ou « Ajouter à l’écran d’accueil ». Si cette option manque, réessaie après avoir ouvert Marge en ligne.' };
    return { outcome: 'instructions', platform: 'desktop', instructions: 'Dans Chrome ou Edge, utilise l’icône d’installation dans la barre d’adresse ou le menu « Installer Marge ». Cette option dépend du navigateur.' };
  }
  async function install() {
    if (isInstalled()) return { outcome: 'already-installed' };
    if (!installPrompt) return instructions();
    const event = installPrompt; installPrompt = null; emit();
    try {
      const result = await event.prompt();
      const choice = event.userChoice ? await event.userChoice : result;
      emit();
      return { outcome: choice && choice.outcome === 'accepted' ? 'accepted' : 'dismissed' };
    } catch (_) { return instructions(); }
  }

  window.MargePWA = Object.freeze({ setBusy, install, canInstall, isInstalled, getStatus, checkForUpdates });
  window.addEventListener('beforeinstallprompt', event => { event.preventDefault(); installPrompt = event; emit(); });
  window.addEventListener('appinstalled', () => { installed = true; installPrompt = null; emit(); });
  if (standalone && standalone.addEventListener) standalone.addEventListener('change', emit);
  document.addEventListener('visibilitychange', () => {
    answerProbe();
    if (document.visibilityState !== 'hidden') { checkForUpdates(); requestActivation(); }
  });
  document.addEventListener('focusout', () => { setTimeout(() => { answerProbe(); requestActivation(); }, 0); });
  window.addEventListener('online', () => { checkForUpdates(true); requestActivation(); });
  window.addEventListener('pageshow', () => { answerProbe(); requestActivation(); });

  if (supported) {
    navigator.serviceWorker.addEventListener('message', event => {
      const data = event.data || {};
      if (!event.source || !event.source.scriptURL || new URL(event.source.scriptURL).href !== new URL('sw.js', BASE).href) return;
      if (data.type === 'MARGE_UPDATE_QUERY') { probe = { id: data.requestId, worker: event.source }; answerProbe(); }
      if (data.type === 'MARGE_UPDATE_DEFERRED') { updateDeferred = true; updateAvailable = true; emit(); }
      if (data.type === 'MARGE_ACTIVE') {
        offlineReady = true;
        if (data.version === VERSION) {
          updateAvailable = false; updateDeferred = false; reloadPending = false;
        } else if (typeof data.version === 'string') {
          // A first install may fetch a newer deployment than the currently open
          // HTML. That page must also wait until its edits are safely saved.
          reloadPending = true; updateAvailable = true; updateDeferred = isBusy(); safeReload();
        }
        emit();
      }
    });
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      const hasController = !!navigator.serviceWorker.controller;
      if (hadController && hasController) { reloadPending = true; updateAvailable = true; safeReload(); }
      hadController = hasController;
      offlineReady = hasController; emit();
    });
    navigator.serviceWorker.register(new URL('sw.js', BASE).href, { scope: BASE.href, updateViaCache: 'none' }).then(reg => {
      registration = reg; offlineReady = !!reg.active;
      reg.addEventListener('updatefound', () => {
        const worker = reg.installing;
        if (worker) worker.addEventListener('statechange', () => { if (worker.state === 'installed') noticeWaiting(); });
      });
      noticeWaiting(); emit(); checkForUpdates();
    }).catch(() => { error = 'L’installation hors ligne n’est pas encore disponible. Réessaie après le retour de la connexion.'; emit(); });
  } else emit();
})();
