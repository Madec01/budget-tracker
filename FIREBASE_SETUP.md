# Activer Google et Firebase dans Marge

Marge reste publiée sur GitHub Pages. Firebase apporte la connexion Google et la copie privée des budgets entre les appareils. La configuration Web du projet `marge-6e2c9` est intégrée. L’activation de Google, le domaine autorisé et les règles Firestore doivent être configurés dans sa console.

## 1. Préparer le projet

Dans la [console Firebase](https://console.firebase.google.com/), créer un projet dédié à Marge ou choisir le projet prévu pour cette application. Ajouter une application **Web** dans **Paramètres du projet → Général → Vos applications**. Google Analytics n’est pas nécessaire.

Copier l’objet `firebaseConfig` généré par Firebase pour le transmettre à la personne qui raccorde Marge. Ces identifiants Web, y compris `apiKey`, sont publics par conception : l’accès aux budgets sera protégé par l’authentification et les règles Firestore. Ne transmettre aucun mot de passe Google, jeton de connexion, clé privée ni fichier de compte de service.

Pour raccorder un autre projet, remplacer l’objet dans `dist/firebase-config.js` par sa configuration Web, en conservant l’affectation `window.MargeFirebaseConfig = ...`. Exécuter ensuite `python3 publish.py` et publier les sources ainsi que les fichiers générés sur GitHub Pages. Une configuration à `null` désactive la connexion Google et conserve le fonctionnement local.

## 2. Activer la connexion Google

Dans **Authentication → Sign-in method**, activer le fournisseur **Google** et choisir l’adresse d’assistance demandée par Firebase.

Dans **Authentication → Settings → Authorized domains**, ajouter exactement :

```text
madec01.github.io
```

Ne pas ajouter `https://` ni `/budget-tracker/`. Conserver les domaines Firebase créés pour le projet. Pour des essais locaux, autoriser également `localhost` si nécessaire. La connexion depuis un fichier `file://` n’est pas prévue : utiliser la version HTTPS de Marge.

## 3. Créer la base et publier les règles

Dans **Firestore Database**, créer la base **par défaut**, en édition **Standard** et en **mode production**. Choisir une région adaptée au projet, par exemple une région européenne pour cet usage en France.

Dans l’onglet **Rules**, remplacer les règles d’un projet dédié par le contenu exact de [firestore.rules](firestore.rules), puis publier. Ne pas activer un accès public ou un mode test pour contourner une erreur de connexion.

Si le projet héberge déjà d’autres applications, fusionner leurs règles et leurs définitions d’index avec celles de Marge avant tout déploiement : une publication de règles remplace le jeu complet du projet. Un accès global déjà présent, tel que `allow read, write: if true`, rendrait la protection de Marge inefficace malgré ce fichier.

Le fichier [firestore.indexes.json](firestore.indexes.json) désactive l’indexation de `payload` dans le groupe de collections `apps`. Le budget est lu par son chemin exact ; aucune recherche dans son JSON n’est utilisée.

Avec la [CLI Firebase officielle](https://firebase.google.com/docs/cli), les deux fichiers peuvent être publiés depuis la racine du dépôt :

```sh
firebase login
firebase deploy --only firestore:rules,firestore:indexes --project IDENTIFIANT_DU_PROJET
```

Remplacer `IDENTIFIANT_DU_PROJET` par le `projectId` réel. Ce dépôt ne contient aucune configuration Firebase Hosting ; cette commande ne change pas l’adresse GitHub Pages.

## 4. Vérifier avec les deux appareils

Avant la première connexion, exporter la sauvegarde locale depuis les préférences de Marge. Se connecter ensuite avec le même compte Google sur l’ordinateur et le téléphone.

Vérifier les cas suivants avec un petit changement réversible :

1. Le compte Google et l’état de sauvegarde apparaissent dans Marge.
2. Un budget enregistré sur un appareil est récupéré sur l’autre.
3. Hors connexion, une modification reste disponible localement ; elle est proposée à la synchronisation au retour du réseau.
4. Si les deux appareils contiennent des versions différentes, l’application demande laquelle conserver au lieu de remplacer silencieusement une version.
5. Un autre compte Google ne voit pas les budgets du premier compte.

La connexion Google et l’isolation réelle des comptes doivent être vérifiées sur le projet configuré. Les tests locaux du code ne valident pas l’activation du fournisseur Google ni les domaines autorisés dans la console.

## Fonctionnement de la synchronisation

Une modification enregistrée reste immédiatement dans la sauvegarde locale. Après trois minutes sans nouvel enregistrement, Marge tente de synchroniser le budget si un compte est connecté. L’application écoute uniquement le document privé de ce compte ; elle ne parcourt pas la base et ne lance pas de vérifications en boucle. Les changements de mois affiché, le thème et la date du dernier export restent propres à chaque appareil.

Une modification distante attend la fin d’une saisie en cours avant d’être appliquée. Les révisions permettent de détecter deux modifications concurrentes. Le cache des budgets reste celui de Marge ; le SDK Firestore utilise son cache mémoire, tandis que Firebase Authentication conserve la session de connexion.

## Structure protégée

Chaque utilisateur dispose d’un seul document :

```text
users/{uid}/apps/marge
```

| Champ | Contenu |
| --- | --- |
| `schemaVersion` | Entier `1` |
| `revision` | Entier `1` à la création, puis révision précédente + 1 |
| `payload` | Sauvegarde JSON de Marge, au maximum 700 000 octets UTF-8 |
| `updatedAt` | Horodatage serveur Firestore |

Les règles n’autorisent que la lecture et l’écriture du document correspondant à l’UID connecté. Elles refusent les listes de collections, les suppressions, les champs inattendus, les sauts de révision et les horodatages fournis arbitrairement. L’application doit utiliser une transaction qui compare la révision attendue avant de sauvegarder ; l’incrément seul ne remplace pas cette comparaison.

Les règles contrôlent l’enveloppe de la sauvegarde ; elles ne déchiffrent ni ne valident le contenu JSON de `payload`. Marge valide ce contenu avant de l’appliquer. L’accès propriétaire repose sur l’UID Firebase, et non sur une adresse courriel modifiable. Aucune liste de comptes personnels n’est publiée dans le dépôt.

Cette limite conserve une marge sous la taille maximale d’un document Firestore. Si elle est atteinte, la copie locale et l’export JSON restent à conserver ; ne pas tronquer la sauvegarde pour forcer son envoi.

## Tester les règles localement

Le test facultatif `tests/firestore.rules.emulator.cjs` vérifie l’isolation des comptes, les champs, les révisions, les horodatages, la limite UTF-8 et les écritures concurrentes de l’adaptateur Firebase réel. Il n’est pas inclus dans `node --test tests/*.test.cjs`, qui reste sans dépendance externe.

Avec Node.js et Java 21 installés, depuis la racine du dépôt :

```sh
npm install --no-save --package-lock=false firebase-tools@15.35.0 @firebase/rules-unit-testing@6.0.0 firebase@13.2.0
npx firebase emulators:exec --only firestore --project demo-marge-rules "node --test tests/firestore.rules.emulator.cjs"
```

Le préfixe `demo-` utilise un projet fictif. Le test refuse de démarrer sans un émulateur sur `localhost` ou `127.0.0.1` et ne doit jamais être pointé vers une base de production. Les dépendances et les journaux générés sont exclus du dépôt.

## En cas de problème

| Message ou symptôme | Vérification |
| --- | --- |
| Connexion indisponible | Configuration Web raccordée à Marge et accès Internet |
| `auth/unauthorized-domain` | `madec01.github.io` présent dans les domaines autorisés |
| `auth/operation-not-allowed` | Fournisseur Google activé |
| Fenêtre Google bloquée | Autoriser la fenêtre de connexion, puis utiliser à nouveau le bouton |
| `permission-denied` | Bon projet Firebase, base par défaut créée, règles publiées et utilisateur connecté |
| Deux versions différentes | Vérifier la date et le contenu avant de choisir la version à garder |

## Références officielles

- [Enregistrer une application Web Firebase](https://firebase.google.com/docs/web/setup)
- [Configuration Web et identifiants non secrets](https://firebase.google.com/docs/web/learn-more#config-object)
- [Connexion Google sur le Web](https://firebase.google.com/docs/auth/web/google-signin)
- [Validation des champs par les règles Firestore](https://firebase.google.com/docs/firestore/security/rules-fields)
- [Transactions et concurrence](https://firebase.google.com/docs/firestore/manage-data/transactions)
- [Limites de Firestore](https://firebase.google.com/docs/firestore/quotas)
- [Conversion UTF-8 dans les règles](https://firebase.google.com/docs/reference/rules/rules.String#toUtf8)
