import type { Member } from '../src/shared/auth.ts';
import { memberNamed } from './requests-mocks.ts';

/** Membres de Réglages › Membres : le propriétaire connecté (`id-owner`), un gestionnaire, un membre jamais connecté. */
export const membersFixture = (): Member[] => [
  { ...memberNamed('Quentin'), id: 'id-owner', role: 'owner', lastLoginAt: '2026-11-17T20:30:00.000Z' },
  { ...memberNamed('Marion'), role: 'manager', lastLoginAt: '2026-11-10T09:05:00.000Z' },
  memberNamed('Théo'),
];
