import type { WorkStore } from './store.js';

export function startWorkSweep(store: WorkStore): ReturnType<typeof setInterval> {
  return setInterval(() => {
    try { store.sweep(); }
    catch (error) { console.error('[work] 租约结算失败', error); }
  }, 15_000).unref();
}
