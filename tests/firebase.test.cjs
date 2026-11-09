'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const Bridge = require('../dist/firebase.js');

const config = {
  apiKey: 'synthetic_public_web_key_1234567890',
  authDomain: 'marge-test-project.firebaseapp.com',
  projectId: 'marge-test-project', appId: '1:123456789:web:abc123'
};
const copy = value => JSON.parse(JSON.stringify(value));
const state = () => ({ version: 1, months: { '2026-11': { salary: 2500 } } });
function envelope(data = state(), revision = 1) {
  return { schemaVersion: 1, revision, payload: JSON.stringify(data), updatedAt: { toMillis: () => 1700000000000 } };
}
function snapshot(value, metadata = {}) {
  return { exists: () => value !== null, data: () => value,
    metadata: { fromCache: false, hasPendingWrites: false, ...metadata } };
}
function harness(initial = null) {
  const controls = { saved: [], reads: 0, refs: [], transactionReads: 0, remote: initial, serverError: null, writeError: null, deliveries: [] };
  const sdk = {
    doc(db, ...path) { const ref = { db, path }; controls.refs.push(ref); return ref; },
    onSnapshot(ref, options, next, error) {
      controls.listen = { ref, options, next, error, stopped: false };
      return () => { controls.listen.stopped = true; };
    },
    async getDocFromServer() { controls.reads++; if (controls.serverError) throw controls.serverError; return snapshot(controls.remote); },
    serverTimestamp() { return 'SERVER_TIMESTAMP_SENTINEL'; },
    async runTransaction(db, callback) {
      if (controls.writeError) throw controls.writeError;
      let staged = null;
      const result = await callback({
        async get(ref) { controls.transactionReads++; return snapshot(controls.remote); },
        set(ref, value) { staged = { ref, value }; }
      });
      if (staged) {
        controls.saved.push(staged);
        controls.remote = { ...staged.value, updatedAt: { toMillis: () => 1700000000123 } };
      }
      return result;
    }
  };
  return { controls, sdk, adapter: Bridge.createAdapter(sdk, { name: 'database' }) };
}

test('web configuration must be complete and cannot supply arbitrary URL syntax', async () => {
  assert.equal(Bridge.isConfigured(config), true);
  for (const value of [null, {}, { ...config, apiKey: '' }, { ...config, authDomain: 'https://example.com/path' },
    { ...config, projectId: '../another-project' }, { ...config, appId: '1:123:ios:abc' }]) {
    assert.equal(Bridge.isConfigured(value), false);
  }
  await assert.rejects(Bridge.load(null), { code: 'cloud/not-configured' });
});

test('only a single owner document is addressed and cached/pending snapshots never reach consumers', () => {
  const h = harness(), values = [], errors = [];
  const stop = h.adapter.listen('synthetic-user', value => values.push(value), error => errors.push(error));
  assert.deepEqual(h.controls.listen.ref.path, ['users', 'synthetic-user', 'apps', 'marge']);
  assert.deepEqual(h.controls.listen.options, { includeMetadataChanges: true });
  h.controls.listen.next(snapshot(envelope(), { fromCache: true }));
  h.controls.listen.next(snapshot(envelope(), { hasPendingWrites: true }));
  assert.equal(values.length, 0);
  h.controls.listen.next(snapshot(envelope()));
  assert.deepEqual(values, [{ revision: 1, data: state(), updatedAt: 1700000000000 }]);
  h.controls.listen.next(snapshot(null));
  assert.equal(values[1], null);
  assert.equal(errors.length, 0);
  stop(); assert.equal(h.controls.listen.stopped, true);
});

test('server reads preserve revisions and reject invalid cloud envelopes rather than inventing empty data', async () => {
  const h = harness(envelope(state(), 7));
  assert.deepEqual(await h.adapter.read('synthetic-user'), { revision: 7, data: state(), updatedAt: 1700000000000 });
  assert.equal(h.controls.reads, 1);
  for (const invalid of [
    {}, { ...envelope(), extra: true }, { ...envelope(), schemaVersion: 2 },
    { ...envelope(), revision: 0 }, { ...envelope(), revision: 1.5 }, { ...envelope(), revision: Number.MAX_SAFE_INTEGER + 1 },
    { ...envelope(), payload: '{bad' }, { ...envelope(), payload: '[]' }, { ...envelope(), payload: 'null' },
    { ...envelope(), updatedAt: null }, { ...envelope(), updatedAt: { toMillis: () => NaN } }
  ]) {
    h.controls.remote = invalid;
    await assert.rejects(h.adapter.read('synthetic-user'), { code: 'cloud/invalid-data' });
  }
});

