# Marge

Application HTML autonome de budget mensuel, pensée pour le téléphone et utilisable sur ordinateur. Interface en français, sans dépendance externe ni connexion bancaire. La version hébergée peut s’installer comme une application Web (PWA).

Le mois se présente comme un relevé épuré : deux onglets en haut, les montants utiles, les virements, puis les réserves. Les pourcentages se déplient dans Budget ; historique, progrès et sauvegardes sont regroupés dans le menu ⋯.

## Commencer

Ouvrir l’adresse HTTPS publiée sur GitHub Pages, ou le fichier `index.html` à la racine du dépôt. Le bouton **Voir un exemple** ouvre des données fictives sans remplacer les données personnelles.

1. Dans **Budget**, renseigner les dépenses CA et Revolut et enregistrer.
2. Dans **Vue d’ensemble**, préparer le mois : salaire, soldes de départ et Livret A.
3. Effectuer les virements proposés depuis ses applications bancaires, puis les pointer dans Marge.
4. En fin de période, saisir les soldes réels et clôturer. Le mois suivant reprend le Livret A et le tampon : soldes réels après clôture, prévisions sinon. Les mois ouverts liés se recalculent quand le mois source change.

Le salaire arrive sur CA. Le Livret A est une épargne séparée. Le tampon est une réserve du compte CA, exclue du budget utilisable. Le virement Revolut est net de l’argent déjà présent sur ce compte ; il peut donc être un retour vers CA. Les montants pointés sont mémorisés : si le plan change ensuite, seule la différence reste à effectuer. Décocher une opération annule uniquement son pointage, jamais un mouvement bancaire.

Les soldes de départ sont ceux du début de période avant répartition. Si le salaire est déjà inclus dans CA, cocher l’option correspondante. Les soldes de clôture sont relevés avant le salaire suivant et après déduction des paiements en attente.

## Reports et prévisions

Le Livret A et le tampon se reportent indépendamment. Dans **Ajuster mon mois**, les cases de report automatique gardent les mois ouverts liés entre eux. Décochez l’une des cases pour saisir le solde réel correspondant (retrait, intérêts ou correction). Les anciens mois déjà préparés restent manuels pour préserver leurs données ; activez leurs reports depuis le lien de la vue d’ensemble.

- Clôture précédente : CA et Revolut réels sont repris séparément ; Livret A réel repris.
- Mois précédent ouvert : tampon prévu sur CA, Revolut à zéro, salaire exclu ; Livret A prévu repris. La source est marquée prévisionnelle.
- Une clôture remplace les prévisions par le réel dans les mois suivants liés. Les mois déjà clôturés restent figés.
- Un déficit non financé reste visible dans les projections au lieu de disparaître. Sans budget validé, aucun revenu n’est supposé épargné.
- Un mois absent de l’historique et du calendrier salarial ne génère aucun salaire : le dernier solde connu est repris tel quel.

**Prévisions** affiche une projection mensuelle. Un calendrier de salaires au format `marge-income-plan` s’importe depuis cette vue ou les préférences : il ajoute des revenus de référence, sans remplacer les budgets, les soldes ou les mois déjà confirmés. La paie de novembre finance le budget de décembre. Les futurs mois peuvent reprendre une paie ancienne, explicitement marquée comme estimation ; une nouvelle importation actualise les revenus des mois encore prévisionnels.

Les projections démarrent après un point de départ réellement préparé avec un budget valide. Elles supposent que les budgets sont dépensés ; intérêts, opérations exceptionnelles et hausses de salaire ne sont pas inventés. Le fichier de calendrier personnel est indépendant du code et ne doit jamais être ajouté au dépôt.

## Répartition

- Reste hors budget = salaire − budget CA − budget Revolut.
- Un découvert net au départ est couvert avant de répartir le reste.
- Reste finançable inférieur à 500 € : tout vers le Livret A.
- À partir de 500 € : 80 % vers le Livret A, 20 % de surplus.
- Surplus par défaut : 70 % Revolut, 0 % CA, 30 % tampon.
- Autres modes : 60 % R / 20 % CA / 20 % tampon, ou 90 % R / 10 % CA.
- Seuil et pourcentages sont personnalisables ; les parts du surplus doivent totaliser 100 %.
- Un déficit demande un choix explicite d’utilisation du tampon. Le reste non financé doit être corrigé dans le budget.
- Le tampon réel à la clôture est CA + Revolut. Le précédent tampon et les ajouts déjà compris dans les soldes ne sont jamais additionnés une deuxième fois.

