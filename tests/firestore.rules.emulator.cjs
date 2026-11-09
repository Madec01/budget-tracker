'use strict';

// Optional integration suite. Run against the Firestore emulator only; see FIREBASE_SETUP.md.
// It deliberately does not match *.test.cjs, the dependency-free application test glob.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { initializeTestEnvironment, assertSucceeds, assertFails } = require('@firebase/rules-unit-testing');
const firestoreSDK = require('firebase/firestore');
const { doc, collection, getDoc, getDocs, setDoc, updateDoc, deleteDoc, serverTimestamp, Timestamp } = firestoreSDK;
const { createAdapter } = require('../dist/firebase.js');

const projectId = 'demo-marge-rules';
const host = process.env.FIRESTORE_EMULATOR_HOST;
if (!host || !/^(127\.0\.0\.1|localhost):\d+$/.test(host)) {
  throw new Error('Run this suite with a local FIRESTORE_EMULATOR_HOST; it must never contact production.');
}
let env;
const dbFor = uid => uid ? env.authenticatedContext(uid, { firebase: { sign_in_provider: 'google.com' } }).firestore() : env.unauthenticatedContext().firestore();
const backupRef = (db, uid = 'alice') => doc(db, 'users', uid, 'apps', 'marge');
const backup = (overrides = {}) => ({ schemaVersion: 1, revision: 1, payload: '{"version":1}', updatedAt: serverTimestamp(), ...overrides });

before(async () => {
  const [hostname, port] = host.split(':');
  env = await initializeTestEnvironment({ projectId, firestore: {
    host: hostname, port: Number(port), rules: fs.readFileSync(path.join(__dirname, '..', 'firestore.rules'), 'utf8')
  } });
});
beforeEach(async () => env.clearFirestore());
after(async () => env?.cleanup());

test('the owner can observe an absent backup, create it, read it and increment its revision', async () => {
  const ref = backupRef(dbFor('alice'));
  assert.equal((await assertSucceeds(getDoc(ref))).exists(), false);
  await assertSucceeds(setDoc(ref, backup()));
  assert.equal((await assertSucceeds(getDoc(ref))).data().revision, 1);
  await assertSucceeds(updateDoc(ref, { revision: 2, payload: '{"version":1,"changed":true}', updatedAt: serverTimestamp() }));
  assert.equal((await getDoc(ref)).data().revision, 2);
});

test('other users and unauthenticated clients cannot read or write an owner backup', async () => {
  await setDoc(backupRef(dbFor('alice')), backup());
  for (const uid of ['bob', null]) {
    const ref = backupRef(dbFor(uid));
    await assertFails(getDoc(ref));
    await assertFails(setDoc(ref, backup({ revision: 2 })));
    await assertFails(setDoc(backupRef(dbFor(uid), 'charlie'), backup()));
  }
});

test('listing, deleting, other app IDs and extra nested paths are denied', async () => {
  const db = dbFor('alice'), ref = backupRef(db);
  await setDoc(ref, backup());
  await assertFails(getDocs(collection(db, 'users', 'alice', 'apps')));
  await assertFails(getDocs(collection(db, 'users')));
  await assertFails(deleteDoc(ref));
  await assertFails(setDoc(doc(db, 'users', 'alice', 'apps', 'other-app'), backup()));
  await assertFails(setDoc(doc(db, 'users', 'alice', 'apps', 'marge', 'extra', 'document'), backup()));
});

test('the complete schema is required and unexpected fields are denied', async () => {
  const ref = backupRef(dbFor('alice'));
  for (const malformed of [
    backup({ schemaVersion: 2 }), backup({ schemaVersion: '1' }),
    backup({ payload: {} }), backup({ payload: '' }),
    backup({ extra: true }), backup({ updatedAt: 'now' })
  ]) await assertFails(setDoc(ref, malformed));
  for (const key of ['schemaVersion', 'revision', 'payload', 'updatedAt']) {
    const malformed = backup(); delete malformed[key];
    await assertFails(setDoc(ref, malformed));
  }
});

