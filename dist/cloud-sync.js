(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MargeCloudSync = factory();
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const copy = value => JSON.parse(JSON.stringify(value));
  // Exact canonical comparison, not a lossy hash. Navigation/export metadata is local.
  function fingerprint(value) {
    function sorted(v, top) {
      if (Array.isArray(v)) return v.map(x => sorted(x, false));
      if (v && typeof v === 'object') {
        const result = Object.create(null);
        Object.keys(v).sort().forEach(key => {
          if (!top || (key !== 'selectedMonth' && key !== 'lastExport')) result[key] = sorted(v[key], false);
        });
        return result;
      }
      return v;
    }
    return JSON.stringify(sorted(value, true));
  }

  /**
   * The app owns its local data. This controller never accesses Firebase directly.
   * adapter.listen(uid, next, error) -> unsubscribe, confirmed server documents only.
   * adapter.read(uid) -> Promise<document|null>.
   * adapter.write(uid, expectedRevision, data) -> Promise<committedDocument>.
   * write MUST use an atomic compare-and-set transaction (0 means absent).
   * A document is {revision: positive integer, data, updatedAt?: milliseconds}.
   * applyRemote(data) MUST synchronously validate/persist before returning true.
   */
  function create(options) {
    const o = options || {};
    if (!o.getData || !o.validate || !o.applyRemote || !o.storage) throw Error('Configuration de synchronisation incomplète.');
    const key = o.metadataKey || 'marge.cloud.meta.v1';
    const timerSet = o.setTimeout || setTimeout, timerClear = o.clearTimeout || clearTimeout;
    const clock = o.now || Date.now, delay = o.delay === undefined ? 180000 : o.delay;
    const enabled = () => !o.isEnabled || o.isEnabled();
    const busy = () => !!(o.isBusy && o.isBusy());
    const meaningful = () => o.hasLocalData ? !!o.hasLocalData() : true;
    let metadata = null, metadataError = false, user = null, adapter = null;
    let unsubscribe = null, timer = null, generation = 0, destroyed = false;
    let remote = null, remoteSeen = false, pendingRemote = false, writing = false, applying = false, observations = 0;
    let deferred = undefined, phase = 'disconnected', error = null, conflict = null, lastSynced = null;
    let emitting = false, emittedStatus = null;
    let observedLocalFingerprint = fingerprint(o.getData());
    const listeners = new Set();
    if (o.onChange) listeners.add(o.onChange);

    try {
      const raw = o.storage.getItem(key);
      if (raw) {
        const m = JSON.parse(raw);
        if (m.version !== 1 || typeof m.owner !== 'string' || !m.owner || !Number.isSafeInteger(m.baseRevision) || m.baseRevision < 0 || typeof m.baseFingerprint !== 'string' || typeof m.dirty !== 'boolean') throw Error('invalid metadata');
        metadata = m;
        lastSynced = Number.isFinite(m.lastSynced) ? m.lastSynced : null;
      }
    } catch (_) { metadataError = true; error = 'La référence de synchronisation locale est illisible. Exporte tes données avant de reconnecter ce compte.'; }

    const owned = () => !!(user && metadata && metadata.owner === user.uid);
    const localFingerprint = () => fingerprint(o.getData());
    const dirty = () => owned() ? localFingerprint() !== metadata.baseFingerprint : meaningful();
    function getStatus() {
      return { phase, user: user ? { ...user } : null, dirty: dirty(), remotePending: pendingRemote,
        conflict: conflict ? { ...conflict } : null, lastSynced, error,
        baseRevision: owned() ? metadata.baseRevision : null,
        remoteRevision: remoteSeen ? (remote ? remote.revision : 0) : null,
        remoteSummary: remoteSeen ? { months: Object.keys(remote?.data.months || {}).length,
          latestMonth: Object.keys(remote?.data.months || {}).sort().at(-1) || null, updatedAt: remote?.updatedAt || null } : null };
    }
    function emit() {
      const status = getStatus(), signature = JSON.stringify(status);
      if (emitting || signature === emittedStatus) return;
      emittedStatus = signature; emitting = true;
      try { listeners.forEach(fn => { try { fn(status); } catch (_) {} }); }
      finally { emitting = false; }
    }
    function clearTimer() { if (timer !== null) timerClear(timer); timer = null; }
    function stopListening() { if (unsubscribe) unsubscribe(); unsubscribe = null; }
    function fail(message, code) {
      error = message;
      phase = code === 'unavailable' || code === 'network-request-failed' || code === 'offline' ? 'offline' : 'error';
      clearTimer(); emit();
    }
    function remember(next) {
      try {
        o.storage.setItem(key, JSON.stringify(next));
        metadata = next; metadataError = false;
        return true;
      } catch (_) {
        metadataError = true;
        fail('La référence de sauvegarde ne peut pas être enregistrée sur cet appareil. La synchronisation est suspendue.');
        return false;
      }
    }
    function baseline(doc, fp) {
      const synced = clock();
      if (!remember({ version: 1, owner: user.uid, baseRevision: doc ? doc.revision : 0,
        baseFingerprint: fp, dirty: localFingerprint() !== fp, lastSynced: synced })) return false;
      lastSynced = synced;
      return true;
    }
    function validateDoc(doc) {
      if (doc === null) return null;
      if (!doc || typeof doc !== 'object' || !Number.isSafeInteger(doc.revision) || doc.revision < 1 || !doc.data || typeof doc.data !== 'object') throw Error('La sauvegarde en ligne a un format non reconnu.');
      o.validate(doc.data);
      return { revision: doc.revision, data: copy(doc.data), updatedAt: Number.isFinite(doc.updatedAt) ? doc.updatedAt : null };
    }
    function setConflict(reason) {
      conflict = { reason, remoteRevision: remote ? remote.revision : 0, remoteUpdatedAt: remote?.updatedAt || null };
      pendingRemote = false; error = null; phase = 'conflict'; clearTimer(); emit();
    }
    function schedule(restart) {
      if (restart) clearTimer();
      if (!user || !adapter || !enabled() || destroyed || metadataError || !owned() || !remoteSeen || conflict || writing) return;
      if (!dirty()) { clearTimer(); phase = 'ready'; emit(); return; }
      phase = 'pending'; emit();
      if (busy()) { clearTimer(); return; }
      if (timer === null) timer = timerSet(() => { timer = null; void flush(); }, delay);
    }
    function applyDocument(doc, explicit) {
      if (!doc) { setConflict('remote-deleted'); return false; }
      if (!enabled() || busy()) { pendingRemote = true; phase = 'pending'; emit(); return false; }
      // Replacing a changed local version is only allowed after an explicit choice.
      if (!explicit && owned() && dirty()) { setConflict('changed-both'); return false; }
      applying = true;
      try {
        if (o.applyRemote(copy(doc.data)) !== true) throw Error('La sauvegarde en ligne n’a pas pu être enregistrée sur cet appareil. Les données locales sont conservées.');
      } catch (e) { fail(e.message || 'Impossible de restaurer la sauvegarde en ligne.'); return false; }
      finally { applying = false; }
      observedLocalFingerprint = localFingerprint();
      pendingRemote = false; conflict = null; error = null;
      if (!baseline(doc, fingerprint(doc.data))) return false;
      phase = 'ready'; emit();
      schedule();
      return true;
    }
    function reconcile(doc) {
      remote = doc; remoteSeen = true;
      if (!user || !enabled()) { phase = user ? 'paused' : 'disconnected'; emit(); return; }
      if (metadataError) { phase = 'error'; emit(); return; }
      const local = localFingerprint(), online = doc ? fingerprint(doc.data) : null;
      if (owned() && doc && doc.revision < metadata.baseRevision) { setConflict('changed-remotely'); return; }
      if (doc && online === local) {
        pendingRemote = false; conflict = null; error = null;
        if (baseline(doc, online)) { phase = 'ready'; emit(); }
        return;
      }
      if (!owned()) {
        if (!meaningful()) {
          if (doc) applyDocument(doc, false);
          else if (baseline(null, local)) { conflict = null; error = null; phase = 'ready'; emit(); }
        } else setConflict(metadata ? 'account-change' : 'first-connection');
        return;
      }
      if (!doc) {
        if (metadata.baseRevision > 0) setConflict('remote-deleted');
        else { conflict = null; error = null; schedule(); }
        return;
      }
      if (doc.revision === metadata.baseRevision && online === metadata.baseFingerprint) {
        conflict = null; error = null; pendingRemote = false; schedule(); return;
      }
      if (doc.revision <= metadata.baseRevision) { setConflict('changed-remotely'); return; }
      if (local !== metadata.baseFingerprint) { setConflict('changed-both'); return; }
      if (busy()) { pendingRemote = true; phase = 'pending'; error = null; clearTimer(); emit(); return; }
      applyDocument(doc, false);
    }
    function receive(value, token) {
      if (token !== generation || destroyed || !user) return;
      let doc;
      try { doc = validateDoc(value); } catch (e) { fail(e.message); return; }
      observations++;
      // A slower read/listener cannot roll back a confirmed newer observation.
      if (doc && remoteSeen && remote && doc.revision < remote.revision) return;
      if (writing) {
        if (deferred === undefined || doc === null || deferred === null || doc.revision >= deferred.revision) deferred = doc;
        return;
      }
      reconcile(doc);
    }
    function listen() {
      if (!user || !adapter || unsubscribe || destroyed || !enabled()) return;
      const token = generation;
      try {
        unsubscribe = adapter.listen(user.uid, doc => receive(doc, token), e => {
          if (token === generation) { stopListening(); fail('La sauvegarde en ligne est momentanément indisponible. Tes données restent sur cet appareil.', e?.code); }
        });
      } catch (e) { fail('Impossible de joindre la sauvegarde en ligne.', e?.code); }
    }
    function connect(nextUser, nextAdapter) {
      clearTimer(); stopListening(); generation++; writing = false; deferred = undefined;
      remote = null; remoteSeen = false; pendingRemote = false; conflict = null;
      if (!nextUser?.uid) { user = null; adapter = null; lastSynced = null; phase = 'disconnected'; emit(); return; }
      if (!nextAdapter?.listen || !nextAdapter?.read || !nextAdapter?.write) throw Error('Adaptateur Firebase incomplet.');
      user = { uid: String(nextUser.uid), email: nextUser.email || '', displayName: nextUser.displayName || '' };
      lastSynced = owned() && Number.isFinite(metadata.lastSynced) ? metadata.lastSynced : null;
      adapter = nextAdapter; phase = metadataError ? 'error' : enabled() ? 'connecting' : 'paused';
      if (!metadataError) error = null;
      emit(); listen();
    }
    function disconnect() { connect(null, null); }
    function localChanged() {
      if (destroyed || applying || !enabled()) return;
      const currentFingerprint = localFingerprint();
      if (currentFingerprint === observedLocalFingerprint) return;
      observedLocalFingerprint = currentFingerprint;
      if (metadata && !metadataError) {
        const changed = currentFingerprint !== metadata.baseFingerprint;
        if (changed !== metadata.dirty && !remember({ ...metadata, dirty: changed })) return;
      }
      if (pendingRemote && remoteSeen) { reconcile(remote); return; }
      schedule(true);
    }
    async function readLatest(token) {
      const observedBeforeRead = observations;
      const value = await adapter.read(user.uid);
      if (token !== generation || destroyed) return false;
      if (observations === observedBeforeRead) receive(value, token);
      listen();
      return true;
    }
    async function upload(forceLocal, approvedRevision) {
      clearTimer();
      if (!user || !adapter || destroyed || !enabled() || busy() || writing || metadataError) return false;
      const token = generation, activeAdapter = adapter, owner = user.uid;
      try {
        if (!remoteSeen || phase === 'error' || phase === 'offline') {
          if (!await readLatest(token)) return false;
        }
        if (!enabled() || busy() || writing || token !== generation || metadataError) return false;
        if (forceLocal && approvedRevision !== (remote ? remote.revision : 0)) { setConflict('changed-remotely'); return false; }
        if (conflict && !forceLocal) return false;
        if (!forceLocal && !owned()) return false;
        if (!forceLocal && !dirty()) return true;
        const data = copy(o.getData()); o.validate(data);
        const sentFingerprint = fingerprint(data);
        const expectedRevision = forceLocal ? (remote ? remote.revision : 0) : metadata.baseRevision;
        const baseFingerprint = forceLocal ? (remote ? fingerprint(remote.data) : '') : metadata.baseFingerprint;
        if (!remember({ version: 1, owner, baseRevision: expectedRevision, baseFingerprint, dirty: true, lastSynced })) return false;
        writing = true; error = null; conflict = null; pendingRemote = false; phase = 'syncing'; emit();
        const committed = validateDoc(await activeAdapter.write(owner, expectedRevision, data));
        if (token !== generation || destroyed) return false;
        if (!committed || committed.revision !== expectedRevision + 1 || fingerprint(committed.data) !== sentFingerprint) throw Error('La confirmation de sauvegarde en ligne est incohérente.');
        writing = false;
        remote = committed; remoteSeen = true;
        if (!baseline(committed, sentFingerprint)) return false;
        phase = enabled() ? 'ready' : 'paused'; emit();
        const next = deferred; deferred = undefined;
        if (next !== undefined && (next === null || next.revision >= committed.revision)) reconcile(next);
        else schedule();
        return true;
      } catch (e) {
        if (token !== generation || destroyed) return false;
        writing = false;
        if (e?.code === 'cloud/conflict') {
          try {
            const latest = e.current !== undefined ? e.current : await activeAdapter.read(owner);
            if (token !== generation) return false;
            remote = validateDoc(latest); remoteSeen = true; deferred = undefined;
            setConflict('changed-both');
          } catch (_) { fail('Deux versions différentes existent. Actualise la synchronisation avant de choisir laquelle conserver.'); }
        } else fail(e?.message || 'Sauvegarde en ligne impossible. Tes modifications restent sur cet appareil.', e?.code);
        return false;
      }
    }
    function flush() { return upload(false); }
    function resume() {
      if (destroyed || !user || applying || emitting) return;
      if (!enabled()) { clearTimer(); stopListening(); phase = 'paused'; emit(); return; }
      listen();
      if (writing || metadataError || phase === 'error' || phase === 'offline') return;
      if (pendingRemote && !busy()) reconcile(remote);
      else if (!conflict && remoteSeen) schedule();
    }
    function chooseRemote(expectedRevision) {
      if (!user || !enabled() || writing || !remoteSeen || metadataError) return false;
      if (expectedRevision !== undefined && expectedRevision !== (remote ? remote.revision : 0)) { setConflict('changed-remotely'); return false; }
      return applyDocument(remote, true);
    }
    function chooseLocal(expectedRevision) {
      if (!remoteSeen) return Promise.resolve(false);
      if (expectedRevision === undefined) expectedRevision = remote ? remote.revision : 0;
      if (expectedRevision !== undefined && expectedRevision !== (remote ? remote.revision : 0)) { setConflict('changed-remotely'); return Promise.resolve(false); }
      return upload(true, expectedRevision);
    }
    function subscribe(fn) { listeners.add(fn); fn(getStatus()); return () => listeners.delete(fn); }
    function forgetLocalReference() {
      if (user || writing || destroyed) return false;
      try {
        if (o.storage.removeItem) o.storage.removeItem(key);
        else o.storage.setItem(key, '');
      } catch (_) { metadataError = true; fail('La référence de synchronisation n’a pas pu être retirée. La réinitialisation est interrompue.'); return false; }
      clearTimer(); metadata = null; metadataError = false; error = null; lastSynced = null;
      remote = null; remoteSeen = false; pendingRemote = false; conflict = null;
      observedLocalFingerprint = localFingerprint(); phase = 'disconnected'; emit();
      return true;
    }
    function destroy() { destroyed = true; generation++; clearTimer(); stopListening(); listeners.clear(); }
    return { connect, disconnect, localChanged, flush, resume, chooseRemote, chooseLocal, forgetLocalReference, getStatus, subscribe, destroy };
  }
  return { create, fingerprint };
}));
