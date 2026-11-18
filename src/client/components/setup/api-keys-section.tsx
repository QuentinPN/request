import { API_KEYS_PATH, type ApiKey, type ApiKeyCreated, apiKeyCreateSchema, apiKeyPath } from '@shared/api-keys.ts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useId, useState } from 'react';
import { Notice } from '@/components/notice';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input, Label } from '@/components/ui/field';
import { apiSend } from '@/lib/http';
import { formatDateTime, formatDay } from '@/lib/requests';
import { CopyField } from './copy-field';
import { apiKeysQuery } from './queries';
import { actionClass, LoadedSection, SectionFrame, type SectionFrameProps } from './section-frame';

const isActive = (key: ApiKey) => key.revokedAt === null;

/** Clé affichée une seule fois : le serveur ne garde que son empreinte, la fermer la perd pour de bon. */
function SecretDialog({ secret, onClose }: { secret: string; onClose: () => void }) {
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-sm:top-auto max-sm:bottom-4 max-sm:translate-y-0">
        <DialogHeader>
          <DialogTitle>Clé créée</DialogTitle>
          <DialogDescription>
            Copiez-la maintenant et gardez-la en lieu sûr : elle ne sera plus jamais affichée. Elle donne les droits du
            propriétaire ; en cas de doute, révoquez-la.
          </DialogDescription>
        </DialogHeader>
        <CopyField label="Clé d’API" copyLabel="Copier la clé" value={secret} />
        <DialogFooter>
          <Button onClick={onClose}>J’ai copié la clé</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RevokeDialog({ apiKey, onClose }: { apiKey: ApiKey; onClose: () => void }) {
  const queryClient = useQueryClient();
  const revoke = useMutation({
    mutationFn: () => apiSend<void>('DELETE', apiKeyPath(apiKey.id)),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: apiKeysQuery.queryKey });
      onClose();
    },
  });

  return (
    <Dialog open onOpenChange={(open) => !open && !revoke.isPending && onClose()}>
      <DialogContent className="max-sm:top-auto max-sm:bottom-4 max-sm:translate-y-0">
        <DialogHeader>
          <DialogTitle>Révoquer cette clé ?</DialogTitle>
          <DialogDescription>
            Les outils qui utilisent la clé « {apiKey.name} » ({apiKey.prefix}…) cessent de fonctionner tout de suite.
            Cette action est définitive.
          </DialogDescription>
        </DialogHeader>
        {revoke.isError && <Notice tone="error">{revoke.error.message}</Notice>}
        <DialogFooter>
          <Button variant="secondary" onClick={onClose} disabled={revoke.isPending}>
            Annuler
          </Button>
          <Button variant="destructive" onClick={() => revoke.mutate()} disabled={revoke.isPending}>
            {revoke.isPending ? 'Révocation…' : 'Révoquer'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CreateForm({ onCreated }: { onCreated: (secret: string) => void }) {
  const id = useId();
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const parsed = apiKeyCreateSchema.safeParse({ name });
  const create = useMutation({
    mutationFn: (input: { name: string }) => apiSend<ApiKeyCreated>('POST', API_KEYS_PATH, input),
    onSuccess: async ({ secret }) => {
      setName('');
      await queryClient.invalidateQueries({ queryKey: apiKeysQuery.queryKey });
      onCreated(secret);
    },
  });

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (parsed.success) create.mutate(parsed.data);
  };

  return (
    <form noValidate onSubmit={onSubmit} className="flex flex-col gap-3">
      <div>
        <Label htmlFor={`${id}-name`}>Nom de la clé</Label>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input
            id={`${id}-name`}
            value={name}
            maxLength={100}
            placeholder="Home Assistant"
            autoComplete="off"
            onChange={(e) => {
              setName(e.target.value);
              create.reset();
            }}
            className="min-w-0"
          />
          <Button type="submit" size="lg" className={actionClass} disabled={!parsed.success || create.isPending}>
            {create.isPending ? 'Création…' : 'Créer la clé'}
          </Button>
        </div>
      </div>
      {create.isError && <Notice tone="error">{create.error.message}</Notice>}
    </form>
  );
}

function KeyRow({ apiKey, onRevoke }: { apiKey: ApiKey; onRevoke: () => void }) {
  const active = isActive(apiKey);
  return (
    <li className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:gap-4">
      <div className="flex min-w-0 grow flex-col gap-0.5">
        <span className="flex flex-wrap items-center gap-2">
          <span className={active ? 'font-semibold' : 'font-semibold text-muted-foreground'}>{apiKey.name}</span>
          <code className="text-[13px] text-muted-foreground">{apiKey.prefix}…</code>
          {!active && <Badge variant="secondary">Révoquée</Badge>}
        </span>
        <span className="text-xs text-muted-foreground">
          Créée le {formatDay(apiKey.createdAt)} par {apiKey.createdByName} ·{' '}
          {apiKey.lastUsedAt ? `Dernière utilisation : ${formatDateTime(apiKey.lastUsedAt)}` : 'Jamais utilisée'}
        </span>
      </div>
      {active && (
        <Button
          type="button"
          variant="secondary"
          className="border-input sm:shrink-0"
          aria-label={`Révoquer la clé ${apiKey.name}`}
          onClick={onRevoke}
        >
          Révoquer
        </Button>
      )}
    </li>
  );
}

/**
 * Clés d'API publiques (propriétaire) : l'en-tête `X-Api-Key` authentifie un script comme son créateur (docs/API.md).
 * Pas un réglage de l'assistant : rien à tester ni à enregistrer. Le secret n'apparaît qu'à la création.
 */
export function ApiKeysSection(frame: SectionFrameProps) {
  const query = useQuery(apiKeysQuery);
  const [secret, setSecret] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<ApiKey | null>(null);

  return (
    <LoadedSection {...frame} query={query} errorMessage="Les clés d’API n’ont pas pu se charger.">
      {(keys) => {
        const activeCount = keys.filter(isActive).length;
        return (
          <SectionFrame
            {...frame}
            status={activeCount > 0 ? 'done' : 'todo'}
            todoLabel="Aucune clé"
            doneLabel={`${activeCount} ${activeCount > 1 ? 'clés actives' : 'clé active'}`}
          >
            <div className="flex flex-col gap-4">
              <p className="text-sm text-muted-foreground">
                Pour un script ou un outil externe : envoyez la clé dans l’en-tête{' '}
                <code className="text-[13px] text-foreground">X-Api-Key</code> de chaque requête vers{' '}
                <code className="text-[13px] text-foreground">/api</code>. La requête agit comme vous, avec vos droits
                de propriétaire.
              </p>
              <CreateForm onCreated={setSecret} />
              {keys.length > 0 && (
                <ul className="divide-y divide-border border-y border-border">
                  {keys.map((apiKey) => (
                    <KeyRow key={apiKey.id} apiKey={apiKey} onRevoke={() => setRevoking(apiKey)} />
                  ))}
                </ul>
              )}
            </div>
            {secret !== null && <SecretDialog secret={secret} onClose={() => setSecret(null)} />}
            {revoking && <RevokeDialog apiKey={revoking} onClose={() => setRevoking(null)} />}
          </SectionFrame>
        );
      }}
    </LoadedSection>
  );
}
