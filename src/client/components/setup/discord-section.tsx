import { type MaskedSetting, settingSchemas } from '@shared/settings.ts';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { AgentFormView, AgentInput, fieldError, useAgentForm } from './agent-form';
import { agentQuery } from './queries';
import { LoadedSection, type SectionFrameProps } from './section-frame';

function DiscordForm({ stored, ...frame }: SectionFrameProps & { stored: MaskedSetting<'discord'> }) {
  // Vide : garder l'adresse enregistrée (elle ne revient jamais du serveur).
  const [url, setUrl] = useState('');
  const form = useAgentForm('discord', stored, () => setUrl(''));

  const typed = url.trim();
  const urlError = fieldError(settingSchemas.discord.shape.webhookUrl, typed);
  const hasUrl = typed !== '' || stored.webhookUrl.set;
  const missingUrl = form.enabled && !hasUrl;
  const fieldMessage = urlError ?? (missingUrl ? 'Collez l’adresse du webhook pour activer les notifications.' : null);
  const fields = typed ? { webhookUrl: typed } : {};

  return (
    <AgentFormView
      frame={frame}
      form={form}
      active={stored.enabled && stored.webhookUrl.set}
      intro={
        <p>
          Dans Discord : Paramètres du salon › Intégrations › Webhooks › Nouveau webhook, puis « Copier l’URL du webhook
          ». Rien n’est envoyé tant que cette option est désactivée.
        </p>
      }
      enableLabel="Envoyer les notifications sur Discord"
      savedNotice="Notifications Discord enregistrées"
      testNotice="Message de test envoyé : vérifiez votre salon Discord."
      canTest={hasUrl && !urlError}
      canSave={!urlError && !missingUrl}
      onTest={() => form.test.mutate(fields)}
      onSave={() => form.save.mutate({ ...fields, enabled: form.enabled, events: form.events })}
    >
      <AgentInput
        label="Adresse du webhook"
        type="password"
        placeholder={stored.webhookUrl.set ? 'Adresse enregistrée' : 'https://discord.com/api/webhooks/…'}
        error={fieldMessage}
        hint={
          stored.webhookUrl.set
            ? 'Enregistrée et chiffrée : laissez vide pour la garder, ou collez-en une nouvelle.'
            : 'Elle donne le droit d’écrire dans le salon : elle est chiffrée et ne s’affiche plus ensuite.'
        }
        value={url}
        onChange={(e) => form.edit(() => setUrl(e.target.value))}
      />
    </AgentFormView>
  );
}

/** Notifications Discord (propriétaire), facultatives et désactivées par défaut : hors de l'assistant. */
export function DiscordSection(frame: SectionFrameProps) {
  const query = useQuery(agentQuery('discord'));
  return (
    <LoadedSection {...frame} todoLabel="Désactivé" query={query}>
      {(stored) => <DiscordForm {...frame} stored={stored} />}
    </LoadedSection>
  );
}
