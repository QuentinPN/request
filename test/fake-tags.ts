import { type FakeRoutes, status } from './fake-server.ts';

export interface FakeTag {
  id: number;
  label: string;
}

/**
 * `GET` et `POST /api/v3/tag` d'un faux Radarr/Sonarr : comme les vrais, le libellé est mis en minuscules et un libellé
 * déjà pris est refusé (400). `tags` est la liste vivante, pour les assertions.
 */
export function fakeTagRoutes(initial: readonly FakeTag[] = []): { routes: FakeRoutes; tags: FakeTag[] } {
  const tags = [...initial];
  const routes: FakeRoutes = {
    'GET /api/v3/tag': (req, res) => status(200, tags)(req, res),
    'POST /api/v3/tag': (req, res) => {
      const label = String((req.body as { label?: unknown })?.label ?? '').toLowerCase();
      if (tags.some((t) => t.label === label)) return status(400, [{ errorMessage: 'Tag exists' }])(req, res);
      const tag = { id: Math.max(0, ...tags.map((t) => t.id)) + 1, label };
      tags.push(tag);
      return status(201, tag)(req, res);
    },
  };
  return { routes, tags };
}
