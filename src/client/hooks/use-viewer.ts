import type { Viewer } from '@shared/auth.ts';
import { useQuery } from '@tanstack/react-query';
import { viewerQuery } from '@/lib/session';

/** Membre connecté (chargé par le garde du routeur avant toute page), `null` sans session. */
export function useViewer(): Viewer | null {
  return useQuery(viewerQuery).data ?? null;
}
