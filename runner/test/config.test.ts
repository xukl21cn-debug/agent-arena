import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { loadRunnerConfig } from '../src/config.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'arena-runner-config-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

it('loads a config file and resolves workspace relative to it', () => {
  writeFileSync(path.join(dir, 'runner.config.json'), JSON.stringify({
    name: 'runner-test',
    workspace: '.',
    dsh: { command: 'dsh', permissionMode: 'workspace-write', approvalPolicy: 'never' },
  }));
  const config = loadRunnerConfig('runner.config.json', dir);
  expect(config).toMatchObject({
    name: 'runner-test',
    workspace: dir,
    serverUrl: 'http://127.0.0.1:3000',
    dsh: {
      command: process.platform === 'win32' ? 'dsh.cmd' : 'dsh',
      profile: 'headless',
      permissionMode: 'workspace-write',
      approvalPolicy: 'never',
    },
  });
});

it('uses safe unattended defaults when no file is present', () => {
  const config = loadRunnerConfig(undefined, dir);
  expect(config).toMatchObject({
    name: 'runner-dsh',
    workspace: dir,
    dsh: { profile: 'headless', permissionMode: 'workspace-write', approvalPolicy: 'never' },
  });
});

it('rejects an explicitly named missing config', () => {
  expect(() => loadRunnerConfig('missing.json', dir)).toThrow(/not found/u);
});

it('rejects a non-existent extra writable directory', () => {
  writeFileSync(path.join(dir, 'runner.config.json'), JSON.stringify({
    workspace: '.',
    dsh: { extraDirs: ['missing-dir'] },
  }));
  expect(() => loadRunnerConfig('runner.config.json', dir)).toThrow(/extraDirs/u);
});
