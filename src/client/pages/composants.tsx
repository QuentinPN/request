import { Moon, Plus, Sun } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { type MediaStatus, mediaStatuses } from '../../shared/status.ts';
import { Poster, PosterSkeleton } from '../components/media/poster.tsx';
import { StatusPill } from '../components/media/status-pill.tsx';
import { Button } from '../components/ui/button.tsx';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card.tsx';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '../components/ui/dialog.tsx';
import { Skeleton } from '../components/ui/skeleton.tsx';

// Page de démonstration du jalon 1.2, conservée hors navigation sur /composants.
const posters: { title: string; year: number; status?: MediaStatus }[] = [
  { title: 'Titre disponible', year: 2024, status: 'available' },
  { title: 'Série partielle', year: 2022, status: 'partial' },
  { title: 'En cours de téléchargement', year: 2025, status: 'downloading' },
  { title: 'Déjà demandé', year: 2023, status: 'requested' },
  { title: 'En attente d’approbation', year: 2021, status: 'pending' },
  { title: 'Titre absent', year: 2020 },
];

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-4">
      <h2 className="text-(length:--fs-h2) font-semibold">{title}</h2>
      {children}
    </section>
  );
}

const seasons = [{ n: 1, status: 'available' as const }, { n: 2, status: 'available' as const }, { n: 3 }];

export function ComposantsPage() {
  const [light, setLight] = useState(false);
  const toggleTheme = () => {
    setLight(!light);
    document.documentElement.dataset.theme = light ? 'dark' : 'light';
  };

  return (
    <div className="mx-auto max-w-6xl space-y-12">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">Composants de base</h1>
          <p className="mt-1 text-muted-foreground">Tokens d’Hub appliqués aux composants shadcn (Base UI).</p>
        </div>
        <Button variant="secondary" onClick={toggleTheme}>
          {light ? <Moon data-icon="inline-start" /> : <Sun data-icon="inline-start" />}
          {light ? 'Thème sombre' : 'Thème clair'}
        </Button>
      </header>

      <Section title="Boutons">
        <div className="flex flex-wrap items-center gap-3">
          <Button>
            <Plus data-icon="inline-start" />
            Demander
          </Button>
          <Button variant="secondary">Plus d’infos</Button>
          <Button variant="outline">Contour</Button>
          <Button variant="ghost">Discret</Button>
          <Button variant="destructive">Refuser</Button>
          <Button disabled>Indisponible</Button>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Button size="sm">Petit</Button>
          <Button>Normal</Button>
          <Button size="lg">Grand</Button>
        </div>
      </Section>

      <Section title="Pastilles de statut">
        <div className="flex flex-wrap gap-2">
          {mediaStatuses.map((s) => (
            <StatusPill key={s} status={s} />
          ))}
        </div>
        <div className="flex flex-wrap gap-2 rounded-card bg-(--media-base) p-4">
          {mediaStatuses.map((s) => (
            <StatusPill key={s} status={s} onMedia />
          ))}
        </div>
      </Section>

      <Section title="Affiches">
        <div className="-mx-(--space-page) flex gap-4 overflow-x-auto px-(--space-page) pt-2 pb-6">
          {posters.map((p) => (
            <Poster key={p.title} {...p} onRequest={() => {}} />
          ))}
          <PosterSkeleton />
        </div>
      </Section>

      <div className="grid gap-12 md:grid-cols-2">
        <Section title="Carte">
          <Card>
            <CardHeader>
              <CardTitle>Demande</CardTitle>
              <CardDescription>Demandé par Request le 16 novembre</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <StatusPill status="downloading" />
              <div
                className="h-1.5 overflow-hidden rounded-pill bg-(--track)"
                role="progressbar"
                aria-label="Progression du téléchargement"
                aria-valuenow={62}
                aria-valuemin={0}
                aria-valuemax={100}
              >
                <div className="h-full w-[62%] rounded-pill bg-brand" />
              </div>
              <p className="text-xs text-muted-foreground">62 % · environ 8 min restantes</p>
            </CardContent>
          </Card>
        </Section>

        <Section title="Dialogue et squelettes">
          <Dialog>
            <DialogTrigger render={<Button />}>Ouvrir la feuille de demande</DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Demander une série</DialogTitle>
                <DialogDescription>Choisis les saisons. Il te reste 4 demandes cette semaine.</DialogDescription>
              </DialogHeader>
              <fieldset className="space-y-2">
                <legend className="sr-only">Saisons</legend>
                {seasons.map((s) => (
                  <label
                    key={s.n}
                    className="flex items-center justify-between gap-3 rounded-lg bg-muted px-3 py-2.5 has-disabled:opacity-60"
                  >
                    <span className="flex items-center gap-3">
                      <input
                        type="checkbox"
                        className="size-4 accent-(--accent-play)"
                        disabled={!!s.status}
                        defaultChecked={!!s.status}
                      />
                      Saison {s.n}
                    </span>
                    {s.status && <StatusPill status={s.status} />}
                  </label>
                ))}
              </fieldset>
              <DialogFooter>
                <DialogClose render={<Button variant="secondary" />}>Annuler</DialogClose>
                <Button>Demander</Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
          <div className="space-y-2 pt-2">
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="h-24 w-full rounded-card" />
          </div>
        </Section>
      </div>
    </div>
  );
}
