import { useState } from 'react';
import { accountBack } from '@/components/back-button';
import { Page } from '@/components/page';
import { BlocklistSection } from '@/components/setup/blocklist-section';
import { SetupSections } from '@/components/setup/setup-sections';
import { useViewer } from '@/hooks/use-viewer';

/**
 * Réglages : le propriétaire y trouve les sections de l'assistant, modifiables une par une, et les autres réglages ; un
 * gestionnaire, seulement les blocages (droit « Gérer les blocages »).
 */
export function ReglagesPage() {
  const isOwner = useViewer()?.capabilities.isOwner === true;
  const [open, setOpen] = useState(true);
  return (
    <Page title="Réglages" back={accountBack}>
      <div className="max-w-[760px]">
        {isOwner ? (
          <SetupSections wizard={false} />
        ) : (
          <BlocklistSection section="blocklist" number={1} open={open} onToggle={() => setOpen((o) => !o)} />
        )}
      </div>
    </Page>
  );
}
