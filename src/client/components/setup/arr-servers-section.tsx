import { type ArrKind, type ArrServer, arrKindLabels, arrLabel } from '@shared/arr-servers.ts';
import { useState } from 'react';
import { ExternalServerLink } from '@/components/external-server-link';
import { Notice } from '@/components/notice';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { arrPayloadOf, IntegrationForm, type Values } from './integration-section';
import { useDeleteArrServer, useSaveArrServer } from './queries';
import { actionClass, SectionActions, SectionFrame, type SectionFrameProps, sectionStatus } from './section-frame';

type Props = SectionFrameProps & {
  kind: ArrKind;
  /** Tous les serveurs enregistrés, des deux types (une seule requête pour les deux sections). */
  servers: ArrServer[];
  saved: boolean;
  wizard: boolean;
  onSaved: () => void;
};

/** Section Radarr ou Sonarr : un seul serveur dans l'assistant, la liste complète dans les réglages. */
export function ArrServersSection({ wizard, ...props }: Props) {
  return wizard ? <WizardServer {...props} /> : <ServerList {...props} />;
}

/**
 * Assistant : configure le premier serveur du type (le serveur normal par défaut, sinon le premier normal), comme une
 * intégration ordinaire. Les autres serveurs et la 4K s'ajoutent ensuite dans les réglages.
 */
function WizardServer({ kind, servers, saved, onSaved, ...frame }: Omit<Props, 'wizard'>) {
  const ofKind = servers.filter((s) => s.type === kind && !s.is4k);
  const stored = ofKind.find((s) => s.isDefault) ?? ofKind[0] ?? null;
  const save = useSaveArrServer(stored?.id, onSaved);
  return (
    <IntegrationForm
      service={kind}
      stored={stored}
      wizard
      open={frame.open}
      defaults={stored ? undefined : { name: arrKindLabels[kind], isDefault: true }}
      save={save}
      toPayload={(v) => arrPayloadOf(kind, v)}
      render={(state, form) => (
        <SectionFrame {...frame} status={sectionStatus({ saved, open: frame.open, ...state })}>
          {form}
        </SectionFrame>
      )}
    />
  );
}

type Editing = number | 'new' | null;

