import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { repoRoot } from '../src/layout.js';

const ROOT = repoRoot();
const FIXTURE = path.join(ROOT, 'tests/fixtures/profile-synthetic.md');

function createWorkspace(t) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'health-os-workspace-contract-'));
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  const workspace = path.join(scratch, 'workspace');
  fs.mkdirSync(workspace);
  return workspace;
}

function runCli(workspace, ...args) {
  return spawnSync(
    process.execPath,
    [path.join(ROOT, 'src/cli.js'), ...args, '--workspace', workspace],
    { cwd: ROOT, encoding: 'utf8' }
  );
}

function snapshotTree(root) {
  if (!fs.existsSync(root)) return null;
  const result = {};
  function visit(directory, prefix = '') {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const relative = path.posix.join(prefix, entry.name);
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute, relative);
      else if (entry.isFile()) result[relative] = fs.readFileSync(absolute);
      else result[relative] = `kind:${entry.isSymbolicLink() ? 'symlink' : 'other'}`;
    }
  }
  visit(root);
  return result;
}

function readJsonOutput(result) {
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('init creates an isolated versioned workspace with a valid neutral profile', (t) => {
  const workspace = createWorkspace(t);
  const initialized = runCli(workspace, 'init-workspace');
  assert.equal(initialized.status, 0, initialized.stderr);

  const manifestPath = path.join(workspace, '.health-os/manifest.json');
  const profilePath = path.join(workspace, '.health-os/personal/files/profile.md');
  assert.deepEqual(JSON.parse(fs.readFileSync(manifestPath, 'utf8')), {
    schema_version: 1,
    profile_path: 'personal/files/profile.md'
  });
  assert.match(fs.readFileSync(profilePath, 'utf8'), /updated: null/);
  assert.ok(fs.existsSync(path.join(workspace, '.health-os/config/training-plan.json')));
  assert.deepEqual(readJsonOutput(runCli(workspace, 'workspace-inspect')), {
    status: 'versioned',
    workspace,
    schema_version: 1,
    profile_path: 'personal/files/profile.md',
    profile_status: 'valid'
  });
  assert.deepEqual(readJsonOutput(runCli(workspace, 'profile-validate')).metadata, {
    schema_version: 1,
    updated: null
  });

  fs.appendFileSync(profilePath, `\n${'x'.repeat(80)}`, 'utf8');
  const shown = readJsonOutput(runCli(workspace, 'profile-show', '--max-chars', '32'));
  assert.equal(shown.markdown.length, 32);
  assert.equal(shown.truncated, true);
  assert.ok(shown.total_chars > shown.returned_chars);
});

test('init creates a workspace when its selected root does not exist yet', (t) => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'health-os-new-workspace-root-'));
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  const workspace = path.join(scratch, 'new', 'nested', 'workspace');
  const initialized = runCli(workspace, 'init-workspace');
  assert.equal(initialized.status, 0, initialized.stderr);
  assert.ok(fs.existsSync(path.join(workspace, '.health-os/manifest.json')));
  assert.ok(fs.existsSync(path.join(workspace, '.health-os/personal/files/profile.md')));
});

test('two workspaces keep profile and working-weight changes independent', (t) => {
  const firstWorkspace = createWorkspace(t);
  const secondWorkspace = createWorkspace(t);
  const firstInit = runCli(firstWorkspace, 'init-workspace', '--profile', 'personal/files/custom-card.md');
  const secondInit = runCli(secondWorkspace, 'init-workspace');
  assert.equal(firstInit.status, 0, firstInit.stderr);
  assert.equal(secondInit.status, 0, secondInit.stderr);
  fs.copyFileSync(FIXTURE, path.join(firstWorkspace, '.health-os/personal/files/custom-card.md'));
  const weightChange = runCli(
    firstWorkspace,
    'set-working-weight',
    '--exercise',
    'squat',
    '--weight',
    '82'
  );
  assert.equal(weightChange.status, 0, weightChange.stderr);

  const firstShown = readJsonOutput(runCli(
    firstWorkspace,
    'profile-show',
    '--profile',
    'personal/files/custom-card.md'
  ));
  const secondShown = readJsonOutput(runCli(secondWorkspace, 'profile-show'));
  assert.equal(firstShown.profile_path, 'personal/files/custom-card.md');
  assert.match(firstShown.markdown, /Synthetic profile fixture/);
  assert.doesNotMatch(secondShown.markdown, /Synthetic profile fixture/);
  const firstSettings = JSON.parse(fs.readFileSync(path.join(firstWorkspace, '.health-os/config/exercise-settings.json'), 'utf8'));
  const secondSettings = JSON.parse(fs.readFileSync(path.join(secondWorkspace, '.health-os/config/exercise-settings.json'), 'utf8'));
  assert.equal(firstSettings.exercises.squat.working_weight_kg, 82);
  assert.equal(secondSettings.exercises.squat.working_weight_kg, '');
});

