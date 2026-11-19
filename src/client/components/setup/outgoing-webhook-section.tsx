import { type MaskedSetting, settingSchemas } from '@shared/settings.ts';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { CheckboxField } from '@/components/ui/field';
import { AgentFormView, AgentInput, fieldError, useAgentForm } from './agent-form';
import { agentQuery } from './queries';
import { LoadedSection, type SectionFrameProps } from './section-frame';

const { shape } = settingSchemas.outgoingWebhook;

/** Exemple du corps envoyé (`OutgoingWebhookPayload`, documenté dans docs/API.md). */
const EXAMPLE = `{
  "type": "requested",
  "title": "Nouvelle demande à approuver",
  "message": "Matrix (1999)\\nDemandé par Alice",
  "media": { "type": "movie", "tmdbId": 603, "title": "Matrix" },
  "request": { "id": 12, "status": "pending" },
  "user": { "name": "Alice" },
  "issue": null
}`;

function OutgoingWebhookForm({ stored, ...frame }: SectionFrameProps & { stored: MaskedSetting<'outgoingWebhook'> }) {
  const [url, setUrl] = useState(stored.url ?? '');
  // Vide : garder l'en-tête enregistré (il ne revient jamais du serveur), même adresse seulement.
  const [authorization, setAuthorization] = useState('');
  // Cochée : supprimer l'en-tête enregistré (`null`), la saisie est alors ignorée.
  const [clearAuthorization, setClearAuthorization] = useState(false);
  const form = useAgentForm('outgoingWebhook', stored, () => {
    setAuthorization('');
    setClearAuthorization(false);
  });

  const urlError = fieldError(shape.url, url);
  const authorizationError = fieldError(shape.authorization, authorization);
  const hasUrl = url.trim() !== '';
  const missingUrl = form.enabled && !hasUrl;
  const valid = !urlError && !authorizationError;
  const fields = {
    url: url.trim() || null,
    ...(clearAuthorization ? { authorization: null } : authorization.trim() && { authorization: authorization.trim() }),
  };

  return (
    <AgentFormView
      frame={frame}
      form={form}
      active={stored.enabled && stored.url !== null}
      intro={
        <>
          <p>
            Un POST JSON vers votre adresse à chaque évènement choisi, pour vos propres outils (Home Assistant, n8n…).
            Rien n’est envoyé tant que cette option est désactivée.
          </p>
          <details className="mt-2">
            <summary className="cursor-pointer font-medium text-foreground">Corps envoyé</summary>
            <pre className="mt-2 whitespace-pre-wrap break-words rounded-lg bg-muted p-3 text-xs text-foreground">
              {EXAMPLE}
            </pre>
          </details>
        </>
      }
      enableLabel="Envoyer un webhook à chaque évènement"
      savedNotice="Webhook sortant enregistré"
      testNotice="Requête de test envoyée : vérifiez la réception chez vous."
      canTest={hasUrl && valid}
      canSave={valid && !missingUrl}
      onTest={() => form.test.mutate(fields)}
      onSave={() => form.save.mutate({ ...fields, enabled: form.enabled, events: form.events })}
    >
      <AgentInput
        label="Adresse du webhook"
        inputMode="url"
        placeholder="https://exemple.fr/hooks/request"
        error={urlError ?? (missingUrl ? 'Saisissez l’adresse pour activer le webhook.' : null)}
        hint="http ou https."
        value={url}
        onChange={(e) => form.edit(() => setUrl(e.target.value))}
      />
      <AgentInput
        label="En-tête Authorization"
        type="password"
        autoComplete="new-password"
        placeholder={stored.authorization.set ? 'En-tête enregistré' : 'Bearer …'}
        error={authorizationError}
        hint={
          stored.authorization.set
            ? 'Enregistré et chiffré : laissez vide pour le garder (même adresse).'
            : 'Facultatif, tel qu’attendu par votre outil (« Bearer … »). Chiffré, il ne s’affiche plus ensuite.'
        }
        value={authorization}
        onChange={(e) => form.edit(() => setAuthorization(e.target.value))}
      />
      {stored.authorization.set && (
        <CheckboxField
          checked={clearAuthorization}
          onChange={(e) => form.edit(() => setClearAuthorization(e.target.checked))}
        >
          Supprimer l’en-tête enregistré
        </CheckboxField>
      )}
    </AgentFormView>
  );
}

/** Webhook sortant (propriétaire), facultatif et désactivé par défaut : hors de l'assistant. */
export function OutgoingWebhookSection(frame: SectionFrameProps) {
  const query = useQuery(agentQuery('outgoingWebhook'));
  return (
    <LoadedSection {...frame} todoLabel="Désactivé" query={query}>
      {(stored) => <OutgoingWebhookForm {...frame} stored={stored} />}
    </LoadedSection>
  );
}