/** Réglages : serveurs du type, chacun modifiable sur place avec le même formulaire que l'assistant. */
function ServerList({ kind, servers, saved, ...frame }: Omit<Props, 'wizard' | 'onSaved'>) {
  const label = arrKindLabels[kind];
  const ofKind = servers.filter((s) => s.type === kind);
  const [editing, setEditing] = useState<Editing>(null);
  const [deleting, setDeleting] = useState<ArrServer | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const edit = (target: Editing) => {
    setNotice(null);
    setEditing((current) => (current === target ? null : target));
  };

  return (
    <SectionFrame {...frame} status={sectionStatus({ saved, open: frame.open, failed: false, testing: false })}>
      <div className="flex flex-col gap-4">
        <p className="text-sm text-muted-foreground">
          Les demandes vont au serveur par défaut ; à l’approbation, vous pouvez en choisir un autre du même type. Un
          serveur 4K reçoit les demandes en 4K, dont la disponibilité est suivie à part.
        </p>
        {ofKind.length > 0 && (
          <ul className="flex flex-col gap-3" aria-label={`Serveurs ${label}`}>
            {ofKind.map((server) => (
              <li key={server.id} className="rounded-[12px] border border-border p-3 sm:p-4">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                  <div className="min-w-0 grow basis-48">
                    <p className="flex flex-wrap items-center gap-2 font-semibold">
                      {server.name}
                      {server.is4k && <Tag>4K</Tag>}
                      {server.isDefault && <Tag>Par défaut</Tag>}
                    </p>
                    <p className="truncate font-mono text-xs text-muted-foreground">{server.url}</p>
                    {server.externalUrl && (
                      <ExternalServerLink service={arrLabel(server.type, server.is4k)} href={server.externalUrl} />
                    )}
                  </div>
                  <div className="flex gap-2">
                    <Button
                      type="button"
                      variant="secondary"
                      aria-expanded={editing === server.id}
                      aria-label={`Modifier ${server.name}`}
                      onClick={() => edit(server.id)}
                    >
                      Modifier
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      aria-label={`Supprimer ${server.name}`}
                      onClick={() => setDeleting(server)}
                    >
                      Supprimer
                    </Button>
                  </div>
                </div>
                {editing === server.id && (
                  <div className="mt-4 border-t border-border pt-4">
                    <ServerForm kind={kind} server={server} onClose={() => setEditing(null)} />
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
        {editing === 'new' && (
          <div className="rounded-[12px] border border-ring p-3 sm:p-4">
            <h3 className="mb-4 font-semibold">Nouveau serveur {label}</h3>
            <ServerForm
              kind={kind}
              server={null}
              // Premier serveur du type : par défaut, nommé d'après le type ; les suivants se nomment à la main.
              defaults={ofKind.length === 0 ? { name: label, isDefault: true } : undefined}
              onClose={() => setEditing(null)}
              onAdded={(server) => {
                setEditing(null);
                setNotice(`${server.name} ajouté`);
              }}
            />
          </div>
        )}
        <div role="status" className="empty:hidden">
          {notice && <Notice tone="ok">{notice}</Notice>}
        </div>
        {editing !== 'new' && (
          <SectionActions>
            <Button type="button" size="lg" className={actionClass} onClick={() => edit('new')}>
              Ajouter un serveur {label}
            </Button>
          </SectionActions>
        )}
      </div>
      {deleting && (
        <DeleteDialog
          server={deleting}
          onClose={() => setDeleting(null)}
          onDone={() => {
            if (editing === deleting.id) setEditing(null);
            setNotice(`${deleting.name} supprimé`);
            setDeleting(null);
          }}
        />
      )}
    </SectionFrame>
  );
}

function Tag({ children }: { children: string }) {
  return (
    <span className="inline-flex h-5 items-center rounded-pill bg-(--surface-2) px-2 text-xs font-semibold text-muted-foreground">
      {children}
    </span>
  );
}

function ServerForm({
  kind,
  server,
  defaults,
  onClose,
  onAdded,
}: {
  kind: ArrKind;
  server: ArrServer | null;
  defaults?: Partial<Values>;
  onClose: () => void;
  onAdded?: (server: ArrServer) => void;
}) {
  const save = useSaveArrServer(server?.id, (saved) => onAdded?.(saved));
  return (
    <IntegrationForm
      service={kind}
      stored={server}
      wizard={false}
      open
      serverFields
      defaults={defaults}
      save={save}
      toPayload={(v) => arrPayloadOf(kind, v)}
      extraAction={
        <Button type="button" variant="ghost" size="lg" className={actionClass} onClick={onClose}>
          {server ? 'Fermer' : 'Annuler'}
        </Button>
      }
      render={(_, form) => form}
    />
  );
}

function DeleteDialog({ server, onClose, onDone }: { server: ArrServer; onClose: () => void; onDone: () => void }) {
  const remove = useDeleteArrServer(onDone);
  const label = arrKindLabels[server.type];
  return (
    <Dialog open onOpenChange={(open) => !open && !remove.isPending && onClose()}>
      <DialogContent className="max-sm:top-auto max-sm:bottom-4 max-sm:translate-y-0">
        <DialogHeader>
          <DialogTitle>Supprimer {server.name} ?</DialogTitle>
          <DialogDescription>
            Ses titres ne seront plus suivis par l’appli et les demandes ne pourront plus lui être envoyées. Rien n’est
            supprimé dans {label}.
          </DialogDescription>
        </DialogHeader>
        {remove.isError && <Notice tone="error">{remove.error.message}</Notice>}
        <DialogFooter>
          <Button variant="secondary" onClick={onClose} disabled={remove.isPending}>
            Annuler
          </Button>
          <Button variant="destructive" onClick={() => remove.mutate(server.id)} disabled={remove.isPending}>
            {remove.isPending ? 'Suppression…' : 'Supprimer'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