test('listener validation and Firebase errors expose French messages without raw diagnostic information', () => {
  const h = harness(), errors = [];
  h.adapter.listen('synthetic-user', () => {}, error => errors.push(error));
  h.controls.listen.next(snapshot({ ...envelope(), payload: '{invalid' }));
  h.controls.listen.error({ code: 'permission-denied', message: 'SDK details / sensitive diagnostic contents' });
  assert.equal(errors[0].code, 'cloud/invalid-data');
  assert.match(errors[0].message, /sauvegarde en ligne est illisible/);
  assert.equal(errors[1].code, 'permission-denied');
  assert.match(errors[1].message, /règles Firestore/);
  assert.doesNotMatch(errors[1].message, /sensitive|SDK details/);
});

test('creating a cloud document writes version one atomically without a second server read', async () => {
  const h = harness(), local = state(), before = copy(local);
  const saved = await h.adapter.write('synthetic-user', 0, local);
  assert.equal(saved.revision, 1);
  assert.deepEqual(saved.data, local);
  assert.ok(Number.isFinite(saved.updatedAt));
  assert.equal(h.controls.reads, 0);
  assert.equal(h.controls.transactionReads, 1);
  assert.equal(h.controls.saved.length, 1);
  assert.deepEqual(h.controls.saved[0].value, {
    schemaVersion: 1, revision: 1, payload: JSON.stringify(local), updatedAt: 'SERVER_TIMESTAMP_SENTINEL'
  });
  assert.deepEqual(local, before);
  saved.data.months['2026-11'].salary = 1;
  assert.equal(local.months['2026-11'].salary, 2500);
});

test('a matching revision is incremented and the submitted snapshot is frozen before asynchronous work', async () => {
  const h = harness(envelope(state(), 4)), local = state();
  const pending = h.adapter.write('synthetic-user', 4, local);
  local.months['2026-11'].salary = 2800;
  const saved = await pending;
  assert.equal(saved.revision, 5);
  assert.equal(saved.data.months['2026-11'].salary, 2500);
  assert.equal(JSON.parse(h.controls.saved[0].value.payload).months['2026-11'].salary, 2500);
});

test('concurrent changes never overwrite cloud data and report the current confirmed version', async () => {
  const remote = state(); remote.months['2026-11'].salary = 2600;
  for (const [initial, expected, revision] of [[envelope(remote, 4), 3, 4], [envelope(remote), 0, 1], [null, 1, null]]) {
    const h = harness(initial);
    await assert.rejects(h.adapter.write('synthetic-user', expected, state()), error => {
      assert.equal(error.code, 'cloud/conflict');
      assert.equal(error.current?.revision ?? null, revision);
      if (revision) assert.deepEqual(error.current.data, remote);
      assert.match(error.message, /Deux versions différentes/);
      return true;
    });
    assert.equal(h.controls.saved.length, 0);
  }
});

test('a server rejection is not reported as a successful write and never leaks its raw error message', async () => {
  const h = harness();
  h.controls.writeError = { code: 'unavailable', message: 'raw server debug' };
  await assert.rejects(h.adapter.write('synthetic-user', 0, state()), error => {
    assert.equal(error.code, 'unavailable'); assert.match(error.message, /données restent/);
    assert.doesNotMatch(error.message, /raw server/); return true;
  });
  assert.equal(h.controls.saved.length, 0);
  h.controls.serverError = { code: 'permission-denied', message: 'raw server debug' };
  await assert.rejects(h.adapter.read('synthetic-user'), error => {
    assert.equal(error.code, 'permission-denied'); assert.match(error.message, /règles Firestore/); return true;
  });
});

test('a rule-denied racing write becomes a conflict after one exceptional server read', async () => {
  const remote = state(); remote.months['2026-11'].salary = 2650;
  const h = harness(envelope(remote, 2));
  h.controls.writeError = { code: 'permission-denied', message: 'Stale revision rejected by rules' };
  await assert.rejects(h.adapter.write('synthetic-user', 1, state()), error => {
    assert.equal(error.code, 'cloud/conflict');
    assert.equal(error.current.revision, 2);
    assert.deepEqual(error.current.data, remote);
    return true;
  });
  assert.equal(h.controls.reads, 1);
  assert.equal(h.controls.saved.length, 0);
});

test('permission failures with unchanged or unreadable data stay permission failures', async () => {
  for (const mode of ['same-revision', 'read-denied', 'invalid-data']) {
    const h = harness(mode === 'invalid-data' ? {} : envelope(state(), 1));
    h.controls.writeError = { code: 'permission-denied', message: 'Original access denial' };
    if (mode === 'read-denied') h.controls.serverError = { code: 'unavailable', message: 'Read failed' };
    await assert.rejects(h.adapter.write('synthetic-user', 1, state()), error => {
      assert.equal(error.code, 'permission-denied');
      assert.equal(Object.hasOwn(error, 'current'), false);
      assert.match(error.message, /règles Firestore/);
      return true;
    });
    assert.equal(h.controls.reads, 1, mode);
    assert.equal(h.controls.saved.length, 0, mode);
  }
});

