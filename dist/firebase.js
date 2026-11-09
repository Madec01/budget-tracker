/* Marge — optional Firebase bridge. The budget remains usable without loading it. */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MargeFirebase = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var SDK_VERSION = '13.2.0';
  var MAX_PAYLOAD_BYTES = 700000;
  var clients = new Map();
  var sdkPromise = null;

  function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
  function failure(code, message, current) {
    var error = new Error(message);
    error.code = code;
    if (arguments.length > 2) error.current = current;
    return error;
  }
  function friendlyError(error) {
    var clean = failure(error && error.code || 'cloud/error', humanMessage(error));
    if (error && Object.prototype.hasOwnProperty.call(error, 'current')) clean.current = error.current;
    return clean;
  }
  function bytes(value) { return new TextEncoder().encode(value).byteLength; }
  function isConfigured(config) {
    return object(config) && typeof config.apiKey === 'string' && /^[A-Za-z0-9_-]{20,200}$/.test(config.apiKey)
      && typeof config.authDomain === 'string' && /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/i.test(config.authDomain)
      && typeof config.projectId === 'string' && /^[a-z][a-z0-9-]{4,61}[a-z0-9]$/.test(config.projectId)
      && typeof config.appId === 'string' && /^\d+:\d+:web:[a-z0-9]+$/i.test(config.appId);
  }
  function uidValue(uid) {
    if (typeof uid !== 'string' || uid.length < 1 || uid.length > 128 || /[\x00-\x1f\x7f/]/.test(uid)
      || uid === '.' || uid === '..' || /^__.*__$/.test(uid)) {
      throw failure('cloud/invalid-user', 'Le compte connecté n’est pas valide.');
    }
    return uid;
  }
  function serialize(data) {
    if (!object(data)) throw failure('cloud/invalid-data', 'La sauvegarde doit être un objet JSON.');
    var payload;
    try { payload = JSON.stringify(data); }
    catch (_) { throw failure('cloud/invalid-data', 'La sauvegarde ne peut pas être convertie en JSON.'); }
    if (typeof payload !== 'string') throw failure('cloud/invalid-data', 'La sauvegarde doit être un objet JSON.');
    if (bytes(payload) > MAX_PAYLOAD_BYTES) throw failure('cloud/payload-too-large', 'La sauvegarde dépasse la taille autorisée.');
    return payload;
  }
  function decode(snapshot) {
    if (!snapshot.exists()) return null;
    var value = snapshot.data();
    if (!object(value) || Object.keys(value).sort().join(',') !== 'payload,revision,schemaVersion,updatedAt'
      || value.schemaVersion !== 1 || !Number.isSafeInteger(value.revision) || value.revision < 1
      || typeof value.payload !== 'string' || bytes(value.payload) > MAX_PAYLOAD_BYTES
      || !value.updatedAt || typeof value.updatedAt.toMillis !== 'function') {
      throw failure('cloud/invalid-data', 'La sauvegarde en ligne n’a pas un format reconnu.');
    }
    var data, updatedAt;
    try { data = JSON.parse(value.payload); updatedAt = value.updatedAt.toMillis(); }
    catch (_) { throw failure('cloud/invalid-data', 'La sauvegarde en ligne est illisible.'); }
    if (!object(data) || !Number.isFinite(updatedAt) || updatedAt < 0) {
      throw failure('cloud/invalid-data', 'La sauvegarde en ligne n’a pas un format reconnu.');
    }
    return { revision: value.revision, data: data, updatedAt: updatedAt };
  }

  /**
   * The SDK is injected so transactions can be verified without a real account.
   * Only server-confirmed documents are delivered. The application's own local
   * storage is the offline source; Firestore does not keep a persistent cache.
   */
  function createAdapter(sdk, db) {
    function ref(uid) { return sdk.doc(db, 'users', uidValue(uid), 'apps', 'marge'); }
    var adapter = {
      listen: function (uid, onDocument, onError) {
        return sdk.onSnapshot(ref(uid), { includeMetadataChanges: true }, function (snapshot) {
          if (snapshot.metadata && (snapshot.metadata.fromCache || snapshot.metadata.hasPendingWrites)) return;
          try { onDocument(decode(snapshot)); }
          catch (error) { if (onError) onError(error); }
        }, onError);
      },
      read: async function (uid) {
        var snapshot = await sdk.getDocFromServer(ref(uid));
        if (snapshot.metadata && (snapshot.metadata.fromCache || snapshot.metadata.hasPendingWrites)) {
          throw failure('cloud/server-unavailable', 'La sauvegarde en ligne n’a pas encore été confirmée.');
        }
        return decode(snapshot);
      },
      write: async function (uid, expectedRevision, data) {
        var document = ref(uid);
        if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || expectedRevision >= Number.MAX_SAFE_INTEGER) {
          throw failure('cloud/invalid-revision', 'La version de la sauvegarde n’est pas valide.');
        }
        var payload = serialize(data), saved = JSON.parse(payload);
        var committed;
        try {
          committed = await sdk.runTransaction(db, async function (transaction) {
            var current = decode(await transaction.get(document));
            var revision = current ? current.revision : 0;
            if (revision !== expectedRevision) {
              throw failure('cloud/conflict', 'Une autre version a été enregistrée sur un autre appareil.', current);
            }
            transaction.set(document, {
              schemaVersion: 1, revision: revision + 1,
              payload: payload, updatedAt: sdk.serverTimestamp()
            });
            return { revision: revision + 1, data: saved };
          });
        } catch (error) {
          // Rules can reject a stale revision before the SDK retries a racing
          // transaction. A single exceptional read distinguishes that conflict
          // from an actual access denial; no polling or successful-write re-read.
          if (error && error.code === 'permission-denied') {
            var confirmed = false, latest = null;
            try {
              var latestSnapshot = await sdk.getDocFromServer(document);
              if (!latestSnapshot.metadata || (!latestSnapshot.metadata.fromCache && !latestSnapshot.metadata.hasPendingWrites)) {
                latest = decode(latestSnapshot);
                confirmed = true;
              }
            } catch (_) { /* Preserve the original denial if no server version is readable. */ }
            if (confirmed && (latest ? latest.revision : 0) !== expectedRevision) {
              throw failure('cloud/conflict', 'Une autre version a été enregistrée sur un autre appareil.', latest);
            }
          }
          throw error;
        }
        // runTransaction resolves only after the server accepts this revision.
        // Do not re-read here: another writer could already have created a newer
        // revision. The listener supplies the exact server timestamp afterwards.
        return { revision: committed.revision, data: committed.data, updatedAt: Date.now() };
      }
    };
    return {
      listen: function (uid, onDocument, onError) {
        try {
          return adapter.listen(uid, onDocument, function (error) { if (onError) onError(friendlyError(error)); });
        } catch (error) { throw friendlyError(error); }
      },
      read: async function (uid) {
        try { return await adapter.read(uid); }
        catch (error) { throw friendlyError(error); }
      },
      write: async function (uid, expectedRevision, data) {
        try { return await adapter.write(uid, expectedRevision, data); }
        catch (error) { throw friendlyError(error); }
      }
    };
  }

  function publicUser(user) {
    return user ? { uid: user.uid, email: user.email || '', displayName: user.displayName || '' } : null;
  }
  async function createClient(sdk, config) {
    if (!isConfigured(config)) throw failure('cloud/not-configured', 'Firebase n’est pas encore configuré pour Marge.');
    var name = 'marge-budget-' + config.projectId;
    var app = sdk.getApps().find(function (candidate) { return candidate.name === name; });
    if (!app) app = sdk.initializeApp(config, name);
    var auth = sdk.getAuth(app);
    await sdk.setPersistence(auth, sdk.browserLocalPersistence);
    var db = sdk.getFirestore(app); // Default memory cache; no Firestore disk persistence.
    var provider = new sdk.GoogleAuthProvider();
    provider.setCustomParameters({ prompt: 'select_account' });
    return {
      signIn: function () {
        // This call must start in the click handler, after load() has completed.
        // No redirect fallback: GitHub Pages cannot host Firebase's auth helper.
        return sdk.signInWithPopup(auth, provider).then(function (result) { return publicUser(result.user); });
      },
      signOut: function () { return sdk.signOut(auth); },
      onUser: function (callback, onError) {
        return sdk.onAuthStateChanged(auth, function (user) { callback(publicUser(user)); }, onError);
      },
      adapter: createAdapter(sdk, db)
    };
  }
  function load(config) {
    if (!isConfigured(config)) return Promise.reject(failure('cloud/not-configured', 'Firebase n’est pas encore configuré pour Marge.'));
    // Copy public web configuration; no service-account credential belongs here.
    var selected = {};
    ['apiKey', 'authDomain', 'projectId', 'appId', 'storageBucket', 'messagingSenderId'].forEach(function (key) {
      if (typeof config[key] === 'string') selected[key] = config[key];
    });
    var key = JSON.stringify(selected);
    if (clients.has(key)) return clients.get(key);
    if (!sdkPromise) {
      // Official CDN version pinned for reproducibility. Nothing loads until load().
      sdkPromise = Promise.all([
        import('https://www.gstatic.com/firebasejs/13.2.0/firebase-app.js'),
        import('https://www.gstatic.com/firebasejs/13.2.0/firebase-auth.js'),
        import('https://www.gstatic.com/firebasejs/13.2.0/firebase-firestore.js')
      ]).then(function (modules) { return Object.assign({}, modules[0], modules[1], modules[2]); })
        .catch(function (error) { sdkPromise = null; throw error; });
    }
    var promise = sdkPromise.then(function (sdk) { return createClient(sdk, selected); })
      .catch(function (error) { clients.delete(key); throw error; });
    clients.set(key, promise);
    return promise;
  }
  function humanMessage(error) {
    var code = typeof error === 'string' ? error : error && error.code;
    var messages = {
      'cloud/not-configured': 'La connexion Google sera disponible après la configuration de Firebase.',
      'cloud/invalid-user': 'Reconnecte-toi pour retrouver ton compte Google.',
      'cloud/invalid-data': 'La sauvegarde en ligne est illisible. Tes données locales sont conservées.',
      'cloud/invalid-revision': 'La version de la sauvegarde est invalide. Tes données locales sont conservées.',
      'cloud/payload-too-large': 'Cette sauvegarde est trop volumineuse pour la synchronisation. Exporte-la pour la conserver.',
      'cloud/conflict': 'Deux versions différentes existent. Choisis celle à conserver avant de synchroniser.',
      'cloud/server-unavailable': 'Le serveur n’a pas confirmé la sauvegarde. Réessaie avec une connexion Internet.',
      'auth/popup-blocked': 'Autorise la fenêtre de connexion Google, puis réessaie. Sur téléphone, ouvre Marge dans Safari ou Chrome si nécessaire.',
      'auth/popup-closed-by-user': 'La fenêtre Google a été fermée. Tu peux te reconnecter quand tu le souhaites.',
      'auth/cancelled-popup-request': 'Une connexion Google est déjà en cours.',
      'auth/unauthorized-domain': 'Ce site doit être ajouté aux domaines autorisés dans Firebase Authentication.',
      'auth/operation-not-allowed': 'La connexion Google doit être activée dans Firebase Authentication.',
      'auth/invalid-api-key': 'La configuration Web Firebase doit être vérifiée.',
      'auth/invalid-app-credential': 'La configuration Web Firebase doit être vérifiée.',
      'auth/configuration-not-found': 'La configuration de Firebase Authentication doit être terminée.',
      'auth/web-storage-unsupported': 'Le navigateur bloque le stockage de connexion. Autorise le stockage du site ou utilise un autre navigateur.',
      'auth/operation-not-supported-in-this-environment': 'Ouvre la version HTTPS de Marge dans Safari ou Chrome pour te connecter.',
      'auth/network-request-failed': 'Connexion impossible pour le moment. Tes données restent sur cet appareil.',
      'auth/user-disabled': 'Ce compte a été désactivé dans Firebase Authentication.',
      'auth/too-many-requests': 'Trop de tentatives de connexion. Patiente avant de réessayer.',
      'permission-denied': 'Firebase refuse l’accès. Vérifie les règles Firestore et le compte connecté.',
      'unauthenticated': 'Reconnecte-toi avec Google pour reprendre la synchronisation.',
      'unavailable': 'La synchronisation reprendra avec la connexion. Tes données restent sur cet appareil.',
      'deadline-exceeded': 'Le serveur met trop de temps à répondre. Tes données restent sur cet appareil.',
      'resource-exhausted': 'Le quota Firebase est atteint. Tes données restent sur cet appareil.',
      'failed-precondition': 'La base Firestore doit être créée et configurée avant la synchronisation.'
    };
    return messages[code] || 'La synchronisation n’a pas abouti. Tes données restent sur cet appareil.';
  }
  return Object.freeze({ SDK_VERSION: SDK_VERSION, MAX_PAYLOAD_BYTES: MAX_PAYLOAD_BYTES,
    isConfigured: isConfigured, load: load, createClient: createClient, createAdapter: createAdapter,
    humanMessage: humanMessage });
});
