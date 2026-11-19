import { useQuery } from '@tanstack/react-query';
import { Notice } from '@/components/notice';
import { CheckboxRow } from '@/components/ui/field';
import { useViewer } from '@/hooks/use-viewer';
import { errorMessage } from '@/lib/http';
import { autoRequestQuery, useSetAutoRequest } from '@/lib/watchlist';

/** Option du membre qui en a le droit : chaque titre qu'il ajoute à sa liste est aussi demandé (jamais à l'import). */
function AutoRequestCheckbox() {
  const setting = useQuery(autoRequestQuery);
  const save = useSetAutoRequest();
  if (!setting.data) return null;
  return (
    <div className="flex flex-col gap-2">
      <CheckboxRow
        checked={setting.data.enabled}
        disabled={save.isPending}
        onChange={(enabled) => save.mutate(enabled)}
        label="Demander automatiquement ce que j’ajoute à Ma liste"
        hint="Les titres ajoutés ensuite sont aussi demandés, avec votre quota et vos droits. Les imports et ce qui est déjà dans la liste ne demandent rien."
      />
      {save.isError && (
        <Notice tone="error" role="alert">
          {errorMessage(save.error, 'L’option n’a pas pu être enregistrée.')}
        </Notice>
      )}
    </div>
  );
}

export function AutoRequestOption() {
  const viewer = useViewer();
  return viewer?.capabilities.canAutoRequestWatchlist ? <AutoRequestCheckbox /> : null;
}
