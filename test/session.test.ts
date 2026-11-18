import { describe, expect, it } from 'vitest';
import { guardRedirect, safeReturnPath } from '../src/client/lib/session.ts';
import type { Viewer } from '../src/shared/auth.ts';
import { capabilitiesOf, type Role } from '../src/shared/roles.ts';
import type { SetupState } from '../src/shared/setup.ts';

const viewer = (role: Role): Viewer => ({
  id: 'u',
  name: 'U',
  role,
  capabilities: capabilitiesOf(role),
  avatarUrl: null,
});
const services = (saved: boolean) => ({ emby: saved, tmdb: saved, radarr: saved, sonarr: saved, rules: saved });
const fresh: SetupState = { services: services(false), hasOwner: false, complete: false };
const embyOnly: SetupState = { services: { ...services(false), emby: true }, hasOwner: false, complete: false };
const partial: SetupState = { services: { ...services(true), rules: false }, hasOwner: true, complete: false };
const complete: SetupState = { services: services(true), hasOwner: true, complete: true };

describe('guardRedirect', () => {
  it('installation neuve : tout mène à l’assistant, connexion comprise tant qu’Emby manque', () => {
    expect(guardRedirect('/', '/', fresh, null)).toEqual({ to: '/assistant' });
    expect(guardRedirect('/connexion', '/connexion', fresh, null)).toEqual({ to: '/assistant' });
    expect(guardRedirect('/assistant', '/assistant', fresh, null)).toBeNull();
  });

  it('Emby enregistré sans propriétaire : connexion et assistant ouverts', () => {
    expect(guardRedirect('/connexion', '/connexion', embyOnly, null)).toBeNull();
    expect(guardRedirect('/assistant', '/assistant', embyOnly, null)).toBeNull();
    expect(guardRedirect('/films', '/films', embyOnly, null)).toEqual({ to: '/assistant' });
  });

  it('déconnecté : connexion avec retour vers la page demandée', () => {
    expect(guardRedirect('/demandes', '/demandes?statut=1', complete, null)).toEqual({
      to: '/connexion',
      retour: '/demandes?statut=1',
    });
    expect(guardRedirect('/assistant', '/assistant', complete, null)).toEqual({
      to: '/connexion',
      retour: '/assistant',
    });
  });

  it('propriétaire et installation incomplète : assistant', () => {
    expect(guardRedirect('/', '/', partial, viewer('owner'))).toEqual({ to: '/assistant' });
    expect(guardRedirect('/assistant', '/assistant', partial, viewer('owner'))).toBeNull();
  });

  it('assistant réservé au propriétaire, réglages aussi aux gestionnaires des blocages', () => {
    expect(guardRedirect('/assistant', '/assistant', complete, viewer('manager'))).toEqual({ to: '/' });
    expect(guardRedirect('/reglages', '/reglages', complete, viewer('member'))).toEqual({ to: '/' });
    expect(guardRedirect('/reglages', '/reglages', complete, viewer('manager'))).toBeNull();
    expect(guardRedirect('/reglages', '/reglages', complete, viewer('owner'))).toBeNull();
    expect(guardRedirect('/demandes', '/demandes', complete, viewer('member'))).toBeNull();
  });
});

describe('safeReturnPath', () => {
  it('n’accepte qu’une adresse interne', () => {
    expect(safeReturnPath('/demandes?x=1')).toBe('/demandes?x=1');
    for (const bad of [
      '//evil.example',
      '/\\evil.example',
      '/\t/evil.example',
      '/\n/evil.example',
      'https://evil.example',
      '',
      3,
      undefined,
    ])
      expect(safeReturnPath(bad)).toBeUndefined();
  });
});
