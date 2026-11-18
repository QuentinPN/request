# Request — Design

## Identité

Même famille que mes autres projets : **Apple TV cinématique**, fond quasi noir, grands visuels, verre sobre réservé aux éléments flottants, élévation au focus, navigation en pilule, interface en français, raccourcis Windows uniquement.

**Base retenue : les tokens d'Hub** (`D:\Projets\Hub\web\src\lib\styles\tokens.css`), copiés tels quels dans `src/client/styles/tokens.css`. Ils sont complets (thème clair, densité, transparence réduite, mouvement réduit) et viennent d'une appli web hébergée sur le même serveur. Viewer partage l'esprit avec des valeurs différentes (fond `#000`, accent bleu `#8FD3F5`, Segoe UI) : ne pas les mélanger.

Rappel des valeurs clés : fond `#07080A`, surfaces `rgba(255,255,255,.05–.12)`, bordures `rgba(255,255,255,.07/.14)`, texte `#F5F5F7` et `#A1A1A6`, accent `#E8C9A6`, états `#30D158` / `#FFD60A` / `#FF453A` / `#8E8E93`, Inter Variable, rayons 20 / 16 / 14 px et pilules, flou 20–24 px, focus ×1,06 en 220 ms `cubic-bezier(.2,.8,.2,1)`.

## Direction validée

