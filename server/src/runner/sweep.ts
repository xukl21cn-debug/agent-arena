import type { RunnerRegistry } from './registry.js';

/** How often runner heartbeat expiry is checked. */
export const RUNNER_SWEEP_MS = 5_000;

/** Flip stale runners offline; Page clients also poll, so this is just the push side. */
export function startRunnerSweep(registry: RunnerRegistry, intervalMs = RUNNER_SWEEP_MS): NodeJS.Timeout {
  const timer = setInterval(() => registry.sweep(), intervalMs);
  timer.unref();
  return timer;
}
