# no-faces — cahier des charges

*Site : [no-faces.fr](https://no-faces.fr). Périmètre actuel : **photos**, et **vidéos sur ordinateur uniquement**.*

## Objectif

Masquer les visages sur des photos et des vidéos de façon **irréversible**, c'est-à-dire impossible à reconstituer, même avec une IA. Tout se fait **sur l'appareil**, sans serveur de traitement, sur iPhone, Android et PC.

## Principes non négociables

1. **Aucune photo ne quitte l'appareil.**
   - Une Content-Security-Policy (`connect-src 'self'`) interdit techniquement tout envoi vers un autre site.
   - Pas d'analytics, pas de CDN : le modèle d'IA et le moteur WebAssembly sont servis par l'app elle-même.
   - L'app fonctionne en mode avion une fois chargée (PWA hors ligne).
2. **Masquage irréversible.** Les pixels de sortie ne contiennent **aucune information** issue des visages :
   - **Flou** (« faux flou ») : la zone est remplie par interpolation des pixels *autour* des visages. On n'utilise jamais les pixels du visage, ni ceux **d'aucun autre visage** proche. 100 % des pixels du visage sont écrasés.
   - **Aplat** : une couleur unie.
   - La zone couvre la boîte du visage détecté, plus le front, plus une marge réglable (10 % par défaut).
   - Un flou ou une pixellisation classiques sont **exclus** : ils gardent une version dégradée du visage, exploitable par des modèles de dé-floutage ou de reconnaissance.
   - Vérifié par un test automatique (`npm test`) : on change complètement les pixels des visages, et la sortie doit rester identique à l'octet près.
3. **Aucune métadonnée dans le fichier exporté.**
   - L'image est ré-encodée depuis les pixels, ce qui laisse derrière EXIF (GPS, appareil, date), XMP, IPTC et la **miniature EXIF intégrée** (qui contient souvent la photo d'origine non masquée).
   - Ce que le navigateur ajoute lui-même (profil couleur, blocs PNG) est ensuite supprimé octet par octet. Le fichier final ne contient que l'image.
   - Le fichier est **revérifié** avant d'être proposé : s'il restait une métadonnée, l'export serait refusé.
   - Avant l'export, l'app montre ce qu'elle a trouvé dans l'original : position GPS, appareil, date, miniature, images secondaires des iPhone, vidéo « Motion Photo » collée en fin de fichier…
   - Le fichier exporté porte un nom générique, car le nom d'origine peut identifier quelqu'un.
4. **Relecture humaine obligatoire.** Aucun détecteur n'est parfait. L'export exige de cocher « J'ai vérifié que tous les visages sont masqués ».

## Fonctionnalités

### MVP (fait)

