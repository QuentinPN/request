/** Adresse publique du serveur et son id : ce que réclament les liens d'Emby et de Jellyfin. */
export interface WebLinkTarget {
  publicUrl: string;
  serverId: string;
}

const webLink = ({ publicUrl, serverId }: WebLinkTarget, page: 'item' | 'details', itemId: string) =>
  `${publicUrl.replace(/\/+$/, '')}/web/index.html#!/${page}?id=${encodeURIComponent(itemId)}&serverId=${encodeURIComponent(serverId)}`;

/**
 * Lien « Regarder dans Emby » vers l'interface web (format du forum Emby, non documenté officiellement : `serverId`
 * requis, voir docs/integrations.md).
 */
export const embyWebLink = (target: WebLinkTarget, itemId: string): string => webLink(target, 'item', itemId);

/** Lien « Regarder dans Jellyfin » : même forme qu'Emby, page `details` (forme reprise de Seerr, docs/integrations.md). */
export const jellyfinWebLink = (target: WebLinkTarget, itemId: string): string => webLink(target, 'details', itemId);