Les calculs sont effectués en centimes entiers. L’épargne est arrondie au centime, puis le surplus est réparti par plus grands restes pour affecter chaque centime exactement une fois.

## Sauvegarde

Les données sont enregistrées automatiquement dans le stockage du navigateur. Les modifications du budget sont appliquées avec **Enregistrer**, au mois seul ou à ce mois et aux suivants. Les mois clôturés restent figés.

Utiliser régulièrement **Menu ⋯ → Préférences & sauvegardes → Exporter une sauvegarde**. L’import vérifie le fichier avant de proposer le remplacement des données. Une suppression des données du navigateur supprime aussi la sauvegarde locale. Le comportement du stockage d’un fichier HTML local peut varier selon le navigateur ; l’utilisation d’une adresse hébergée est recommandée sur téléphone.

Cette version ne synchronise pas automatiquement les appareils. Exporter puis importer permet un transfert manuel. Un autre onglet qui modifie la sauvegarde place la page déjà ouverte en lecture seule jusqu’à son rechargement, afin d’éviter d’écraser ses changements.

## Passer de l’ancien hébergement à GitHub Pages

Le stockage du navigateur est lié à l’origine du site. Une nouvelle adresse sur un autre domaine ne récupère pas automatiquement les données de l’ancienne application.

1. Ouvrir l’ancienne application sur l’appareil qui contient les données.
2. Dans les préférences et sauvegardes, **exporter une sauvegarde complète** et garder le fichier JSON.
3. Ouvrir la nouvelle adresse GitHub Pages. Dans les préférences, **importer** ce fichier et confirmer le remplacement après vérification.
4. Vérifier le dernier mois, les budgets, le Livret A, le tampon et les opérations pointées.
5. Conserver l’export ; installer ensuite la nouvelle application. Si l’app installée utilise un stockage distinct du navigateur, importer le même fichier depuis l’app.

Un fichier de calendrier salarial importe seulement les revenus de référence. Pour migrer toute l’application, utiliser la sauvegarde complète. Répéter l’import sur chaque appareil souhaité ; il n’y a pas de synchronisation automatique.

## Installer sur téléphone

L’installation et le fonctionnement hors ligne nécessitent une adresse HTTPS, telle que GitHub Pages. Ouvrir d’abord l’application en ligne pour permettre le chargement de ses fichiers.

**Android / Chrome** : ouvrir l’adresse du site, puis le menu **⋮**. Choisir l’option d’installation de l’application Web et confirmer. Selon la version de Chrome, le libellé peut être **Installer et créer un raccourci**, **Installer l’application** ou **Ajouter à l’écran d’accueil**. L’icône Marge apparaît ensuite parmi les applications ou sur l’écran d’accueil.

**iPhone / iPad** : ouvrir l’adresse dans **Safari**, toucher **Partager**, puis **Sur l’écran d’accueil**. Si l’option est proposée, activer **Ouvrir comme app web**, puis toucher **Ajouter**. Ouvrir ensuite Marge depuis son icône.

Sur ordinateur, Chrome ou Edge peuvent proposer une icône d’installation dans la barre d’adresse. L’application reste utilisable dans un onglet classique.

Le service worker conserve les fichiers de l’application pour les prochaines ouvertures hors ligne. Une première ouverture réussie et un cache conservé par le navigateur restent nécessaires. Les mises à jour sont recherchées à l’ouverture, au retour dans l’application et au retour de la connexion. Leur activation attend que les pages ouvertes de Marge ne soient plus occupées par une saisie ou des modifications à enregistrer ; le rechargement vérifie à nouveau cet état. Une mise à jour du code ne synchronise pas les montants entre appareils.

Le fichier HTML peut toujours s’ouvrir localement, mais le mode `file://` ne permet pas cette installation PWA ni son mécanisme de mise à jour.

## Confidentialité

