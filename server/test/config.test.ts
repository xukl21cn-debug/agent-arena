import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_DATA_DIR, loadConfig } from '../src/config';

/** `<repo>/server` — the package root, one level up from both `src` and `test`. */
const serverDir = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const repoRoot = path.resolve(serverDir, '..');

const originalCwd = process.cwd();
const tempDirs: string[] = [];

afterEach(() => {
  process.chdir(originalCwd);
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('data directory', () => {
  it('sits at the repo root, one subdirectory per domain', () => {
    const { dataDir } = loadConfig({});

    expect(dataDir).toBe(path.join(repoRoot, 'data'));
    expect(dataDir).toBe(DEFAULT_DATA_DIR);
    // The old cwd-relative default landed in server/data when launched via
    // pnpm, which is how the same project ended up with two data directories.
    expect(dataDir.startsWith(serverDir + path.sep)).toBe(false);
  });

  it('does not follow the working directory', () => {
    const elsewhere = mkdtempSync(path.join(os.tmpdir(), 'arena-cwd-'));
    tempDirs.push(elsewhere);

    const before = loadConfig({}).dataDir;
    process.chdir(elsewhere);
    const after = loadConfig({}).dataDir;

    expect(after).toBe(before);
    expect(after).toBe(DEFAULT_DATA_DIR);
  });

  it('still lets ARENA_DATA_DIR win', () => {
    const override = path.join(os.tmpdir(), 'arena-explicit');
    expect(loadConfig({ ARENA_DATA_DIR: override }).dataDir).toBe(override);
    // Blank means "unset", not "root of the filesystem".
    expect(loadConfig({ ARENA_DATA_DIR: '   ' }).dataDir).toBe(DEFAULT_DATA_DIR);
  });
});
