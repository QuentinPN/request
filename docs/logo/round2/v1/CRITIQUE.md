# Tour 2 · critique v1 (12 pistes autour de la loupe)

Planche : `planche.png` (sombre, clair, 128/64/32/16, mono 32, lockup, tuiles d’icône 96 et 32).
Toutes les pistes partagent la même lentille (centre 108,108 ; anneau 76/46 ; manche 45°, 36 de large) pour comparer les idées, pas le dessin.
11 et 12 sont des **mots-symboles** (retour Ombi) : la loupe devient une lettre de « Request » ; le symbole seul est cette lettre.

Notes sur 5 : idée, distinction, simplicité, pertinence, 16 px / mono → total /25.
Deux axes en plus : **distance Requestrr** (anneau en Q, triangle de lecture dedans, coupe en S, violet) et **distance Ombi** (o-loupe arrondi avec reflet, maillon brisé, orange), notées faible / moyenne / forte ; **idée** : basique (une loupe dessinée) ou à double lecture.

| Piste             | Idée | Dist. | Simpl. | Pert. | 16 px | /25    | Requestrr                                                                                       | Ombi                                                                                                      | Basique / double                           | Verdict                                                               |
| ----------------- | ---- | ----- | ------ | ----- | ----- | ------ | ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------ | --------------------------------------------------------------------- |
| 01 U-loupe        | 4    | 4     | 5      | 4     | 4     | **21** | forte                                                                                           | forte                                                                                                     | double (U + loupe)                         | **gardée**                                                            |
| 02 Reflet lecture | 3    | 1     | 4      | 4     | 3     | 15     | **faible** : loupe + lecture dedans = Requestrr                                                 | moyenne                                                                                                   | basique                                    | écartée                                                               |
| 03 Billet-loupe   | 3    | 3     | 3      | 4     | 2     | 15     | forte                                                                                           | forte                                                                                                     | double, mais deux objets juxtaposés        | écartée : bouillie à 16 px                                            |
| 04 U main-loupe   | 3    | 4     | 3      | 3     | 2     | 15     | forte                                                                                           | forte                                                                                                     | double, mais la loupe est un ajout         | écartée : la loupe disparaît à 32 px                                  |
| 05 Faisceau       | 3    | 3     | 3      | 3     | 3     | 15     | forte                                                                                           | forte                                                                                                     | double                                     | écartée : se lit « cornet de glace » / punaise                        |
| 06 Bobine         | 3    | 3     | 3      | 4     | 2     | 15     | forte                                                                                           | forte                                                                                                     | double                                     | écartée : les trous bouchent à 16 px                                  |
| 07 U négatif      | 5    | 4     | 4      | 5     | 4     | **22** | moyenne (lentille + manche en bas à droite, mais disque plein et U, pas de lecture ni de coupe) | forte                                                                                                     | double (la recherche révèle le U)          | **gardée**                                                            |
| 08 Plus sortant   | 3    | 2     | 3      | 4     | 3     | 15     | forte                                                                                           | forte                                                                                                     | basique : icône « zoom avant » d’interface | écartée                                                               |
| 09 Monoline       | 3    | 3     | 2      | 4     | 2     | 14     | moyenne (lecture dans la lentille)                                                              | forte                                                                                                     | double, mais gribouillé                    | écartée                                                               |
| 10 Badge          | 4    | 3     | 3      | 4     | 3     | 17     | forte                                                                                           | forte                                                                                                     | double                                     | écartée : la tuile fait le travail, sans tuile plus rien              |
| 11 R-loupe (mot)  | 5    | 5     | 4      | 5     | 3     | **22** | forte                                                                                           | moyenne (même principe lettre = loupe, mais R capitale, verre beige plein, jambe = manche, pas de reflet) | double (R + loupe + verre « écran »)       | **gardée**                                                            |
| 12 q-loupe (mot)  | 4    | 4     | 4      | 5     | 3     | **20** | forte                                                                                           | moyenne (lettre = loupe, mais q, pas o)                                                                   | double                                     | **gardée**, à corriger : la descendante est trop courte, on lit « o » |

## Constats (testing-checklist)

- **Échelle** : 01 et 07 tiennent à 16 px ; 11 et 12 perdent le verre beige à 16 px (point de 1 px) → glyphe favicon dérivé obligatoire.
- **Mono** : toutes tiennent sauf 05 (le faisceau disparaît) ; 11/12 en mono : le verre devient un disque plein, qui reste lisible (loupe pleine).
- **Lettre** : 11 se lit R au premier regard ; 12 se lit « o » + trait : descendante à allonger et redresser.
- **Lectures parasites** : 01 peut lire « U + virgule » à 16 px ; 07 « Ü » non ; 05 cornet de glace.
- **Familiarité** : 02 et 08 ressemblent à des icônes d’interface (recherche, zoom) : trop basiques.

## Pour la v2 (4 gardées)

1. 01 : manche plus long et attaché plus bas, anneau 32 pour 16 px, coupe favicon.
2. 07 : U évidé plus grand (fûts 26) pour ouvrir le contre-poinçon à 16 px.
3. 11 : épaisseur de l’anneau compensée (optique), jambe-manche alignée sur la chasse d’origine, verre un peu plus grand.
4. 12 : descendante redressée (75°) et allongée jusqu’à la ligne de jambage ; verre beige conservé.
