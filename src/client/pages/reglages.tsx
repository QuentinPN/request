import { useState } from 'react';
import { accountBack } from '@/components/back-button';
import { Page } from '@/components/page';
import { BlocklistSection } from '@/components/setup/blocklist-section';
import { MembersSection } from '@/components/setup/members-section';
import { SetupSections } from '@/components/setup/setup-sections';
import { useViewer } from '@/hooks/use-viewer';

/**
 * Réglages : le propriétaire y trouve les sections de l'assistant, modifiables une par une, et les autres réglages ; un
 * autre membre, seulement ce que ses droits ouvrent : Membres (« Gérer les membres ») et Blocages (« Gérer les
 * blocages »). Les autres réglages restent au propriétaire.
 */
export function ReglagesPage() {
  const capabilities = useViewer()?.capabilities;
  const [open, setOpen] = useState<'members' | 'blocklist' | null>(
    capabilities?.canManageUsers ? 'members' : 'blocklist',
  );
  const toggle = (section: 'members' | 'blocklist') => setOpen((o) => (o === section ? null : section));
  return (
    <Page title="Réglages" back={accountBack}>
      <div className="max-w-[760px]">
        {capabilities?.isOwner ? (
          <SetupSections wizard={false} />
        ) : (
          <div className="flex flex-col gap-4">
            {capabilities?.canManageUsers && (
              <MembersSection
                section="members"
                number={1}
                open={open === 'members'}
                onToggle={() => toggle('members')}
              />
            )}
            {capabilities?.canManageBlocklist && (
              <BlocklistSection
                section="blocklist"
                number={capabilities.canManageUsers ? 2 : 1}
                open={open === 'blocklist'}
                onToggle={() => toggle('blocklist')}
              />
            )}
          </div>
        )}
      </div>
    </Page>
  );
}
