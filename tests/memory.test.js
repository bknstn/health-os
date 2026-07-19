import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { initialiseWorkspace } from '../src/engine.js';
import { buildPaths, ensureWorkspace, repoRoot } from '../src/layout.js';
import { lintMemory, memoryContext, updateMemory } from '../src/memory.js';

function makeWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'health-os-memory-'));
  const paths = buildPaths(root);
  ensureWorkspace(paths);
  initialiseWorkspace(paths, repoRoot());
  return paths;
}

function wikiPage(overrides = {}, body = '# Page\n') {
  const metadata = {
    title: 'Test page',
    status: 'observation',
    confidence: 'medium',
    evidence_start: '2026-07-01',
    evidence_end: '2026-07-07',
    last_reviewed: '2026-07-07',
    provenance: ['../evidence/weekly-2026-07-07.md'],
    human_confirmed: false,
    ...overrides
  };
  return [
    '---',
    `title: ${metadata.title}`,
    `status: ${metadata.status}`,
    `confidence: ${metadata.confidence}`,
    `evidence_start: ${metadata.evidence_start}`,
    `evidence_end: ${metadata.evidence_end}`,
    `last_reviewed: ${metadata.last_reviewed}`,
    `provenance: ${JSON.stringify(metadata.provenance)}`,
    `human_confirmed: ${metadata.human_confirmed}`,
    '---',
    '',
    body
  ].join('\n');
}

test('workspace initialization creates private memory layout and instructions', () => {
  const paths = makeWorkspace();

  assert.equal(fs.existsSync(paths.memoryEvidenceDir), true);
  assert.equal(fs.existsSync(paths.memoryWikiDir), true);
  assert.match(fs.readFileSync(paths.memorySchemaFile, 'utf8'), /human_confirmed: true/);
  assert.match(fs.readFileSync(paths.memoryIndexFile, 'utf8'), /Health OS Memory Index/);
  assert.match(fs.readFileSync(paths.memoryLogFile, 'utf8'), /Health OS Memory Log/);
});

test('memory update deterministically creates one evidence bundle and log entry', () => {
  const paths = makeWorkspace();
  const first = updateMemory(paths, '2026-07-07');
  const firstEvidence = fs.readFileSync(first.evidence_file, 'utf8');
  const firstIndex = fs.readFileSync(paths.memoryIndexFile, 'utf8');
  const firstLog = fs.readFileSync(paths.memoryLogFile, 'utf8');

  const second = updateMemory(paths, '2026-07-07');

  assert.deepEqual(second, first);
  assert.equal(fs.readFileSync(first.evidence_file, 'utf8'), firstEvidence);
  assert.equal(fs.readFileSync(paths.memoryIndexFile, 'utf8'), firstIndex);
  assert.equal(fs.readFileSync(paths.memoryLogFile, 'utf8'), firstLog);
  assert.equal((firstLog.match(/weekly evidence/g) || []).length, 1);
  assert.match(firstEvidence, /Deterministic review seed/);
  assert.match(firstEvidence, /evidence_start: 2026-07-01/);
  assert.equal(lintMemory(paths, { nowDate: '2026-07-07' }).ok, true);
});

test('memory update rejects calendar-invalid dates', () => {
  const paths = makeWorkspace();

  assert.throws(() => updateMemory(paths, '2026-02-30'), /YYYY-MM-DD/);
});

test('memory context ranks lexical matches and enforces its character bound', () => {
  const paths = makeWorkspace();
  updateMemory(paths, '2026-07-07');
  fs.writeFileSync(
    path.join(paths.memoryWikiDir, 'squat.md'),
    wikiPage({ title: 'Squat progression' }, '# Squat progression\n\nSquat load and squat technique trend.'),
    'utf8'
  );
  fs.writeFileSync(
    path.join(paths.memoryWikiDir, 'sleep.md'),
    wikiPage({ title: 'Sleep notes' }, '# Sleep notes\n\nSleep duration.'),
    'utf8'
  );

  const output = memoryContext(paths, 'squat progression', { maxChars: 2000, maxPages: 1 });

  assert.match(output, /Source: wiki\/squat.md/);
  assert.doesNotMatch(output, /Source: wiki\/sleep.md/);
  assert.ok(output.length <= 2000);
});

test('memory lint reports unsupported accepted rules, missing provenance, and broken links', () => {
  const paths = makeWorkspace();
  updateMemory(paths, '2026-07-07');
  fs.writeFileSync(
    path.join(paths.memoryWikiDir, 'bad-rule.md'),
    wikiPage(
      {
        title: 'Unconfirmed rule',
        status: 'accepted_rule',
        provenance: ['../evidence/missing.md'],
        human_confirmed: false
      },
      '# Unconfirmed rule\n\nSee [missing page](also-missing.md).'
    ),
    'utf8'
  );

  const result = lintMemory(paths, { nowDate: '2026-07-07' });
  const codes = result.findings.map((item) => item.code);

  assert.equal(result.ok, false);
  assert.ok(codes.includes('unconfirmed_accepted_rule'));
  assert.ok(codes.includes('missing_provenance'));
  assert.ok(codes.includes('broken_link'));
});

test('stale review is a warning while a confirmed supported rule passes', () => {
  const paths = makeWorkspace();
  updateMemory(paths, '2026-07-07');
  fs.writeFileSync(
    path.join(paths.memoryWikiDir, 'confirmed-rule.md'),
    wikiPage({ status: 'accepted_rule', human_confirmed: true, last_reviewed: '2026-07-07' }),
    'utf8'
  );

  const result = lintMemory(paths, { nowDate: '2027-01-01', staleDays: 90 });

  assert.equal(result.ok, true);
  assert.equal(result.errors, 0);
  assert.ok(result.warnings >= 1);
  assert.ok(result.findings.every((item) => item.severity === 'warning'));
});

test('memory-lint CLI prints JSON and exits nonzero on real errors', () => {
  const paths = makeWorkspace();
  fs.writeFileSync(path.join(paths.memoryWikiDir, 'invalid.md'), '# no metadata\n', 'utf8');

  const result = spawnSync(
    process.execPath,
    [path.join(repoRoot(), 'src', 'cli.js'), 'memory-lint', '--workspace', paths.groupRoot],
    { encoding: 'utf8' }
  );

  assert.equal(result.status, 1);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, false);
  assert.equal(payload.findings[0].code, 'missing_frontmatter');
});
