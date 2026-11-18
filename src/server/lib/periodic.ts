/**
 * Tâche planifiée dans le processus : un tour après `firstDelayMs`, puis toutes les `intervalMs`. Un tour encore en
 * cours fait sauter le suivant, et `task` peut renvoyer `undefined` quand il n'y a rien à faire. Un échec est
 * journalisé sous `label` sans arrêter la planification. `stop` arrête les minuteurs et attend le tour en cours.
 */
export function startPeriodic(
  label: string,
  task: () => Promise<unknown> | undefined,
  { firstDelayMs, intervalMs }: { firstDelayMs: number; intervalMs: number },
) {
  let current: Promise<unknown> | null = null;
  const run = () => {
    if (current) return;
    const running = task();
    if (!running) return;
    current = running
      .catch((error: unknown) => console.error(label, error))
      .finally(() => {
        current = null;
      });
  };
  const first = setTimeout(run, firstDelayMs);
  const timer = setInterval(run, intervalMs);
  first.unref();
  timer.unref();
  return {
    async stop() {
      clearTimeout(first);
      clearInterval(timer);
      await current;
    },
  };
}
