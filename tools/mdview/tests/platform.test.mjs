import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CMD_FALLBACK, POWERSHELL_FALLBACK, cmdExe, codeCli, findOnPath, powershellExe } from '../lib/platform.mjs';

function fakeBin(names) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdview-platform-'));
  for (const name of names) fs.writeFileSync(path.join(dir, name), '#!/bin/sh\n', { mode: 0o755 });
  return dir;
}

test('findOnPath returns the first executable on PATH and empty string otherwise', () => {
  const dir = fakeBin(['code']);
  try {
    assert.equal(findOnPath('code', { PATH: `/nonexistent${path.delimiter}${dir}` }), path.join(dir, 'code'));
    assert.equal(findOnPath('code', { PATH: '/nonexistent' }), '');
    assert.equal(findOnPath('code', {}), '');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('powershellExe / cmdExe prefer PATH and fall back to the WSL absolute paths', () => {
  const dir = fakeBin(['powershell.exe', 'cmd.exe']);
  try {
    assert.equal(powershellExe({ PATH: dir }), path.join(dir, 'powershell.exe'));
    assert.equal(cmdExe({ PATH: dir }), path.join(dir, 'cmd.exe'));
    assert.equal(powershellExe({ PATH: '/nonexistent' }), POWERSHELL_FALLBACK);
    assert.equal(cmdExe({ PATH: '/nonexistent' }), CMD_FALLBACK);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('codeCli honours MDVIEW_CODE_CLI, then PATH, else empty', () => {
  const dir = fakeBin(['code']);
  try {
    assert.equal(codeCli({ MDVIEW_CODE_CLI: '/opt/code', PATH: dir }), '/opt/code');
    assert.equal(codeCli({ PATH: dir }), path.join(dir, 'code'));
    assert.equal(codeCli({ PATH: '/nonexistent' }), '');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