- [x] PWA installable (écran d'accueil iPhone et Android, installation sur PC) et fonctionnement hors ligne
- [x] Import d'une ou plusieurs photos (bouton, ou glisser-déposer sur PC). HEIC lu sous Safari.
- [x] Détection automatique des visages : modèle SCRFD, analysé en tuiles à plusieurs échelles pour trouver les petits visages
- [x] Curseur de **sensibilité**, qui ajuste le seuil sans relancer l'analyse
- [x] Édition manuelle : ajouter une zone, la déplacer, la redimensionner, la supprimer, réinitialiser
- [x] Méthodes Flou et Aplat (5 couleurs) ; formes ovale ou rectangle ; marge réglable
- [x] Zoom (jusqu'à 6×) et bouton « maintenir pour voir l'original »
- [x] Export JPEG (ou PNG si la source est en PNG) sans aucune métadonnée, vérifié, via la feuille de partage sur mobile (enregistrement dans Photos) ou par téléchargement
- [x] Liste des métadonnées trouvées dans l'original, affichée avant l'export
- [x] Traitement par lot : bandeau de miniatures, export de toutes les photos

### Étape 2 (fait)

- [x] **HEIC hors Safari** : si le navigateur ne sait pas lire la photo (Chrome, Firefox, Android), elle est décodée par libheif compilé en WebAssembly, dans un worker chargé seulement à ce moment-là (2 Mo, servi par l'app, disponible hors ligne). Les métadonnées des HEIC (EXIF avec GPS, appareil et date, XMP, miniature, images auxiliaires comme la carte de profondeur, vidéo « Live ») sont aussi listées avant l'export.
- [x] **Zoom par pincement à deux doigts**, ancré sous les doigts, de 1× à 6×. On se déplace dans la photo agrandie en la faisant glisser (doigt ou souris) ; les boutons − et + passent au palier suivant. Sur ordinateur, Ctrl + molette (ou pincement du pavé tactile) zoome sous le pointeur.
- [x] **Mode « Tout masquer sauf… »** : toucher une zone la laisse visible (contour pointillé gris, mention « visible ») ; la toucher à nouveau la masque. Le nombre de zones laissées visibles est rappelé avant l'export. Le choix survit à un changement d'analyse.
- [x] **Analyse approfondie** (photos) : modèle SCRFD 10G, plus précis sur les visages petits, flous ou de profil, 2 à 3 fois plus lent. Le modèle (17 Mo) n'est téléchargé qu'au premier usage, puis il est disponible hors ligne. Changer d'analyse relance la détection photo par photo, sans perdre les zones tracées à la main. *L'accélération WebGPU était déjà en place (voir plus bas) et s'applique aux trois modèles.*
- [x] **Masquer aussi le texte** (option, photos) : plaques d'immatriculation, noms de rue, badges, écrans… Le détecteur de texte PP-OCRv4 (PaddleOCR, 5 Mo, téléchargé au premier usage) repère où se trouve du texte sans le lire. Chaque texte est masqué par un rectangle, avec le même faux flou que les visages.
- [x] **Zone libre** : rectangle tracé à la main et masqué tel quel, pour un **tatouage**, un logo, un texte manqué… Aucun modèle libre et fiable ne détecte les tatouages : c'est à l'utilisateur de les repérer.
- [x] **Capture caméra directe** (photo uniquement, sans micro) : la photo est prise dans l'app et n'existe qu'en mémoire ; l'original n'est jamais enregistré dans la pellicule. Pleine résolution du capteur quand le navigateur le permet (Chrome sur Android), sinon l'image du flux vidéo.

Limites de l'étape 2 : le texte très stylisé (lettrage décoratif) ou très dégradé peut n'être couvert qu'en partie ; le texte et l'analyse approfondie ne s'appliquent pas à la vidéo. Hors ligne, si le modèle approfondi ou celui du texte n'a jamais été utilisé, l'option se désactive avec un message et les résultats précédents restent.

## Vidéo (ordinateur uniquement)

Analyser et réencoder chaque image d'une vidéo occupe le processeur et la carte graphique pendant des minutes et demande beaucoup de mémoire. La vidéo est donc **refusée sur téléphone et tablette** (iPadOS et Android en mode « site pour ordinateur » compris). L'accueil l'indique, et le code vidéo n'y est jamais exécuté. Sur ordinateur, il faut un navigateur avec WebCodecs (Chrome, Edge, Firefox, Safari récents).

- [x] Import d'une vidéo (MP4, MOV, WebM, MKV ; 10 minutes au plus, car l'export est construit en mémoire)
- [x] Analyse de **10 images par seconde** (Standard, jusqu'à 1280 px) ou **15 images par seconde à pleine résolution** (Approfondie, petits visages, plusieurs fois plus lente). Les visages s'affichent au fil de l'analyse.
- [x] **Suivi des visages** d'une image analysée à l'autre (`src/lib/tracks.ts`). Une image située entre deux analyses est masquée là où le visage se trouve sur l'une **et** sur l'autre (union des deux zones) : un visage qui bouge reste couvert. Un visage manqué sur 3 analyses de suite au plus est interpolé, et chaque visage est prolongé d'une analyse avant et après. La sensibilité s'applique au meilleur score du visage sur toute la vidéo.
- [x] Lecture de l'aperçu masqué, en continu à vitesse normale ou ralentie (½×, ¼×, 1/10×), ou image par image (‹ › ou flèches du clavier, espace pour lecture/pause), avec curseur de temps et numéro d'image
- [x] Zones ajoutées à la main, avec une image de début et de fin (« Commencer ici », « Finir ici »), pour suivre ce que la détection ne trouve pas. Déplacée sur une autre image, la zone y prend une **position clé** ; entre deux positions clés, elle glisse d'elle-même (interpolation). En lecture ralentie, on peut aussi la tenir et la déplacer en continu (une position clé par image). Les positions clés sont marquées sous la barre de temps, avec des boutons pour passer de l'une à l'autre.
- [x] Retirer un visage détecté sur toute la vidéo (faux positif)
- [x] Export MP4 (H.264 si le navigateur sait l'encoder) : nouveau fichier encodé depuis les images masquées. Les métadonnées de l'original (GPS, appareil, date, titre) et ses pistes de capteurs ne sont pas copiées. Les dates et noms de piste écrits par l'encodeur sont neutralisés, puis le fichier est revérifié.
- [x] **Son : choix explicite** avant l'export, « Supprimer le son » ou « Garder le son » (une voix peut identifier quelqu'un). Rien n'est présélectionné : l'export attend ce choix. Le son gardé est copié tel quel s'il est compatible MP4 (AAC, Opus, MP3…) ; sinon la vidéo exportée est muette.

Testé de bout en bout dans Chromium sans carte graphique : sur une vidéo 720p de 4 s (paysage, et portrait avec rotation), l'analyse Standard prend 16 s, l'export 5 s. Réanalysée, la vidéo exportée ne contient plus de visage (seuls quelques faux positifs sur les zones floutées). **Vitesse à mesurer sur de vrais PC avec WebGPU.**

Limites propres à la vidéo : un visage visible moins d'un dixième de seconde entre deux analyses peut passer ; le flou de mouvement gêne la détection. Il faut regarder la vidéo en entier avant l'export.

## Calcul sur le GPU (WebGPU)

Au démarrage, le moteur essaie la puce graphique (pour chacun des trois modèles : visages, visages approfondi, texte) (WebGPU : Chrome Android récent, Chrome/Edge sur PC). Il ne l'adopte que si elle donne les mêmes scores que le CPU sur une image test, à 0,02 près ; un pilote défaillant ne peut donc pas faire rater des visages. Sinon, il passe sur le CPU multi-cœur. Sur Mac (Apple M), le GPU est environ 2 fois plus rapide que le CPU 4 threads, avec des visages identiques au pixel près. Sur téléphone, l'écart attendu est plus grand.

**Pas de GPU sur iPhone et iPad** : dans Safari, une session WebGPU occupe environ 1,3 Go (contre 350 Mo environ pour le CPU WebAssembly), et iOS ferme alors l'onglet, ce qui fait perdre les photos. Le CPU multi-cœur y est toujours utilisé.

## Limites à garder en tête

- La détection peut rater des visages très petits, de profil, masqués, dans un reflet, sur une affiche ou sur un écran.
- Masquer le visage ne rend pas anonyme : vêtements, silhouette, lieu ou tatouages peuvent suffire à identifier quelqu'un. L'option texte et la zone libre aident, sans rien garantir.
- Les photos de plus de 16 mégapixels sont réduites à 16 Mpx, limite des canvas de Safari sur iOS.
- Sur iPhone, une PWA a moins de mémoire qu'une app native : éviter d'importer des dizaines de photos d'un coup.
- Sur téléphone et tablette, seule la méthode de masquage (flou ou aplat) se règle. La forme, la marge, la sensibilité, l'analyse approfondie et le masquage du texte sont réservés à l'ordinateur : le grand modèle et le détecteur de texte font dépasser 1,3 Go à Safari, et iOS ferme l'onglet.
- Rien n'est enregistré : recharger ou fermer la page fait perdre le travail en cours. L'app demande confirmation avant de quitter (sauf Safari sur iOS, qui ignore cette demande).
- Performances mesurées sur PC, avec Chromium et WebKit (le moteur de Safari) : premiers visages affichés en 0,3 à 1,1 s, analyse complète en environ 2 s (multi-cœur). Déplacer une zone, avec un processeur ralenti 4× pour simuler un téléphone : environ 25 ms par image. **Reste à confirmer sur de vrais iPhone et Android.**
- La détection multi-cœur exige les en-têtes COOP/COEP et le HTTPS (voir `public/_headers`). Sans eux, par exemple sur GitHub Pages, elle tourne sur un seul cœur, environ 3 fois plus lentement.

## Choix techniques

| Sujet | Choix | Pourquoi |
|---|---|---|
| App | Vite + React + TypeScript, `vite-plugin-pwa` | Site statique, installable, hors ligne |
| Détection | SCRFD 2.5G, ou 10G en analyse approfondie (InsightFace), ONNX Runtime Web dans un Web Worker : **GPU (WebGPU)** si disponible et validé, sinon CPU (WASM SIMD, 4 threads). Préchargé à l'ouverture, résultats affichés au fil de l'analyse | Bon sur les petits visages, 3 Mo, l'interface ne gèle pas |
| Petits visages | Passages à 640 / 1280 / 2560 px de côté, découpés en tuiles 640×640 qui se chevauchent, puis fusion (NMS) | L'entrée du modèle est fixe en 640×640 |
| Texte | PP-OCRv4 det (PaddleOCR, Apache 2.0), entrée fixe 960×960 : image entière puis tuiles jusqu'à 1920 px ; régions connexes de la carte de probabilité, agrandies comme dans PaddleOCR (`src/lib/text.ts`) | Repère plaques et panneaux sans lire le texte, 5 Mo |
| HEIC | libheif-js (LGPL-3.0) dans un worker jetable, chargé à la demande | Seul Safari décode le HEIC ; la mémoire WebAssembly est rendue après chaque photo |
| Vidéo | Mediabunny (lecture et écriture MP4/MOV/WebM) + WebCodecs, chargés seulement à l'ouverture d'une vidéo | Décodage et encodage matériels, aucune dépendance, horodatages maîtrisés image par image |
| Masquage | Canvas 2D, interpolation harmonique depuis l'entourage | Rendu « flou » sans aucune donnée du visage |
| Métadonnées | Analyse et nettoyage JPEG/PNG, analyse HEIF (`src/lib/metadata.ts`) et MP4/MOV (`src/lib/mp4.ts`) maison | Aucune dépendance, contrôle du résultat |
| Modèles optionnels | Téléchargés au build par `scripts/fetch-models.mjs` (empreinte SHA-256 vérifiée), hors du dépôt ; mis en cache par le service worker au premier usage | Pas 22 Mo imposés à chaque installation |
| Hébergement | Cloudflare Pages, Netlify, OVH (Apache) ou GitHub Pages (fichiers statiques) | `public/_headers` (Cloudflare, Netlify) ou `public/.htaccess` (Apache) ajoute CSP et en-têtes de sécurité (caméra autorisée pour l'app elle-même, micro interdit) |
| Licence | AGPL-3.0-or-later pour le code ; modèles, polices et bibliothèques sous leur propre licence | Le code reste libre, y compris quand il est mis en ligne par d'autres |
