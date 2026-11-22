// Préchargé par `bun test` (bunfig.toml). Les tests importent `vitest` ; Bun leur donne son propre
// `vi`, auquel manquent des fonctions de Vitest 5 (advanceTimersByTimeAsync, waitFor, stubEnv, stubGlobal,
// setSystemTime) et dont les faux minuteurs ignorent `toFake`. On les remplace par le code de Vitest 5.1.0
// (FakeTimers, waitFor, stubs), sur @sinonjs/fake-timers 15.4.0, la version que Vitest 5.1.0 embarque.
// Les autres fonctions de minuteurs de Vitest restent absentes : un appel échoue, il ne fait rien en silence.
import { type Clock, type Config, type FakeMethod, withGlobal } from '@sinonjs/fake-timers';
import { afterAll, vi } from 'vitest';

type FakeTimerConfig = Config;
type WaitForOptions = number | { timeout?: number; interval?: number; message?: string };

// Captés avant tout faux minuteur : waitFor attend en temps réel, comme celui de Vitest.
const real = { setTimeout, setInterval, clearTimeout, clearInterval, now: Date.now };

// Défauts de Vitest 5.1.0 (fakeTimersDefaults).
const FAKE_TIMERS_DEFAULTS: FakeTimerConfig = { loopLimit: 10_000, shouldClearNativeTimers: true };
const fakeTimers = withGlobal(globalThis);
let clock: Clock | null = null;
let fakingTime = false;
let fakingDate: Date | null = null;

function installedClock(): Clock {
  if (!fakingTime || !clock) {
    throw new Error(
      'A function to advance timers was called but the timers APIs are not mocked. Call `vi.useFakeTimers()` in the test file first.',
    );
  }
  return clock;
}

function useRealTimers() {
  if (fakingDate) {
    clock?.uninstall();
    fakingDate = null;
  }
  if (fakingTime) {
    clock?.uninstall();
    fakingTime = false;
  }
  clock = null;
  return vi;
}

function useFakeTimers(config?: FakeTimerConfig) {
  const userConfig = { ...FAKE_TIMERS_DEFAULTS, ...config };
  const now = fakingDate ?? real.now();
  if (fakingDate) {
    clock?.uninstall();
    fakingDate = null;
  }
  if (fakingTime) clock?.uninstall();
  let { toFake, toNotFake } = userConfig;
  // Comme Vitest : nextTick et queueMicrotask restent réels par défaut.
  if (toFake === undefined && toNotFake === undefined) {
    toFake = (Object.keys(fakeTimers.timers) as FakeMethod[]).filter(
      (timer) => timer !== 'nextTick' && timer !== 'queueMicrotask',
    );
  } else if (toFake === undefined && toNotFake !== undefined) {
    for (const timer of ['nextTick', 'queueMicrotask'] as const) {
      if (!toNotFake.includes(timer)) toNotFake = [...toNotFake, timer];
    }
  }
  clock = fakeTimers.install({
    now,
    ...userConfig,
    ...(toFake && { toFake }),
    ...(toNotFake && { toNotFake }),
    ignoreMissingTimers: true,
  });
  fakingTime = true;
  return vi;
}

function setSystemTime(time?: number | string | Date) {
  const date = time === undefined || time instanceof Date ? time : new Date(time);
  if (fakingTime) installedClock().setSystemTime(date);
  else {
    const next = date ?? new Date(real.now());
    if (fakingDate && clock) {
      fakingDate = next;
      clock.setSystemTime(next);
    } else {
      fakingDate = next;
      clock = fakeTimers.install({ now: next, toFake: ['Date'], ignoreMissingTimers: true });
    }
  }
  return vi;
}

