import { NTFY_DEFAULT_URL } from '@shared/agents.ts';
import { type MaskedSetting, settingSchemas } from '@shared/settings.ts';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { CheckboxField } from '@/components/ui/field';
import { AgentFormView, AgentInput, fieldError, useAgentForm } from './agent-form';
import { agentQuery } from './queries';
import { LoadedSection, type SectionFrameProps } from './section-frame';

const { shape } = settingSchemas.ntfy;

function NtfyForm({ stored, ...frame }: SectionFrameProps & { stored: MaskedSetting<'ntfy'> }) {
  const [url, setUrl] = useState(stored.url);
  const [topic, setTopic] = useState(stored.topic ?? '');
  const [username, setUsername] = useState(stored.username ?? '');
  // Vides : garder le jeton et le mot de passe enregistrés (ils ne reviennent jamais du serveur), même serveur,
  // même sujet et même identifiant seulement.
  const [token, setToken] = useState('');
  const [password, setPassword] = useState('');
  // Cochée : supprimer le jeton enregistré (`null`), la saisie est alors ignorée.
  const [clearToken, setClearToken] = useState(false);
  const form = useAgentForm('ntfy', stored, () => {
    setToken('');
    setPassword('');
    setClearToken(false);
  });

  const errors = { url: fieldError(shape.url, url), topic: fieldError(shape.topic, topic) };
  const hasTopic = topic.trim() !== '';
  const missingTopic = form.enabled && !hasTopic;
  const valid = !errors.url && !errors.topic;
  const fields = {
    ...(url.trim() && { url: url.trim() }),
    topic: topic.trim() || null,
    username: username.trim() || null,
    ...(clearToken ? { token: null } : token.trim() && { token: token.trim() }),
    ...(password && { password }),
  };

  return (
    <AgentFormView
      frame={frame}
      form={form}
      active={stored.enabled && stored.topic !== null}
      intro={
        <p>
          Un message sur le sujet choisi, du service public ntfy.sh ou de votre propre serveur. Rien n’est envoyé tant
          que cette option est désactivée.
        </p>
      }
      enableLabel="Envoyer les notifications sur ntfy"
      savedNotice="Notifications ntfy enregistrées"
      testNotice="Message de test envoyé : vérifiez votre application ntfy."
      canTest={hasTopic && valid}
      canSave={valid && !missingTopic}
      onTest={() => form.test.mutate(fields)}
      onSave={() => form.save.mutate({ ...fields, enabled: form.enabled, events: form.events })}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <AgentInput
          label="Serveur ntfy"
          inputMode="url"
          placeholder={NTFY_DEFAULT_URL}
          error={errors.url}
          hint="Adresse du serveur, https://ntfy.sh par défaut."
          value={url}
          onChange={(e) => form.edit(() => setUrl(e.target.value))}
        />
        <AgentInput
          label="Sujet"
          placeholder="demandes"
          error={errors.topic ?? (missingTopic ? 'Saisissez le sujet pour activer les notifications.' : null)}
          hint="Sur ntfy.sh, tout le monde peut lire un sujet : choisissez un nom difficile à deviner."
          value={topic}
          onChange={(e) => form.edit(() => setTopic(e.target.value))}
        />
      </div>
      <AgentInput
        label="Jeton d’accès"
        type="password"
        autoComplete="new-password"
        placeholder={stored.token.set ? 'Jeton enregistré' : 'Facultatif'}
        hint={
          stored.token.set
            ? 'Enregistré et chiffré : laissez vide pour le garder (même serveur et même sujet).'
            : 'Facultatif, pour un sujet protégé. Chiffré, il ne s’affiche plus ensuite.'
        }
        value={token}
        onChange={(e) => form.edit(() => setToken(e.target.value))}
      />
      {stored.token.set && (
        <CheckboxField checked={clearToken} onChange={(e) => form.edit(() => setClearToken(e.target.checked))}>
          Supprimer le jeton enregistré
        </CheckboxField>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        <AgentInput
          label="Identifiant"
          hint="Facultatif : à la place du jeton, identifiant et mot de passe."
          value={username}
          onChange={(e) => form.edit(() => setUsername(e.target.value))}
        />
        <AgentInput
          label="Mot de passe"
          type="password"
          autoComplete="new-password"
          placeholder={stored.password.set ? 'Mot de passe enregistré' : undefined}
          hint={
            stored.password.set ? 'Chiffré : laissez vide pour le garder.' : 'Chiffré, il ne s’affiche plus ensuite.'
          }
          value={password}
          onChange={(e) => form.edit(() => setPassword(e.target.value))}
        />
      </div>
    </AgentFormView>
  );
}

/** Notifications ntfy (propriétaire), facultatives et désactivées par défaut : hors de l'assistant. */
export function NtfySection(frame: SectionFrameProps) {
  const query = useQuery(agentQuery('ntfy'));
  return (
    <LoadedSection {...frame} todoLabel="Désactivé" query={query}>
      {(stored) => <NtfyForm {...frame} stored={stored} />}
    </LoadedSection>
  );
}