- Les budgets, soldes, salaires et opérations pointées restent dans le `localStorage` du navigateur. Marge ne les envoie à aucun serveur et n’utilise aucun outil d’analyse d’audience.
- Le cache hors ligne contient les fichiers de l’application, pas les exports personnels ni les bulletins de paie.
- Les données locales et les exports JSON ne sont pas chiffrés par Marge. Protéger l’accès à l’appareil et conserver les sauvegardes dans un emplacement privé.
- Les documents de paie et le calendrier salarial personnel doivent rester hors du dépôt Git. Le dépôt ne contient que le code, les ressources et des données de démonstration ou de test fictives.
- `.gitignore` exclut les répertoires privés, les exports usuels et les documents financiers. Vérifier malgré tout les fichiers sélectionnés avant chaque commit : un fichier déjà suivi par Git n’est pas retiré par une règle d’exclusion.

## Publier sur GitHub Pages

Les sources sont conservées dans `dist/`. La racine contient une copie générée de l’application et de ses ressources PWA, prête pour la publication depuis une branche.

1. Après une modification, exécuter les tests puis `python3 publish.py`.
2. Ajouter et envoyer les sources ainsi que les fichiers générés à la racine sur la branche **main**.
3. Dans le dépôt GitHub, ouvrir **Settings → Pages**.
4. Dans **Build and deployment**, choisir **Deploy from a branch**, puis la branche **main** et le dossier **/(root)**. Enregistrer.
5. Attendre la publication et ouvrir l’adresse indiquée par GitHub, généralement `https://VOTRE_COMPTE.github.io/VOTRE_DEPOT/`.

Le fichier `.nojekyll` permet de servir directement les fichiers statiques. Les chemins du manifeste et du service worker sont relatifs : le site fonctionne aussi dans le sous-dossier d’un dépôt GitHub Pages. Il n’utilise aucun secret ni service applicatif à déployer.

Le workflow `checks.yml` vérifie le code et la synchronisation des fichiers générés. Il ne configure pas GitHub Pages et ne demande aucune permission de déploiement ou d’administration. La publication elle-même repose sur le réglage **main / (root)** effectué dans GitHub.

## Développement

Sources :

- `dist/engine.js` : calculs purs et validation.
- `dist/months.js` : reports chronologiques et projections des revenus.
- `dist/app.js` : interface et sauvegarde.
- `dist/styles.css` : styles, responsive et thème sombre.
- `dist/pwa.js`, `dist/sw.js`, `dist/manifest.webmanifest` et `dist/icons/` : installation, hors ligne et mises à jour.
- `template.html` et `build.py` : assemblage du fichier autonome et version déterministe du cache.
- `publish.py` : reconstruction, puis copie des fichiers publiables à la racine.

Prérequis de développement : Node.js 24 et Python 3.13, comme dans les vérifications GitHub Actions. Aucun paquet npm ou Python supplémentaire n’est nécessaire. Après modification :

```sh
node --test tests/*.test.cjs
python3 publish.py
git diff --exit-code
```

`publish.py` appelle lui-même `build.py`, puis synchronise `index.html`, `manifest.webmanifest`, `sw.js`, `pwa.js` et `icons/` à la racine. Modifier les sources dans `dist/` et `template.html`, puis régénérer ; une modification directe des copies racine sera écrasée. Après une modification volontaire, examiner et committer les différences : `git diff --exit-code` sert à vérifier qu’une nouvelle génération n’ajoute ensuite aucun changement oublié.

Pour un essai local du service worker, lancer `python3 -m http.server 8000` à la racine et ouvrir `http://localhost:8000/`. L’exception de sécurité accordée à `localhost` permet cet essai sur l’ordinateur ; une adresse HTTP du réseau local ouverte depuis le téléphone ne remplace pas une publication HTTPS.

Les tests vérifient les seuils, les déficits, les découverts, les reports, les projections, la validation et la conservation des centimes. Aucun virement bancaire n’est exécuté par l’application.

Documentation des plateformes : [GitHub Pages](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site), [applications Web dans Chrome](https://support.google.com/chrome/answer/9658361?co=GENIE.Platform%3DAndroid&hl=fr), [écran d’accueil dans Safari](https://support.apple.com/fr-fr/guide/iphone/iph42ab2f3a7/ios).