test('a document removed during a denied update reports a missing-document conflict', async () => {
  const h = harness(null);
  h.controls.writeError = { code: 'permission-denied', message: 'Removed during the update' };
  await assert.rejects(h.adapter.write('synthetic-user', 3, state()), error => {
    assert.equal(error.code, 'cloud/conflict'); assert.equal(error.current, null); return true;
  });
  assert.equal(h.controls.reads, 1);
});

test('UTF-8 size limits count multibyte characters before any transaction', async () => {
  const h = harness();
  const over = { note: 'é'.repeat(350000) };
  assert.ok(JSON.stringify(over).length < Bridge.MAX_PAYLOAD_BYTES);
  await assert.rejects(h.adapter.write('synthetic-user', 0, over), { code: 'cloud/payload-too-large' });
  assert.equal(h.controls.transactionReads, 0);
  h.controls.remote = envelope(over);
  await assert.rejects(h.adapter.read('synthetic-user'), { code: 'cloud/invalid-data' });
});

test('invalid ids, revisions and non-JSON data cannot reach a transaction', async () => {
  const h = harness(), cyclic = {}; cyclic.self = cyclic;
  for (const uid of ['', '../other', 'one/two', '.', '..', '__reserved__', 'a'.repeat(129), null]) {
    await assert.rejects(h.adapter.write(uid, 0, state()), { code: 'cloud/invalid-user' });
  }
  for (const revision of [-1, 0.5, NaN, Number.MAX_SAFE_INTEGER]) {
    await assert.rejects(h.adapter.write('synthetic-user', revision, state()), { code: 'cloud/invalid-revision' });
  }
  for (const data of [null, [], undefined, cyclic, { value: 1n }]) {
    await assert.rejects(h.adapter.write('synthetic-user', 0, data), { code: 'cloud/invalid-data' });
  }
  assert.equal(h.controls.transactionReads, 0);
});

test('Google popup begins synchronously after initialization and exposes only public identity', async () => {
  const calls = [], auth = {}, database = {}, user = { uid: 'synthetic-user', email: 'example@example.test', displayName: 'Example', accessToken: 'never expose' };
  const sdk = {
    ...harness().sdk,
    getApps: () => [],
    initializeApp(options, name) { calls.push(['initialize', options, name]); return { name }; },
    getAuth: () => auth,
    async setPersistence(value, persistence) { calls.push(['persistence', value, persistence]); },
    browserLocalPersistence: 'LOCAL',
    getFirestore: () => database,
    GoogleAuthProvider: class { setCustomParameters(value) { calls.push(['provider', value]); } },
    signInWithPopup(value, provider) { calls.push(['popup', value, provider]); return Promise.resolve({ user, credential: 'secret' }); },
    signOut(value) { calls.push(['signout', value]); return Promise.resolve(); },
    onAuthStateChanged(value, next, error) { calls.push(['auth-listener', value]); next(user); return () => calls.push(['unsubscribe']); }
  };
  const client = await Bridge.createClient(sdk, config);
  assert.deepEqual(calls.find(c => c[0] === 'provider')[1], { prompt: 'select_account' });
  const login = client.signIn();
  assert.equal(calls.at(-1)[0], 'popup', 'The popup starts before awaiting a promise.');
  assert.deepEqual(await login, { uid: user.uid, email: user.email, displayName: user.displayName });
  let identity;
  const stop = client.onUser(value => { identity = value; });
  assert.deepEqual(identity, { uid: user.uid, email: user.email, displayName: user.displayName });
  assert.equal(identity.accessToken, undefined);
  stop(); await client.signOut();
  assert.equal(calls.at(-1)[0], 'signout');
  assert.equal(calls.some(c => c[0] === 'persistence'), true);
});

test('friendly messages never display unknown SDK error contents', () => {
  assert.match(Bridge.humanMessage({ code: 'auth/popup-blocked' }), /Autorise la fenêtre/);
  assert.match(Bridge.humanMessage({ code: 'auth/unauthorized-domain' }), /domaines autorisés/);
  assert.match(Bridge.humanMessage({ code: 'resource-exhausted' }), /quota Firebase/);
  assert.doesNotMatch(Bridge.humanMessage({ code: 'unknown', message: 'private details' }), /private details/);
});

test('standalone browser bridge does not require Firebase or network just to load', () => {
  const context = { TextEncoder, Map, Object, Promise };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(require.resolve('../dist/firebase.js'), 'utf8'), context);
  assert.equal(typeof context.MargeFirebase.load, 'function');
  assert.equal(context.MargeFirebase.isConfigured(null), false);
  assert.equal(context.MargeFirebase.SDK_VERSION, '13.2.0');
});