Maquettes : [canevas « Request — directions de design »](https://claude.ai/artifact/UVig26hmQYFHEsaaqDoL3H), page **Recommandation** (validée par le propriétaire le 2026-11-17). Copie versionnée (référence, hors lint) : `docs/maquettes/project/` (`R-*.dc.html`, `request.css`).

| Élément                                 | Direction                                                                                            |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Navigation, Découvrir, fiche titre      | A « Salle obscure » (hero plein cadre, rangées d'affiches, fiche plein fond)                         |
| Suivi des demandes                      | C : bande « Vos demandes en cours » sur l'accueil (si demande en cours), frise de suivi sur la fiche |
| Approbations                            | ordinateur : tableau C + panneau de détail ; mobile : carte par carte (B)                            |
| Assistant                               | C : une seule page, sections en accordéon, chacune testée en direct                                  |
| Feuille de demande, Mes demandes, états | A                                                                                                    |

Navigation ordinateur : nom de l'appli à gauche, pilule en verre centrée (Découvrir, Films, Séries, Demandes, Approbations avec compteur pour les admins, menu « Plus » avec Ma liste, Signalements et Statistiques, Rechercher `Ctrl K`), cloche et avatar à droite ; de 1024 à 1280 px la pilule se resserre (recherche réduite à l'icône). Mobile : barre d'onglets flottante en verre, cinq onglets au plus (Découvrir, Rechercher, Demandes, Approuver avec compteur pour les admins, Compte) ; la cloche est dans l'en-tête, Ma liste, Signalements et Statistiques s'ouvrent depuis Compte.

## Correspondance avec shadcn

shadcn lit ses propres variables. On les dérive des tokens, sans dupliquer de valeur :

```css
:root {
  --background: var(--bg);
  --foreground: var(--text);
  --card: var(--surface-1);
  --card-foreground: var(--text);
  --popover: var(--glass-dialog);
  --popover-foreground: var(--text);
  --primary: var(--fill-selected);
  --primary-foreground: var(--text-inverse); /* bouton principal blanc, texte noir */
  --secondary: var(--glass-pill);
  --secondary-foreground: var(--text); /* bouton secondaire en verre */
  --muted: var(--surface-2);
  --muted-foreground: var(--text-2);
  --accent: var(--surface-3);
  --accent-foreground: var(--text); /* survol des menus : PAS la couleur de marque */
  --destructive: var(--danger-fill);
  --border: var(--border-1);
  --input: var(--border-2);
  --ring: var(--border-focus);
  --radius: var(--r-button);
  --brand: var(--accent-play); /* accent beige : barres de progression, liens, petits marqueurs */
}
```

Piège : chez shadcn, `--accent` est le fond de survol. L'accent de marque `#E8C9A6` va dans `--brand`, sinon chaque menu se teinte en beige.

## Logo

**R-loupe** (choix du propriétaire, 3.4) : dans « Request », le « R » est une loupe, sa panse est le verre (accent de marque) et sa jambe le manche. Sources : `docs/logo/round2/final/r-loupe/`, planche de contrôle `docs/logo/round2/final/planche-v2.png`.

| Fichier                                                                                    | Usage                                                                                                                                  |
| ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| `src/client/components/logo.tsx` (`<Logo />`)                                              | mot-symbole de l'appli (en-tête, connexion, assistant) : lettres en `currentColor`, verre en `--brand`, nom accessible « Request » |
| `lockup-dark.svg`, `lockup-light.svg`                                                      | mot-symbole hors appli, sur fond sombre ou clair                                                                                       |
| `icon.svg`, `icon-light.svg`                                                               | icône (R complet : fût, verre, manche) sur tuile sombre ou claire, dès 48 px                                                           |
| `favicon.svg`                                                                              | petit format (16 et 32 px) : traits épaissis, verre plein sans liseré, tuile selon `prefers-color-scheme`                              |
| `mark.svg`, `mark-light.svg`, `mark-mono.svg`                                              | R seul sans tuile ; `mark-mono` en une couleur (`currentColor`), verre vide                                                            |
| `public/` : `favicon*.png`, `apple-touch-icon.png`, `icon-*.png` et `manifest.webmanifest` | exports servis par l'appli ; l'icône Apple est carrée et opaque (iOS arrondit lui-même)                                                |

Icône « maskable » (Android, `icon-maskable-512.png`) : `mark.svg` à 90 % sur fond plein `#07080A`, dans la zone sûre.

Tailles minimales : mot-symbole 16 px de haut (`h-[1.3em]` sur un texte de 13 px au moins) ; icône grand format 48 px, en dessous le petit format `favicon.svg`. Zone de protection : la largeur du fût du R tout autour. Ne pas recolorer le verre hors `--brand`, ne pas déformer, ne pas remettre la loupe seule sans le fût.

## Écrans

- **Navigation** : pilule en verre centrée en haut (Découvrir, Films, Séries, Demandes, Approbations avec compteur pour les admins, menu « Plus », recherche `Ctrl+K`, compte) ; sur mobile, barre d'onglets flottante en verre en bas. Le compteur des signalements ouverts (gestionnaires) est sur « Plus » et sur l'onglet Compte.
- **Découvrir** : hero d'un titre tendance (fond, logo ou titre, synopsis, « Demander » blanc, « Plus d'infos » en verre), puis rangées horizontales d'affiches 2:3.
- **Affiche** : pastille de statut en haut à droite (couleurs d'état, « Demandé » en accent), bouton « Demander » au survol et au focus, toujours visible au toucher.
- **Fiche titre** : gabarit de la fiche film d'Viewer (fond sur 70 % de la hauteur, voile noir à gauche et en bas, métadonnées, genres en pilules de verre), bloc « Demande » clair (statut, demandeur, date, progression du téléchargement), puis saisons, distribution, recommandations.
- **Feuille de demande** : dialogue en verre, choix des saisons (cases avec leur statut, celles déjà présentes grisées), quota restant affiché, « Demander » ; options avancées (profil, dossier) repliées et visibles seulement pour qui en a le droit.
- **Demandes** : liste dense avec affiche, statut, progression ; filtres en pilules ; actions groupées pour l'admin (approuver, refuser avec motif).
- **Assistant de configuration** : une étape par écran, carte en verre centrée, test de connexion en direct avec état clair, bouton « Passer » pour les étapes facultatives.

## Règles

- Contraste WCAG AA, focus visible, navigation au clavier complète, libellés pour lecteurs d'écran.
- États de chargement (squelettes de même taille), vide et erreur (« Réessayer ») sur chaque liste.
- `prefers-reduced-motion` et `prefers-reduced-transparency` respectés (déjà dans les tokens).
- Vérifier visuellement à 1440 px et 390 px tout changement d'interface. Captures enregistrées dans `docs/captures/` seulement pour une nouvelle page, une refonte ou sur demande.
- Pas de dégradés violets génériques, pas d'emoji dans l'interface, pas de faux indicateurs. Auditer chaque écran avec le skill `unslop`.
