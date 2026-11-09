(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MargeCloudUI = factory();
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const cloudIcon = '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 18h12a4 4 0 0 0 .5-8A6.5 6.5 0 0 0 6 8a5 5 0 0 0 0 10Z"/></svg>';
  const dateLabel = value => value ? new Date(value).toLocaleString('fr-FR', {day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'}) : '';

  function create(options) {
    const o = options;
    let client = null, loading = false, authBusy = false, loadError = '', authUnsubscribe = null;
    const configured = o.firebase.isConfigured(o.config);
    const controller = o.sync.create({...o, onChange: () => change()});
    function change() { if (o.onChange) o.onChange(); }
    function status() {
      const s = controller.getStatus();
      if (!configured) return {...s,phase:'unconfigured',error:null};
      if (loadError) return {...s,phase:'error',error:loadError};
      if (loading || authBusy) return {...s,phase:'connecting'};
      return s;
    }
    function label(s = status()) {
      if (s.phase === 'unconfigured') return 'Sauvegarde';
      if (s.phase === 'disconnected') return 'Connexion Google';
      if (s.phase === 'connecting') return 'Connexion…';
      if (s.phase === 'conflict') return 'À vérifier';
      if (s.phase === 'error') return 'Sauvegarde à vérifier';
      if (s.phase === 'offline') return 'Hors connexion';
      if (s.phase === 'syncing') return 'Sauvegarde…';
      if (s.phase === 'paused') return 'Synchro en pause';
      if (s.remotePending) return 'Mise à jour reçue';
      if (s.dirty && s.user) return 'À synchroniser';
      return 'Sauvegardé';
    }
    function badge() {
      const s = status(), text = label(s);
      const tone = ['error','conflict'].includes(s.phase) ? 'is-error' : s.phase === 'ready' && !s.dirty ? 'is-ok' : s.user ? 'is-pending' : '';
      return `<button class="cloud-button ${tone}" data-action="cloud" data-state="${esc(s.phase)}" aria-label="Compte Google et sauvegarde : ${esc(text)}" title="${esc(text)}">${cloudIcon}<span class="cloud-button-label">${esc(text)}</span></button>`;
    }
    function detail(s) {
      if (s.error) return s.error;
      if (s.phase === 'connecting') return 'Connexion à ton espace de sauvegarde…';
      if (s.phase === 'syncing') return 'Envoi de tes modifications en cours. La copie locale est déjà enregistrée.';
      if (s.remotePending) return 'Une version plus récente est disponible. Termine ta saisie et ferme cette fenêtre pour la recevoir.';
      if (s.phase === 'offline') return 'Tes modifications restent sur cet appareil et seront synchronisées au retour de la connexion.';
      if (s.phase === 'paused') return 'La synchronisation reprendra lorsque les données pourront être enregistrées.';
      if (s.dirty && s.user) return 'Modifications enregistrées sur cet appareil. Envoi automatique après 3 minutes sans nouvelle modification, une fois les saisies fermées.';
      if (s.user) return 'Tes budgets, relevés, reports et prévisions sont synchronisés. Les prochains changements seront regroupés pendant 3 minutes avant envoi.';
      return 'Retrouve tes budgets sur ton téléphone et ton ordinateur avec le même compte Google.';
    }
    function choices(s) {
      if (!s.conflict) return '';
      const localCount = Object.keys(o.getData().months || {}).length;
      const remote = s.remoteSummary;
      const first = ['first-connection','account-change'].includes(s.conflict.reason);
      return `<div class="cloud-choice"><h3>${first?'Quelle sauvegarde utiliser ?':'Deux versions à départager'}</h3><p>${first?'Cet appareil contient déjà des données. Choisis celles à utiliser avec ce compte Google.':'Des modifications différentes existent sur deux appareils. Choisis la version complète à conserver.'}</p><p class="cloud-note">Cet appareil : ${localCount} mois enregistré${localCount>1?'s':''}.<br>Compte Google : ${remote?.months || 0} mois enregistré${remote?.months>1?'s':''}${remote?.updatedAt?` · ${esc(dateLabel(remote.updatedAt))}`:''}.</p><p class="cloud-note">La version choisie remplacera l’autre. Tu peux exporter la copie de cet appareil avant de choisir.</p><div class="cloud-actions"><button class="btn secondary" data-action="export">Exporter cet appareil</button>${s.remoteRevision>0?`<button class="btn secondary" data-action="cloud-use-remote" data-revision="${s.remoteRevision}">Utiliser la sauvegarde Google</button>`:''}<button class="btn primary" data-action="cloud-use-local" data-revision="${s.remoteRevision ?? 0}">${s.remoteRevision>0?'Utiliser les données de cet appareil':'Sauvegarder cet appareil sur Google'}</button></div></div>`;
    }
    function panel() {
      const s = status();
      if (!configured) return '<div class="cloud-summary"><h3>Connexion Google</h3><p>La connexion sera disponible une fois le projet Firebase raccordé à Marge.</p><p class="cloud-note">Tes données restent enregistrées sur cet appareil. L’export JSON reste disponible.</p></div>';
      return `<div class="cloud-summary">${s.user?`<div class="cloud-identity"><strong>${esc(s.user.displayName || 'Mon compte Google')}</strong><span>${esc(s.user.email)}</span></div>`:'<h3>Mes sauvegardes avec Google</h3>'}<div class="cloud-status-detail" role="status"><strong>${esc(label(s))}</strong><p>${esc(detail(s))}</p>${s.user&&s.lastSynced?`<small>Dernière synchronisation : ${esc(dateLabel(s.lastSynced))}</small>`:''}</div>${choices(s)}<div class="cloud-actions">${!client?`<button class="btn secondary" data-action="cloud-retry" ${loading?'disabled':''}>${loading?'Préparation…':'Réessayer la connexion'}</button>`:s.user?`<button class="btn secondary" data-action="cloud-sync" ${authBusy||s.phase==='syncing'||s.conflict?'disabled':''}>Synchroniser maintenant</button><button class="btn text-btn" data-action="cloud-logout" ${authBusy||s.phase==='syncing'?'disabled':''}>Se déconnecter</button>`:`<button class="btn google-signin" data-action="cloud-login" ${authBusy||loading?'disabled':''}><span class="google-mark" aria-hidden="true">G</span>Se connecter avec Google</button>`}</div><p class="cloud-note">${s.user?'La déconnexion conserve la copie sur cet appareil. ':'La connexion permet de sauvegarder tes données budgétaires dans ton espace Firebase. '}Sans connexion Internet, tu peux continuer à utiliser ta copie locale. Le mode démonstration reste séparé.</p></div>`;
    }
    async function start() {
      if (!configured || client || loading) return;
      loading = true; loadError = ''; change();
      try {
        if (o.protocol === 'file:') throw Object.assign(Error('Ouvre Marge depuis son adresse GitHub Pages pour utiliser la connexion Google.'), {code:'cloud/local-file'});
        client = await o.firebase.load(o.config);
        authUnsubscribe = client.onUser(user => {
          authBusy = false;
          if (user) controller.connect(user, client.adapter);
          else controller.disconnect();
          change();
        }, error => { loadError = o.firebase.humanMessage(error); change(); });
      } catch (e) { loadError = e.code === 'cloud/local-file' ? e.message : o.firebase.humanMessage(e); }
      finally { loading = false; change(); }
    }
    async function action(name, revision) {
      if (name === 'cloud-retry') { await start(); return !loadError; }
      if (name === 'cloud-sync') return controller.flush();
      if (name === 'cloud-use-local') return controller.chooseLocal(revision);
      if (name === 'cloud-use-remote') return controller.chooseRemote(revision);
      if (!client || authBusy) return false;
      authBusy = true; loadError = ''; change();
      try {
        if (name === 'cloud-login') await client.signIn();
        else if (name === 'cloud-logout') { await client.signOut(); controller.disconnect(); }
        else return false;
        return true;
      } catch (e) { loadError = o.firebase.humanMessage(e); return false; }
      finally { authBusy = false; change(); }
    }
    function retryOnline() { if (!client) void start(); else { controller.resume(); void controller.flush(); } }
    return {start,action,badge,panel,status,localChanged:controller.localChanged,resume:controller.resume,retryOnline,forgetLocalReference:()=>controller.forgetLocalReference(),
      destroy(){authUnsubscribe?.();controller.destroy();},isBusy(){return authBusy||loading||status().phase==='syncing';}};
  }
  return {create};
}));