test('initial, stale, skipped and unsafe revisions are denied', async () => {
  const ref = backupRef(dbFor('alice'));
  for (const revision of [0, 2, '1', 1.5, 9007199254740992]) {
    await assertFails(setDoc(ref, backup({ revision })));
  }
  await setDoc(ref, backup());
  for (const revision of [1, 3, 2.5, '2']) {
    await assertFails(updateDoc(ref, { revision, updatedAt: serverTimestamp() }));
  }
});

test('the write requires the server timestamp of this request', async () => {
  const ref = backupRef(dbFor('alice'));
  await assertFails(setDoc(ref, backup({ updatedAt: Timestamp.fromMillis(0) })));
  await setDoc(ref, backup());
  await assertFails(updateDoc(ref, { revision: 2, updatedAt: Timestamp.fromMillis(1) }));
  await assertFails(updateDoc(ref, { revision: 2 }));
});

test('payload limit is enforced in UTF-8 bytes, including multibyte characters', async () => {
  const ref = backupRef(dbFor('alice'));
  await assertFails(setDoc(ref, backup({ payload: 'a'.repeat(700001) })));
  await assertFails(setDoc(ref, backup({ payload: '€'.repeat(233334) })));
  await assertSucceeds(setDoc(ref, backup({ payload: 'a'.repeat(700000) })));
  await assertSucceeds(setDoc(ref, backup({ revision: 2, payload: '€'.repeat(233333) })));
});

test('the real Firebase adapter roundtrips JSON and rejects one of two competing revisions', async () => {
  const first = createAdapter(firestoreSDK, dbFor('alice'));
  const second = createAdapter(firestoreSDK, dbFor('alice'));
  const initial = { version: 1, months: { '2026-11': { salary: 2200, checkpoints: [] } }, label: 'Épargne €' };

  assert.equal(await first.read('alice'), null);
  const created = await first.write('alice', 0, initial);
  assert.equal(created.revision, 1);
  assert.deepEqual(created.data, initial);
  const loaded = await second.read('alice');
  assert.equal(loaded.revision, 1);
  assert.deepEqual(loaded.data, initial);
  assert.ok(Number.isFinite(loaded.updatedAt) && loaded.updatedAt > 0);

  const results = await Promise.allSettled([
    first.write('alice', 1, { ...initial, device: 'computer' }),
    second.write('alice', 1, { ...initial, device: 'phone' })
  ]);
  const accepted = results.filter(result => result.status === 'fulfilled');
  const rejected = results.filter(result => result.status === 'rejected');
  assert.equal(accepted.length, 1);
  assert.equal(rejected.length, 1);
  assert.equal(accepted[0].value.revision, 2);
  assert.equal(rejected[0].reason.code, 'cloud/conflict');
  assert.equal(rejected[0].reason.current.revision, 2);
  assert.deepEqual(rejected[0].reason.current.data, accepted[0].value.data);

  const stored = await first.read('alice');
  assert.equal(stored.revision, 2);
  assert.deepEqual(stored.data, accepted[0].value.data);
});

test('the real adapter cannot read or write another account through a supplied UID', async () => {
  const owner = createAdapter(firestoreSDK, dbFor('alice'));
  await owner.write('alice', 0, { version: 1, marker: 'owner-data' });
  for (const uid of ['bob', null]) {
    const intruder = createAdapter(firestoreSDK, dbFor(uid));
    await assert.rejects(intruder.read('alice'), error => error.code === 'permission-denied');
    await assert.rejects(intruder.write('alice', 1, { version: 1, marker: 'rejected' }), error => error.code === 'permission-denied');
  }
  const unchanged = await owner.read('alice');
  assert.equal(unchanged.revision, 1);
  assert.equal(unchanged.data.marker, 'owner-data');
});
