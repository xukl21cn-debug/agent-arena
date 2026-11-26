import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Throwaway `ARENA_DATA_DIR` for tests that mount the whole app.
 *
 * Without one, `loadConfig({})` falls back to the repo's `data/`, so every test
 * run creates `data/chat` and `data/work` next to the real database — exactly
 * the directories the SQLite migration removed.
 */
export function tempDataDir(prefix: string): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(os.tmpdir(), `arena-${prefix}-`));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
