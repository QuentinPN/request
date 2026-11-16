# Request — Design

## Identité

Même famille que mes autres projets : **Apple TV cinématique**, fond quasi noir, grands visuels, verre sobre réservé aux éléments flottants, élévation au focus, navigation en pilule, interface en français, raccourcis Windows uniquement.

**Base retenue : les tokens d'Hub** (`D:\Projets\Hub\web\src\lib\styles\tokens.css`), copiés tels quels dans `src/client/styles/tokens.css`. Ils sont complets (thème clair, densité, transparence réduite, mouvement réduit) et viennent d'une appli web hébergée sur le même serveur. Viewer partage l'esprit avec des valeurs différentes (fond `#000`, accent bleu `#8FD3F5`, Segoe UI) : ne pas les mélanger.

Rappel des valeurs clés : fond `#07080A`, surfaces `rgba(255,255,255,.05–.12)`, bordures `rgba(255,255,255,.07/.14)`, texte `#F5F5F7` et `#A1A1A6`, accent `#E8C9A6`, états `#30D158` / `#FFD60A` / `#FF453A` / `#8E8E93`, Inter Variable, rayons 20 / 16 / 14 px et pilules, flou 20–24 px, focus ×1,06 en 220 ms `cubic-bezier(.2,.8,.2,1)`.

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

## Écrans

- **Navigation** : pilule en verre centrée en haut (Découvrir, Films, Séries, Demandes, recherche `Ctrl+K`, compte) ; sur mobile, barre d'onglets flottante en verre en bas. Entrée « Approbations » avec compteur pour les admins.
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
- Vérifier à 1440 px et 390 px. Captures avant/après pour tout changement visuel.
- Pas de dégradés violets génériques, pas d'emoji dans l'interface, pas de faux indicateurs. Auditer chaque écran avec le skill `unslop`.
