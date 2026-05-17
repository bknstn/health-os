import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { repoRoot } from '../src/layout.js';

test('import-personal-file copies original uploads into the workspace raw folder by default', () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'health-os-personal-'));
  const sourceFile = path.join(workspace, 'lab-results.pdf');
  fs.writeFileSync(sourceFile, 'PDF bytes\n', 'utf8');

  const result = spawnSync(
    process.execPath,
    [path.join(repoRoot(), 'src/cli.js'), 'import-personal-file', '--workspace', workspace, '--file', sourceFile],
    { encoding: 'utf8' }
  );

  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.kind, 'raw');
  assert.equal(output.stored_file, path.join(workspace, '.health-os', 'personal', 'raw', 'lab-results.pdf'));
  assert.equal(fs.readFileSync(output.stored_file, 'utf8'), 'PDF bytes\n');
});

test('import-personal-file can copy processed Markdown into the processed files folder', () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'health-os-personal-'));
  const sourceFile = path.join(workspace, 'lab-results.md');
  fs.writeFileSync(sourceFile, '# Lab Results\n\nFerritin: 45\n', 'utf8');

  const result = spawnSync(
    process.execPath,
    [
      path.join(repoRoot(), 'src/cli.js'),
      'import-personal-file',
      '--workspace',
      workspace,
      '--file',
      sourceFile,
      '--kind',
      'processed'
    ],
    { encoding: 'utf8' }
  );

  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.kind, 'processed');
  assert.equal(output.stored_file, path.join(workspace, '.health-os', 'personal', 'files', 'lab-results.md'));
  assert.equal(fs.readFileSync(output.stored_file, 'utf8'), '# Lab Results\n\nFerritin: 45\n');
});

test('import-personal-file does not overwrite an existing raw upload by default', () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'health-os-personal-'));
  const sourceFile = path.join(workspace, 'lab-results.md');
  fs.writeFileSync(sourceFile, '# Lab Results\n', 'utf8');

  const args = [
    path.join(repoRoot(), 'src/cli.js'),
    'import-personal-file',
    '--workspace',
    workspace,
    '--file',
    sourceFile
  ];
  assert.equal(spawnSync(process.execPath, args, { encoding: 'utf8' }).status, 0);

  const second = spawnSync(process.execPath, args, { encoding: 'utf8' });
  assert.notEqual(second.status, 0);
  assert.match(second.stderr, /Personal file already exists/);
});
