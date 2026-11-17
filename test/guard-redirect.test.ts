import { describe, expect, it } from 'vitest';
import { guardRedirect } from '../src/client/lib/session.ts';
import { capabilitiesOf, type Role } from '../src/shared/roles.ts';
import type { SetupState } from '../src/shared/setup.ts';

const setupOf = (hasOwner: boolean, emby: boolean, complete: boolean): SetupState => ({
  services: { emby, tmdb: complete, radarr: complete, sonarr: complete, rules: complete },
  hasOwner,
  complete,
});
const viewerAs = (role: Role) => ({
  id: role,
  name: role,
  role,
  capabilities: capabilitiesOf(role),
  avatarUrl: null,
});
const guard = (path: string, setup: SetupState, role: Role | null) =>
  guardRedirect(path, path, setup, role && viewerAs(role));

describe('guardRedirect', () => {
  it.each([true, false])(
    'sans propriétaire (emby=%s) : tout mène à l’assistant sauf /assistant et /connexion si Emby',
    (emby) => {
      const setup = setupOf(false, emby, false);
      expect(guard('/assistant', setup, null)).toBeNull();
      expect(guard('/demandes', setup, null)).toEqual({ to: '/assistant' });
      expect(guard('/connexion', setup, null)).toEqual(emby ? null : { to: '/assistant' });
    },
  );

  it.each([true, false])(
    'propriétaire existant, déconnecté (emby=%s) : toujours /connexion, jamais /assistant',
    (emby) => {
      for (const complete of [true, false]) {
        const setup = setupOf(true, emby, complete);
        expect(guard('/connexion', setup, null)).toBeNull();
        expect(guard('/assistant', setup, null)).toEqual({ to: '/connexion', retour: '/assistant' });
        expect(guard('/demandes', setup, null)).toEqual({ to: '/connexion', retour: '/demandes' });
      }
    },
  );

  it('propriétaire connecté, installation complète : tout est ouvert', () => {
    const setup = setupOf(true, true, true);
    for (const path of ['/assistant', '/reglages', '/compte', '/demandes'])
      expect(guard(path, setup, 'owner')).toBeNull();
  });

  it('propriétaire connecté, installation incomplète : /assistant et /compte seulement', () => {
    const setup = setupOf(true, true, false);
    expect(guard('/assistant', setup, 'owner')).toBeNull();
    expect(guard('/compte', setup, 'owner')).toBeNull();
    for (const path of ['/', '/demandes', '/reglages'])
      expect(guard(path, setup, 'owner')).toEqual({ to: '/assistant' });
  });

  it.each([true, false])('membre connecté (complete=%s) : pas d’assistant ni de réglages', (complete) => {
    const setup = setupOf(true, true, complete);
    expect(guard('/assistant', setup, 'member')).toEqual({ to: '/' });
    expect(guard('/reglages', setup, 'member')).toEqual({ to: '/' });
    expect(guard('/compte', setup, 'member')).toBeNull();
    expect(guard('/demandes', setup, 'member')).toBeNull();
  });
});
