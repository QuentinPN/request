import { Page } from '@/components/page';
import { SetupSections } from '@/components/setup/setup-sections';

/** Réglages (propriétaire) : les sections de l'assistant, modifiables une par une. */
export function ReglagesPage() {
  return (
    <Page title="Réglages">
      <div className="max-w-[760px]">
        <SetupSections wizard={false} />
      </div>
    </Page>
  );
}
