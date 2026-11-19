import { logError } from './logger.ts';

/**
 * Tâche planifiée dans le processus : un tour après `firstDelayMs`, puis toutes les `intervalMs`. Un tour encore en
 * cours fait sauter le suivant, et `task` peut renvoyer `undefined` quand il n'y a rien à faire. Un échec est
 * journalisé sous `label` sans arrêter la planification. `stop` arrête les minuteurs et attend le tour en cours ;
 * `setIntervalMs` change la fréquence sans redémarrage (le prochain tour est dans un intervalle plein) ;
 * `nextRunAt` donne l'heure du prochain tour (ms depuis l'époque).
 */
export function startPeriodic(
  label: string,
  task: () => Promise<unknown> | undefined,
  { firstDelayMs, intervalMs }: { firstDelayMs: number; intervalMs: number },
) {
  let current: Promise<unknown> | null = null;
  let interval = intervalMs;
  let firstAt: number | null = Date.now() + firstDelayMs;
  let intervalAt = Date.now() + interval;
  const run = () => {
    if (current) return;
    const running = task();
    if (!running) return;
    current = running
      .catch((error: unknown) => logError(label, error))
      .finally(() => {
        current = null;
      });
  };
  const tick = () => {
    intervalAt = Date.now() + interval;
    run();
  };
  const first = setTimeout(() => {
    firstAt = null;
    run();
  }, firstDelayMs);
  let timer = setInterval(tick, interval);
  first.unref();
  timer.unref();
  return {
    async stop() {
      clearTimeout(first);
      clearInterval(timer);
      await current;
    },
    setIntervalMs(ms: number) {
      clearInterval(timer);
      interval = ms;
      intervalAt = Date.now() + ms;
      timer = setInterval(tick, ms);
      timer.unref();
    },
    nextRunAt: () => (firstAt === null ? intervalAt : Math.min(firstAt, intervalAt)),
  };
}
