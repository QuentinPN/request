import { ExternalLink } from 'lucide-react';

/** « Ouvrir dans Radarr » : lien vers l'adresse externe d'un serveur Radarr/Sonarr (Réglages, approbation). */
export function ExternalServerLink({ service, href }: { service: string; href: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="inline-flex min-h-8 items-center gap-1.5 text-sm text-muted-foreground underline underline-offset-4 hover:text-foreground"
    >
      Ouvrir dans {service}
      <ExternalLink className="size-3.5" aria-hidden="true" />
    </a>
  );
}