test('reinitialization preserves config, selected card, original uploads, and wiki pages', (t) => {
  const workspace = createWorkspace(t);
  assert.equal(runCli(workspace, 'init-workspace').status, 0);
  const privateRoot = path.join(workspace, '.health-os');
  const customConfig = path.join(privateRoot, 'config/training-plan.json');
  const selectedProfile = path.join(privateRoot, 'personal/files/profile.md');
  const upload = path.join(privateRoot, 'personal/raw/original-lab.txt');
  const wiki = path.join(privateRoot, 'memory/wiki/synthetic-rule.md');
  fs.writeFileSync(customConfig, '{"custom":"preserve me"}\n');
  fs.writeFileSync(selectedProfile, fs.readFileSync(FIXTURE));
  fs.writeFileSync(upload, 'invented original upload bytes\n');
  fs.mkdirSync(path.dirname(wiki), { recursive: true });
  fs.writeFileSync(wiki, '# Synthetic wiki page\n\nNo real health data.\n');
  const expected = [customConfig, selectedProfile, upload, wiki].map((file) => fs.readFileSync(file));

  const reinitialized = runCli(workspace, 'init-workspace');
  assert.equal(reinitialized.status, 0, reinitialized.stderr);
  [customConfig, selectedProfile, upload, wiki].forEach((file, index) => {
    assert.deepEqual(fs.readFileSync(file), expected[index]);
  });
});

test('legacy report generation leaves the selected personal card unchanged', (t) => {
  const workspace = createWorkspace(t);
  assert.equal(runCli(workspace, 'init-workspace').status, 0);
  const profile = path.join(workspace, '.health-os/personal/files/profile.md');
  const original = fs.readFileSync(FIXTURE);
  fs.writeFileSync(profile, original);

  const today = runCli(workspace, 'today', '--date', '2026-10-23');
  assert.equal(today.status, 0, today.stderr);
  assert.deepEqual(fs.readFileSync(profile), original);
  assert.ok(fs.existsSync(path.join(workspace, '.health-os/artifacts/today.md')));
});

test('migration dry-run is read-only and explicit migration preserves a noncanonical card', (t) => {
  const workspace = createWorkspace(t);
  const privateRoot = path.join(workspace, '.health-os');
  const oldProfile = path.join(privateRoot, 'personal/files/owner-card.md');
  const original = fs.readFileSync(FIXTURE);
  fs.mkdirSync(path.dirname(oldProfile), { recursive: true });
  fs.writeFileSync(oldProfile, original);
  fs.mkdirSync(path.join(privateRoot, 'personal/raw'), { recursive: true });
  fs.writeFileSync(path.join(privateRoot, 'personal/raw/original.bin'), Buffer.from([0, 3, 255]));
  const before = snapshotTree(privateRoot);

  const inspection = readJsonOutput(runCli(workspace, 'workspace-inspect'));
  assert.equal(inspection.status, 'unversioned');
  const dryRun = readJsonOutput(runCli(
    workspace,
    'workspace-migrate',
    '--to',
    '1',
    '--dry-run',
    '--profile',
    'personal/files/owner-card.md'
  ));
  assert.equal(dryRun.profile_path, 'personal/files/owner-card.md');
  assert.equal(dryRun.template_would_be_created, false);
  assert.deepEqual(dryRun.writes, ['.health-os/manifest.json']);
  assert.deepEqual(snapshotTree(privateRoot), before);

  const migrated = readJsonOutput(runCli(
    workspace,
    'workspace-migrate',
    '--to',
    '1',
    '--profile',
    'personal/files/owner-card.md'
  ));
  assert.equal(migrated.template_created, false);
  assert.deepEqual(fs.readFileSync(oldProfile), original);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(privateRoot, 'manifest.json'), 'utf8')), {
    schema_version: 1,
    profile_path: 'personal/files/owner-card.md'
  });
  assert.equal(readJsonOutput(runCli(workspace, 'profile-validate')).ok, true);
});

