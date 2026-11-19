import { type MaskedSetting, settingSchemas } from '@shared/settings.ts';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { CheckboxField } from '@/components/ui/field';
import { AgentFormView, AgentInput, fieldError, useAgentForm } from './agent-form';
import { agentQuery } from './queries';
import { LoadedSection, type SectionFrameProps } from './section-frame';

const { shape } = settingSchemas.telegram;

function TelegramForm({ stored, ...frame }: SectionFrameProps & { stored: MaskedSetting<'telegram'> }) {
  // Vide : garder le jeton enregistré (il ne revient jamais du serveur).
  const [botToken, setBotToken] = useState('');
  const [chatId, setChatId] = useState(stored.chatId ?? '');
  const [threadId, setThreadId] = useState(stored.threadId === null ? '' : String(stored.threadId));
  const [silent, setSilent] = useState(stored.silent);
  const form = useAgentForm('telegram', stored, () => setBotToken(''));

  const typedToken = botToken.trim();
  const tokenError = fieldError(shape.botToken, typedToken);
  const hasToken = typedToken !== '' || stored.botToken.set;
  const hasChat = chatId.trim() !== '';
  const missingToken = form.enabled && !hasToken;
  const missingChat = form.enabled && !hasChat;
  const complete = hasToken && hasChat;
  const fields = {
    ...(typedToken && { botToken: typedToken }),
    chatId: chatId.trim() || null,
    threadId: threadId ? Number(threadId) : null,
    silent,
  };

  return (
    <AgentFormView
      frame={frame}
      form={form}
      active={stored.enabled && stored.botToken.set && stored.chatId !== null}
      intro={
        <p>
          Créez un bot avec BotFather dans Telegram, ajoutez-le au chat, puis collez son jeton et l’identifiant du chat.
          Rien n’est envoyé tant que cette option est désactivée.
        </p>
      }
      enableLabel="Envoyer les notifications sur Telegram"
      savedNotice="Notifications Telegram enregistrées"
      testNotice="Message de test envoyé : vérifiez votre chat Telegram."
      canTest={complete && !tokenError}
      canSave={!tokenError && !missingToken && !missingChat}
      onTest={() => form.test.mutate(fields)}
      onSave={() => form.save.mutate({ ...fields, enabled: form.enabled, events: form.events })}
    >
      <AgentInput
        label="Jeton du bot"
        type="password"
        autoComplete="new-password"
        placeholder={stored.botToken.set ? 'Jeton enregistré' : '123456:ABC…'}
        error={tokenError ?? (missingToken ? 'Collez le jeton du bot.' : null)}
        hint={
          stored.botToken.set
            ? 'Enregistré et chiffré : laissez vide pour le garder, ou collez-en un nouveau.'
            : 'Il donne le droit d’écrire avec le bot : il est chiffré et ne s’affiche plus ensuite.'
        }
        value={botToken}
        onChange={(e) => form.edit(() => setBotToken(e.target.value))}
      />
      <div className="grid gap-4 sm:grid-cols-2">
        <AgentInput
          label="Identifiant du chat"
          placeholder="-1001234567890"
          error={missingChat ? 'Saisissez l’identifiant du chat.' : null}
          hint="Chat, groupe ou canal (@canal)."
          value={chatId}
          onChange={(e) => form.edit(() => setChatId(e.target.value))}
        />
        <AgentInput
          label="Identifiant du sujet"
          inputMode="numeric"
          hint="Facultatif : pour un groupe à sujets."
          value={threadId}
          onChange={(e) => form.edit(() => setThreadId(e.target.value.replace(/\D/g, '')))}
        />
      </div>
      <CheckboxField checked={silent} onChange={(e) => form.edit(() => setSilent(e.target.checked))}>
        Envoyer sans son (silencieux)
      </CheckboxField>
    </AgentFormView>
  );
}

/** Notifications Telegram (propriétaire), facultatives et désactivées par défaut : hors de l'assistant. */
export function TelegramSection(frame: SectionFrameProps) {
  const query = useQuery(agentQuery('telegram'));
  return (
    <LoadedSection {...frame} todoLabel="Désactivé" query={query}>
      {(stored) => <TelegramForm {...frame} stored={stored} />}
    </LoadedSection>
  );
}