function waitFor<T>(callback: () => T | Promise<T>, options: WaitForOptions = {}): Promise<T> {
  const { interval = 50, timeout = 1000, message } = typeof options === 'number' ? { timeout: options } : options;
  return new Promise<T>((resolve, reject) => {
    let lastError: unknown;
    let promiseStatus: 'idle' | 'pending' | 'resolved' | 'rejected' = 'idle';
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    let intervalId: ReturnType<typeof setInterval> | undefined;
    const onResolve = (result: T) => {
      if (timeoutId) real.clearTimeout(timeoutId);
      if (intervalId) real.clearInterval(intervalId);
      resolve(result);
    };
    const handleTimeout = () => {
      if (intervalId) real.clearInterval(intervalId);
      const error = lastError instanceof Error ? lastError : new Error('Timed out in waitFor!');
      if (message) error.message = `${message}: ${error.message}`;
      reject(error);
    };
    const checkCallback = () => {
      if (fakingTime) installedClock().tick(interval);
      if (promiseStatus === 'pending') return;
      try {
        const result = callback();
        if (result !== null && typeof result === 'object' && typeof (result as Promise<T>).then === 'function') {
          promiseStatus = 'pending';
          (result as Promise<T>).then(
            (value) => {
              promiseStatus = 'resolved';
              onResolve(value);
            },
            (error: unknown) => {
              promiseStatus = 'rejected';
              lastError = error;
            },
          );
        } else {
          onResolve(result as T);
          return true;
        }
      } catch (error) {
        lastError = error;
      }
    };
    if (checkCallback() === true) return;
    timeoutId = real.setTimeout(handleTimeout, timeout);
    intervalId = real.setInterval(checkCallback, interval);
  });
}

const stubbedGlobals = new Map<string | symbol, PropertyDescriptor | undefined>();
const stubbedEnvs = new Map<string, string | undefined>();
// Vitest écrit dans import.meta.env, qui est process.env sous Node comme sous Bun.
const ENV_BOOLEANS = ['PROD', 'DEV', 'SSR'];

function stubGlobal(name: string | symbol | number, value: unknown) {
  const key = typeof name === 'number' ? String(name) : name;
  if (!stubbedGlobals.has(key)) stubbedGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  Object.defineProperty(globalThis, key, { value, writable: true, configurable: true, enumerable: true });
  return vi;
}

function unstubAllGlobals() {
  stubbedGlobals.forEach((original, key) => {
    if (!original) Reflect.deleteProperty(globalThis, key);
    else Object.defineProperty(globalThis, key, original);
  });
  stubbedGlobals.clear();
  return vi;
}

function stubEnv(name: string, value: string | boolean | undefined) {
  if (!stubbedEnvs.has(name)) stubbedEnvs.set(name, process.env[name]);
  if (value === undefined) delete process.env[name];
  else if (ENV_BOOLEANS.includes(name)) process.env[name] = value ? '1' : '';
  else process.env[name] = String(value);
  return vi;
}

function unstubAllEnvs() {
  stubbedEnvs.forEach((original, name) => {
    if (original === undefined) delete process.env[name];
    else process.env[name] = original;
  });
  stubbedEnvs.clear();
  return vi;
}

Object.assign(vi, {
  useFakeTimers,
  useRealTimers,
  isFakeTimers: () => fakingTime,
  setSystemTime,
  getMockedSystemTime: () => (fakingTime ? new Date(installedClock().now) : fakingDate),
  getRealSystemTime: () => real.now(),
  getTimerCount: () => installedClock().countTimers(),
  clearAllTimers: () => {
    if (fakingTime) clock?.reset();
    return vi;
  },
  advanceTimersByTime: (ms: number) => {
    installedClock().tick(ms);
    return vi;
  },
  advanceTimersByTimeAsync: async (ms: number) => {
    await installedClock().tickAsync(ms);
    return vi;
  },
  advanceTimersToNextTimer: (steps = 1) => {
    const c = installedClock();
    for (let i = steps; i > 0; i--) {
      c.next();
      c.tick(0);
      if (c.countTimers() === 0) break;
    }
    return vi;
  },
  runAllTimers: () => {
    installedClock().runAll();
    return vi;
  },
  runOnlyPendingTimers: () => {
    installedClock().runToLast();
    return vi;
  },
  waitFor,
  stubGlobal,
  unstubAllGlobals,
  stubEnv,
  unstubAllEnvs,
});

// Remise à zéro après chaque fichier (--isolate donne déjà un global neuf) : minuteurs réels, stubs et espions défaits.
afterAll(() => {
  useRealTimers();
  unstubAllGlobals();
  unstubAllEnvs();
  vi.restoreAllMocks();
});
