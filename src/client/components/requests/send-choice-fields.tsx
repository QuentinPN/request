import type { SeriesType } from '@shared/settings.ts';
import { useId } from 'react';
import { ExternalServerLink } from '@/components/external-server-link';
import { formatBytes, seriesTypeLabels } from '@/components/setup/config';
import { FieldHint, Label, NativeSelect } from '@/components/ui/field';
import type { SendChoice, SendOptions, ShownSendChoice } from '@/lib/approvals';

/**
 * Serveur, profil de qualité, dossier racine et type de série d'envoi : approbation (panneau de détail), demande avancée
 * (feuille de demande) et effets d'une règle de surcharge. `value` : valeurs affichées (`shownSendChoice`) ; `onChoice`
 * reçoit le seul champ changé. `unset` : libellé d'une option vide (champ laissé inchangé, `undefined`), pour une règle.
 */
export function SendChoiceFields({
  service,
  options,
  value,
  onChoice,
  disabled,
  unset,
}: {
  /** « Radarr », « Sonarr 4K » : type et qualité de la demande. */
  service: string;
  options: SendOptions;
  value: ShownSendChoice;
  onChoice: (patch: SendChoice) => void;
  disabled: boolean;
  unset?: string | undefined;
}) {
  const id = useId();
  // Serveurs 4K et non 4K mêlés (règle de surcharge) : la qualité suit le nom.
  const mixed = new Set(options.servers.map((s) => s.is4k)).size > 1;
  const empty = unset !== undefined && <option value="">{unset}</option>;
  const free = options.rootFolders.find((f) => f.path === value.rootFolderPath)?.freeSpace;
  const server = options.servers.find((s) => s.id === options.serverId);
  return (
    <fieldset className="space-y-4" disabled={disabled}>
      <legend className="mb-3 text-[13px] font-semibold">Envoyer à {server?.name ?? service}</legend>
      {options.servers.length > 1 && (
        <div>
          <Label htmlFor={`${id}-server`} className="font-medium text-muted-foreground">
            Serveur {service}
          </Label>
          <NativeSelect
            id={`${id}-server`}
            value={options.serverId}
            // Profils et dossiers sont propres à chaque serveur : ceux du nouveau serveur reprennent leurs défauts.
            onChange={(event) =>
              onChoice({ serverId: Number(event.target.value), qualityProfileId: undefined, rootFolderPath: undefined })
            }
          >
            {options.servers.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
                {mixed && s.is4k && ' · 4K'}
                {s.isDefault && ' (par défaut)'}
              </option>
            ))}
          </NativeSelect>
        </div>
      )}
      {server?.externalUrl && <ExternalServerLink service={service} href={server.externalUrl} />}
      <div>
        <Label htmlFor={`${id}-profile`} className="font-medium text-muted-foreground">
          Profil de qualité
        </Label>
        <NativeSelect
          id={`${id}-profile`}
          value={value.qualityProfileId ?? ''}
          onChange={(event) =>
            onChoice({ qualityProfileId: event.target.value === '' ? undefined : Number(event.target.value) })
          }
        >
          {empty}
          {options.qualityProfiles.map((profile) => (
            <option key={profile.id} value={profile.id}>
              {profile.name}
            </option>
          ))}
        </NativeSelect>
        {options.anime && (
          <FieldHint>Série d’animation : valeurs par défaut des réglages anime de {server?.name}.</FieldHint>
        )}
      </div>
      <div>
        <Label htmlFor={`${id}-folder`} className="font-medium text-muted-foreground">
          Dossier racine
        </Label>
        <NativeSelect
          id={`${id}-folder`}
          value={value.rootFolderPath ?? ''}
          onChange={(event) => onChoice({ rootFolderPath: event.target.value || undefined })}
        >
          {empty}
          {options.rootFolders.map((f) => (
            <option key={f.id} value={f.path}>
              {f.path}
            </option>
          ))}
        </NativeSelect>
        {free !== undefined && <FieldHint>Espace libre : {formatBytes(free)}</FieldHint>}
      </div>
      {(value.seriesType || (unset !== undefined && options.defaultSeriesType !== null)) && (
        <div>
          <Label htmlFor={`${id}-series-type`} className="font-medium text-muted-foreground">
            Type de série
          </Label>
          <NativeSelect
            id={`${id}-series-type`}
            value={value.seriesType ?? ''}
            onChange={(event) => onChoice({ seriesType: (event.target.value || undefined) as SeriesType | undefined })}
          >
            {empty}
            {Object.entries(seriesTypeLabels).map(([type, label]) => (
              <option key={type} value={type}>
                {label}
              </option>
            ))}
          </NativeSelect>
        </div>
      )}
      {options.rules.length > 0 && (
        <p className="text-xs text-muted-foreground">
          {options.rules.length > 1 ? 'Règles appliquées' : 'Règle appliquée'} :{' '}
          {options.rules.map((rule) => rule.name).join(', ')}
        </p>
      )}
    </fieldset>
  );
}