test('migration dry-run reports a template but creates nothing when the selected card is absent', (t) => {
  const workspace = createWorkspace(t);
  const privateRoot = path.join(workspace, '.health-os');
  fs.mkdirSync(privateRoot);
  const before = snapshotTree(privateRoot);
  const dryRun = readJsonOutput(runCli(workspace, 'workspace-migrate', '--to', '1', '--dry-run'));
  assert.equal(dryRun.template_would_be_created, true);
  assert.deepEqual(dryRun.writes, [
    '.health-os/personal/files/profile.md',
    '.health-os/manifest.json'
  ]);
  assert.deepEqual(snapshotTree(privateRoot), before);

  const migrated = readJsonOutput(runCli(workspace, 'workspace-migrate', '--to', '1'));
  assert.equal(migrated.template_created, true);
  assert.equal(readJsonOutput(runCli(workspace, 'profile-validate')).ok, true);
});

test('invalid dry-run flag is rejected before any migration writes', (t) => {
  const workspace = createWorkspace(t);
  const privateRoot = path.join(workspace, '.health-os');
  fs.mkdirSync(privateRoot);
  const before = snapshotTree(privateRoot);
  const result = runCli(workspace, 'workspace-migrate', '--to', '1', '--dry-run', 'yes');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /accepts only true or false/);
  assert.deepEqual(snapshotTree(privateRoot), before);
});

test('invalid selected metadata and conflicting profile selection fail without writes', (t) => {
  const workspace = createWorkspace(t);
  assert.equal(runCli(workspace, 'init-workspace').status, 0);
  const privateRoot = path.join(workspace, '.health-os');
  const profile = path.join(privateRoot, 'personal/files/profile.md');
  fs.writeFileSync(profile, '---\nschema_version: 1\nupdated: 2026-02-30\n---\n# Invalid\n');
  const before = snapshotTree(privateRoot);

  const invalid = runCli(workspace, 'profile-validate');
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /real YYYY-MM-DD date/);
  const conflict = runCli(workspace, 'profile-show', '--profile', 'personal/files/another.md');
  assert.notEqual(conflict.status, 0);
  assert.match(conflict.stderr, /conflicts with manifest profile_path/);
  const reinit = runCli(workspace, 'init-workspace');
  assert.notEqual(reinit.status, 0);
  assert.match(reinit.stderr, /real YYYY-MM-DD date/);
  assert.deepEqual(snapshotTree(privateRoot), before);
});

test('invalid manifest is inspectable and init fails before creating seed files', (t) => {
  const workspace = createWorkspace(t);
  const privateRoot = path.join(workspace, '.health-os');
  fs.mkdirSync(privateRoot);
  fs.writeFileSync(path.join(privateRoot, 'manifest.json'), '{"schema_version":99,"profile_path":"personal/files/profile.md"}\n');

  const inspect = runCli(workspace, 'workspace-inspect');
  assert.notEqual(inspect.status, 0);
  assert.equal(JSON.parse(inspect.stdout).status, 'invalid');
  const init = runCli(workspace, 'init-workspace');
  assert.notEqual(init.status, 0);
  assert.match(init.stderr, /Unsupported workspace schema version/);
  assert.deepEqual(fs.readdirSync(privateRoot), ['manifest.json']);
});

test('unversioned init is refused, and failed migration leaves legacy bytes untouched', (t) => {
  const workspace = createWorkspace(t);
  const privateRoot = path.join(workspace, '.health-os');
  const profile = path.join(privateRoot, 'personal/files/profile.md');
  fs.mkdirSync(path.dirname(profile), { recursive: true });
  fs.writeFileSync(profile, '# Legacy card without metadata\n');
  fs.mkdirSync(path.join(privateRoot, 'personal/raw'), { recursive: true });
  fs.writeFileSync(path.join(privateRoot, 'personal/raw/upload.txt'), 'synthetic old upload\n');
  const before = snapshotTree(privateRoot);

  const init = runCli(workspace, 'init-workspace');
  assert.notEqual(init.status, 0);
  assert.match(init.stderr, /workspace-inspect.*workspace-migrate/);
  const dryRun = runCli(workspace, 'workspace-migrate', '--to', '1', '--dry-run');
  assert.notEqual(dryRun.status, 0);
  assert.match(dryRun.stderr, /expected YAML frontmatter/);
  const migrate = runCli(workspace, 'workspace-migrate', '--to', '1');
  assert.notEqual(migrate.status, 0);
  assert.deepEqual(snapshotTree(privateRoot), before);
});

