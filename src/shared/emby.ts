import { z } from 'zod';

/** Ce qui permet au navigateur d'un membre de bâtir le lien « Regarder dans Emby » : adresse publique et id du serveur. */
export const embyLinkSchema = z.object({ publicUrl: z.string(), serverId: z.string() });
export type EmbyLink = z.infer<typeof embyLinkSchema>;

/** `null` : pas d'adresse publique réglée, ou Emby injoignable : aucun lien à montrer. */
export const embyLinkResponseSchema = z.object({ link: embyLinkSchema.nullable() });
export type EmbyLinkResponse = z.infer<typeof embyLinkResponseSchema>;

export const EMBY_LINK_PATH = '/api/emby/link';

/**
 * Lien « Regarder dans Emby » vers l'interface web (format du forum Emby, non documenté officiellement : `serverId`
 * requis, voir docs/integrations.md).
 */
export function embyWebLink({ publicUrl, serverId }: EmbyLink, itemId: string): string {
  const base = publicUrl.replace(/\/+$/, '');
  return `${base}/web/index.html#!/item?id=${encodeURIComponent(itemId)}&serverId=${encodeURIComponent(serverId)}`;
}
