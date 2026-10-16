# no-faces

Masque les visages sur vos photos et vos vidéos, de façon irréversible, sans rien envoyer sur internet. Tout se passe sur votre téléphone ou votre ordinateur.

Site : [no-faces.fr](https://no-faces.fr)

## Pourquoi

Publier une photo de groupe ou de rue, c'est souvent exposer des personnes qui n'ont rien demandé. no-faces masque ces visages avant que vous partagiez la photo.

- **Rien ne quitte votre appareil.** Vos photos ne sont envoyées à aucun serveur.
- **Irréversible.** Les pixels du visage ne sont pas gardés en version floue : ils sont remplacés par des pixels pris autour. Il n'y a donc rien à reconstituer, même avec une IA.
- **Sans métadonnées.** La position GPS, le modèle de l'appareil et la date sont retirés du fichier exporté.

## Fonctionnalités

- **Photos** (iPhone, Android, ordinateur) : détection automatique des visages, masquage au flou ou en aplat, ajout ou retrait de zones à la main, masquage du texte (plaques, panneaux, écrans), traitement de plusieurs photos d'un coup.
- **Vidéos** (ordinateur uniquement) : masquage image par image. Un visage qui bouge reste couvert.
- **Application installable** : elle s'ajoute à l'écran d'accueil et fonctionne hors ligne une fois chargée.

## Limites

Relisez toujours le résultat avant de partager : aucun détecteur n'est parfait.

- Un visage très petit, de profil, masqué ou visible dans un reflet peut être manqué.
- Masquer le visage ne rend pas anonyme. Les vêtements, la silhouette, le lieu ou un tatouage peuvent suffire à identifier quelqu'un.
- Sur téléphone, certains réglages avancés ne sont disponibles que sur ordinateur, et les vidéos ne sont pas acceptées.

Le détail des objectifs, des garanties et des choix techniques est dans le [cahier des charges](CAHIER_DES_CHARGES.md).

## Essayer en local

Il faut Node.js (version LTS récente).

```sh
npm install
npm run dev       # http://localhost:5173
npm test
npm run build     # génère dist/
```

Au premier `npm run dev` ou `npm run build`, deux modèles d'IA optionnels sont téléchargés depuis Hugging Face. Il faut donc une connexion internet une fois ; leur empreinte est vérifiée.

Pour tester sur téléphone : `npm run phone`, puis suivre l'adresse affichée dans le terminal. Le certificat est auto-signé, donc le navigateur affichera un avertissement à accepter.

## Publier votre propre version

L'app est un site statique : `npm run build`, puis le dossier `dist/` peut être servi par n'importe quel hébergeur de fichiers. Cloudflare Pages et Netlify sont recommandés : le fichier `public/_headers` y active la détection multi-cœur, environ 3 fois plus rapide. Les détails sont dans le cahier des charges.

## Contribuer

Les idées, bugs et propositions sont bienvenus dans les [issues](issues). Pour le code, lancez `npm test` et `npm run lint` avant d'ouvrir une pull request.

Pour une faille de sécurité ou de confidentialité, n'ouvrez pas d'issue publique : utilisez le signalement privé de GitHub (onglet **Security**).

En contribuant, vous acceptez que votre code soit publié sous AGPL-3.0-or-later.

## Licence

no-faces est un logiciel libre, distribué sous [AGPL-3.0-or-later](LICENSE). Vous pouvez l'utiliser, le modifier et le redistribuer. Si vous le mettez en ligne après l'avoir modifié, vous devez proposer son code source à ses utilisateurs. Il est fourni sans aucune garantie.

⚠️ Les modèles de détection des visages viennent d'InsightFace (SCRFD), dont la licence n'autorise qu'un usage de recherche non commercial. Cette restriction ne vient pas de l'AGPL et ne disparaît pas avec elle : avant toute utilisation commerciale, il faut vérifier la licence ou remplacer le modèle, par exemple par YuNet d'OpenCV.

## Crédits

- Détection des visages : [InsightFace SCRFD](https://github.com/deepinsight/insightface/tree/master/detection/scrfd)
- Détection du texte : [PaddleOCR PP-OCRv4](https://github.com/PaddlePaddle/PaddleOCR) (Apache 2.0)
- Moteur d'inférence : [ONNX Runtime Web](https://github.com/microsoft/onnxruntime) (MIT), [React](https://react.dev) (MIT)
- Vidéo : [Mediabunny](https://github.com/Vanilagy/mediabunny) (MPL-2.0)
- HEIC : [libheif-js](https://github.com/catdad-experiments/libheif-js) (LGPL-3.0)
- Polices : VT323, Press Start 2P et JetBrains Mono (SIL Open Font License), via [Fontsource](https://fontsource.org)
