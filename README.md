# no-faces

[no-faces.fr](https://no-faces.fr)

Masque les visages des photos (et des vidéos, sur ordinateur) de façon irréversible, **100 % sur l'appareil** (iPhone, Android, PC). C'est une PWA : un site statique qui s'installe sur l'écran d'accueil et fonctionne hors ligne.

Le détail des objectifs, des fonctionnalités et des choix techniques est dans [CAHIER_DES_CHARGES.md](CAHIER_DES_CHARGES.md).

## Développement

`npm run dev` et `npm run build` téléchargent d'abord les deux modèles optionnels (analyse approfondie, texte) depuis Hugging Face s'ils manquent, et vérifient leur empreinte SHA-256 (`scripts/fetch-models.mjs`). Il faut donc un accès Internet au premier build.

```sh
npm install
npm run dev       # http://localhost:5173
npm test          # irréversibilité du masquage (visages et texte), métadonnées (JPEG, PNG, HEIC, MP4), détection de texte, suivi des visages en vidéo
npm run lint
npm run build     # génère dist/ (site statique complet, modèles inclus)
npm run preview   # sert dist/ sur http://localhost:4173, comme en production (service worker compris)
```

### Tester sur téléphone

```sh
npm run phone     # compile puis sert l'app en HTTPS sur le réseau local
```

Sur le téléphone, connecté au même Wi-Fi, ouvrez l'adresse « Network » affichée (`https://192.168.x.x:4173`) et acceptez l'avertissement de certificat :
- iPhone : « Afficher les détails » → « visiter ce site web » ;
- Android : « Paramètres avancés » → « Continuer ».

Le certificat est auto-signé : la détection multi-cœur fonctionne, mais le mode hors ligne et l'installation ne sont pas testables ainsi. Pour ça, il faut déployer (voir ci-dessous).

Pourquoi le HTTPS : les navigateurs réservent aux pages sécurisées (HTTPS ou `localhost`) le multi-cœur (`SharedArrayBuffer`), le mode hors ligne (service worker) et le partage de fichiers.

## Déploiement

Le site est publié sur **no-faces.fr**. N'importe quel hébergeur de fichiers statiques fait l'affaire : il ne fait que livrer l'app, aucune photo n'y transite.

- **Cloudflare Pages** ou **Netlify** (recommandé) : commande de build `npm run build`, dossier `dist`. Le fichier `public/_headers` ajoute les en-têtes de sécurité (CSP, etc.) et les en-têtes COOP/COEP qui activent la **détection multi-cœur, environ 3 fois plus rapide**.
- **OVH (hébergement web, Apache)** : `npm run build`, puis envoyer le **contenu** de `dist/` (fichier caché `.htaccess` compris) dans le dossier `www/` par FTP. Le fichier `public/.htaccess` joue le rôle de `_headers` : HTTPS forcé, mêmes en-têtes de sécurité, types MIME du moteur (`.wasm`, `.mjs`) et compression. Le site pèse environ 55 Mo : il tient dans l'hébergement gratuit de 100 Mo offert avec un domaine.
- **GitHub Pages** : publier le contenu de `dist/`. Ça fonctionne, mais GitHub Pages ne permet pas d'ajouter ces en-têtes : la détection y tourne sur un seul cœur, donc plus lentement.

Même chose pour un test sur téléphone via le serveur de dev en `http://` sur le réseau local : sans HTTPS, ni le multi-cœur ni le mode hors ligne ne sont disponibles.

Puis sur iPhone : Safari → Partager → « Sur l'écran d'accueil ». Sur Android : Chrome → « Installer l'application ».

## Structure

```
src/lib/scrfd.ts             pré/post-traitement du détecteur de visages (tuiles, décodage, NMS)
src/lib/text.ts              pré/post-traitement du détecteur de texte (plaques, panneaux…)
src/lib/detector.worker.ts   inférence ONNX dans un Web Worker (visages 2.5G / 10G, texte)
src/lib/heic.ts              lecture des HEIC hors Safari (libheif en WebAssembly, heic.worker.ts)
src/lib/anonymize.ts         masquage irréversible (flou, aplat)
src/lib/metadata.ts          liste et suppression des métadonnées (JPEG, PNG ; liste seule pour HEIC)
src/lib/photo.ts             décodage, aperçu, export
src/lib/video.ts             vidéo (ordinateur uniquement) : ouverture, analyse, aperçu, export MP4
src/lib/tracks.ts            suivi des visages d'une image analysée à l'autre
src/lib/mp4.ts               liste et neutralisation des métadonnées MP4 / MOV
src/components/              interface (zone d'édition et zoom, réglages, caméra, export)
tests/anonymize.test.ts      preuve que la sortie ne dépend pas des pixels des visages
tests/metadata.test.ts       suppression des métadonnées
tests/mp4.test.ts            métadonnées des vidéos
tests/tracks.test.ts         un visage qui bouge reste couvert entre deux analyses
tests/text.test.ts           détection de texte : boîtes, fusion, couverture de l'image
tests/heic.test.ts           reconnaissance et métadonnées des HEIC
public/models/               SCRFD 2.5G (dans le dépôt) ; SCRFD 10G et PP-OCRv4 (téléchargés au build)
```

## Licence

Copyright (C) 2026 Les contributeurs de no-faces.

Le code de no-faces est un logiciel libre : vous pouvez le redistribuer et le modifier selon les termes de la [GNU Affero General Public License](LICENSE) publiée par la Free Software Foundation, version 3 ou (à votre choix) toute version ultérieure (`AGPL-3.0-or-later`). Il est distribué sans aucune garantie.

L'AGPL s'applique aussi à l'usage en ligne : si vous mettez en ligne une version modifiée, vous devez proposer son code source à ses utilisateurs. L'app renvoie vers le dépôt depuis l'écran d'accueil (`SOURCE_URL` dans `src/components/Welcome.tsx`).

Les modèles d'IA, les polices et les bibliothèques ci-dessous ne sont pas couverts par l'AGPL : chacun garde sa propre licence.

## Modèles et bibliothèques tiers

`public/models/scrfd_2.5g_bnkps.onnx` et `scrfd_10g_bnkps.onnx` viennent de [InsightFace SCRFD](https://github.com/deepinsight/insightface/tree/master/detection/scrfd), converti en ONNX par [RuteNL/SCRFD-face-detection-ONNX](https://huggingface.co/RuteNL/SCRFD-face-detection-ONNX) (SHA-256 `3f1ac54e…0219e` et `5838f7fe…5b91`).

`public/models/ppocrv4_det.onnx` est le détecteur de texte PP-OCRv4 de [PaddleOCR](https://github.com/PaddlePaddle/PaddleOCR) (Apache 2.0), converti en ONNX par [RapidOCR](https://huggingface.co/SWHL/RapidOCR) (SHA-256 `d2a7720d…9da9`).

Le décodeur HEIC est [libheif-js](https://github.com/catdad-experiments/libheif-js) (LGPL-3.0) : il reste un fichier séparé (`heic.worker-*.js`), chargé à la demande et remplaçable, comme le demande la LGPL.

Les polices VT323 (titres), Press Start 2P (sous-titres) et JetBrains Mono (texte et libellés) sont sous licence SIL Open Font License. Elles viennent des paquets [Fontsource](https://fontsource.org) et sont servies par le site lui-même, sans requête vers un autre site.

Le moteur d'inférence [ONNX Runtime Web](https://github.com/microsoft/onnxruntime) et [React](https://react.dev) sont sous licence MIT ; [Mediabunny](https://github.com/Vanilagy/mediabunny) (vidéo) est sous licence MPL-2.0.

⚠️ InsightFace indique que ses modèles pré-entraînés sont destinés à un usage de recherche non commercial. Cette restriction ne vient pas de l'AGPL et ne disparaît pas avec elle : avant toute exploitation commerciale, il faut vérifier la licence, ou passer à un modèle sous licence libre, par exemple YuNet d'OpenCV.