test('missing selected profile is reported and reinit does not recreate it or seed files', (t) => {
  const workspace = createWorkspace(t);
  assert.equal(runCli(workspace, 'init-workspace').status, 0);
  const privateRoot = path.join(workspace, '.health-os');
  fs.rmSync(path.join(privateRoot, 'personal/files/profile.md'));
  fs.rmSync(path.join(privateRoot, 'config'), { recursive: true });

  const inspectResult = runCli(workspace, 'workspace-inspect');
  assert.equal(inspectResult.status, 1);
  const inspect = JSON.parse(inspectResult.stdout);
  assert.equal(inspect.status, 'invalid_profile_missing');
  const show = runCli(workspace, 'profile-show');
  assert.notEqual(show.status, 0);
  assert.match(show.stderr, /Selected profile is missing/);
  const init = runCli(workspace, 'init-workspace');
  assert.notEqual(init.status, 0);
  assert.equal(fs.existsSync(path.join(privateRoot, 'personal/files/profile.md')), false);
  assert.equal(fs.existsSync(path.join(privateRoot, 'config')), false);
});

test('profile paths cannot escape through traversal or a symlink to another workspace', (t) => {
  const workspace = createWorkspace(t);
  const privateRoot = path.join(workspace, '.health-os');
  fs.mkdirSync(privateRoot);
  const traversal = runCli(
    workspace,
    'workspace-migrate',
    '--to',
    '1',
    '--dry-run',
    '--profile',
    '../other/profile.md'
  );
  assert.notEqual(traversal.status, 0);
  assert.match(traversal.stderr, /workspace-relative|path segments/);

  const other = path.join(path.dirname(workspace), 'other-workspace-profile.md');
  fs.mkdirSync(path.join(privateRoot, 'personal/files'), { recursive: true });
  fs.writeFileSync(other, fs.readFileSync(FIXTURE));
  try {
    fs.symlinkSync(other, path.join(privateRoot, 'personal/files/external.md'));
  } catch (error) {
    if (error.code === 'EPERM' || error.code === 'EACCES') {
      t.skip('symlink creation is unavailable in this environment');
      return;
    }
    throw error;
  }
  const migration = runCli(
    workspace,
    'workspace-migrate',
    '--to',
    '1',
    '--dry-run',
    '--profile',
    'personal/files/external.md'
  );
  assert.notEqual(migration.status, 0);
  assert.match(migration.stderr, /outside the selected workspace/);
  assert.equal(fs.existsSync(path.join(privateRoot, 'manifest.json')), false);
});

test('generated artifact paths cannot be selected as a personal profile', (t) => {
  const workspace = createWorkspace(t);
  const init = runCli(workspace, 'init-workspace', '--profile', 'artifacts/today.md');
  assert.notEqual(init.status, 0);
  assert.match(init.stderr, /must be inside personal\/files/);
  assert.equal(fs.existsSync(path.join(workspace, '.health-os')), false);

  const today = runCli(workspace, 'today', '--date', '2026-10-23');
  assert.equal(today.status, 0, today.stderr);
  assert.ok(fs.existsSync(path.join(workspace, '.health-os/artifacts/today.md')));
});

test('a profile symlink into an engine-owned artifact is rejected before migration writes', (t) => {
  const workspace = createWorkspace(t);
  const privateRoot = path.join(workspace, '.health-os');
  const profileDir = path.join(privateRoot, 'personal/files');
  const artifact = path.join(privateRoot, 'artifacts/today.md');
  fs.mkdirSync(profileDir, { recursive: true });
  fs.mkdirSync(path.dirname(artifact), { recursive: true });
  fs.writeFileSync(artifact, 'synthetic artifact\n');
  fs.symlinkSync(artifact, path.join(profileDir, 'profile.md'));

  const migration = runCli(workspace, 'workspace-migrate', '--to', '1', '--dry-run');
  assert.notEqual(migration.status, 0);
  assert.match(migration.stderr, /resolves outside personal\/files/);
  assert.equal(fs.existsSync(path.join(privateRoot, 'manifest.json')), false);
  assert.equal(fs.readFileSync(artifact, 'utf8'), 'synthetic artifact\n');
});
