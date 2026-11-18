import type { QueryClient } from '@tanstack/react-query';
import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  type ErrorComponentProps,
  lazyRouteComponent,
  Outlet,
  type RouteComponent,
  redirect,
  useRouter,
} from '@tanstack/react-router';
import { AppShell } from '@/components/shell/app-shell';
import { ErrorState, LoadingState } from '@/components/states';
import { genreSearchSchema } from '@/lib/catalogue';
import { issueSearchSchema } from '@/lib/issues';
import { requestsSearchSchema } from '@/lib/requests';
import { guardRedirect, safeReturnPath, setupStateQuery, viewerQuery } from '@/lib/session';
import { IntrouvablePage } from '@/pages/introuvable';

// Un chunk qui a échoué reste en cache côté navigateur : seul un rechargement complet le redemande.
const chunkLoadError =
  /dynamically imported module|Importing a module script failed|error loading dynamically imported module/i;

function RouteError({ error, reset }: ErrorComponentProps) {
  const router = useRouter();
  return (
    <ErrorState
      message="Cette page n’a pas pu se charger."
      onRetry={() => {
        if (chunkLoadError.test(error instanceof Error ? error.message : String(error))) {
          window.location.reload();
          return;
        }
        reset();
        void router.invalidate();
      }}
    />
  );
}

export type RouterContext = { queryClient: QueryClient };

// Garde global : état de l'installation et session lus avant d'afficher quoi que ce soit (aucune page protégée ne clignote).
const rootRoute = createRootRouteWithContext<RouterContext>()({
  component: Outlet,
  beforeLoad: async ({ context: { queryClient }, location }) => {
    const [setup, viewer] = await Promise.all([
      queryClient.fetchQuery(setupStateQuery),
      queryClient.fetchQuery(viewerQuery),
    ]);
    const target = guardRedirect(location.pathname, location.href, setup, viewer);
    if (target?.to === '/connexion') throw redirect({ to: '/connexion', search: { retour: target.retour } });
    if (target) throw redirect({ to: target.to });
    return { viewer };
  },
});

// Chaque page est chargée à la demande, dans son propre fichier.
const lazy = <TModule extends Record<string, RouteComponent>>(
  load: () => Promise<TModule>,
  name: keyof TModule & string,
) => lazyRouteComponent(load, name);

const connexionRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/connexion',
  validateSearch: (search: Record<string, unknown>): { retour?: string } => ({ retour: safeReturnPath(search.retour) }),
  beforeLoad: ({ context: { viewer }, search }) => {
    if (viewer) throw redirect({ href: search.retour ?? '/' });
  },
  component: lazy(() => import('@/pages/connexion'), 'ConnexionPage'),
});

const assistantRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/assistant',
  component: lazy(() => import('@/pages/assistant'), 'AssistantPage'),
});

// Pages de l'appli, dans la navigation (la connexion et l'assistant s'affichent seuls).
const appRoute = createRoute({ getParentRoute: () => rootRoute, id: 'app', component: AppShell });

// Options d'une page de l'appli ; les paramètres de chemin (`$type`, `$id`) sont validés par la page.
const page = <TPath extends string, TModule extends Record<string, RouteComponent>>(
  path: TPath,
  load: () => Promise<TModule>,
  name: keyof TModule & string,
) => ({ getParentRoute: () => appRoute, path, component: lazy(load, name) });

const routeTree = rootRoute.addChildren([
  connexionRoute,
  assistantRoute,
  appRoute.addChildren([
    createRoute(page('/', () => import('@/pages/decouvrir'), 'DecouvrirPage')),
    // Films et Séries gardent le genre choisi dans l'adresse (`?genre=`), pour le retour depuis une fiche.
    createRoute({ ...page('/films', () => import('@/pages/films'), 'FilmsPage'), validateSearch: genreSearchSchema }),
    createRoute({
      ...page('/series', () => import('@/pages/series'), 'SeriesPage'),
      validateSearch: genreSearchSchema,
    }),
    createRoute(page('/titre/$type/$id', () => import('@/pages/fiche'), 'FichePage')),
    createRoute(page('/plateforme/$type/$id', () => import('@/pages/plateforme'), 'PlateformePage')),
    // `?membre=` : un gestionnaire lit les demandes d'un membre (lien de Réglages › Membres).
    createRoute({
      ...page('/demandes', () => import('@/pages/demandes'), 'DemandesPage'),
      validateSearch: requestsSearchSchema,
    }),
    createRoute(page('/ma-liste', () => import('@/pages/ma-liste'), 'MaListePage')),
    createRoute(page('/approbations', () => import('@/pages/approbations'), 'ApprobationsPage')),
    createRoute({
      ...page('/signalements', () => import('@/pages/signalements'), 'SignalementsPage'),
      validateSearch: issueSearchSchema,
    }),
    createRoute(page('/statistiques', () => import('@/pages/statistiques'), 'StatistiquesPage')),
    createRoute(page('/compte', () => import('@/pages/compte'), 'ComptePage')),
    createRoute(page('/reglages', () => import('@/pages/reglages'), 'ReglagesPage')),
    createRoute(page('/composants', () => import('@/pages/composants'), 'ComposantsPage')),
  ]),
]);

export const router = createRouter({
  routeTree,
  // Fourni par main.tsx (RouterProvider).
  context: { queryClient: undefined as unknown as QueryClient },
  defaultPreload: 'intent',
  defaultPendingComponent: () => <LoadingState />,
  defaultErrorComponent: RouteError,
  defaultNotFoundComponent: IntrouvablePage,
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
