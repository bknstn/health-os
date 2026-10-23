import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

import { repoRoot } from '../src/layout.js';

const SOURCE_ROOT = repoRoot();
const PUBLIC_SOURCE_PATHS = ['package.json', 'package-lock.json', 'src', 'config', 'templates', 'examples'];
const AS_OF = '2026-10-23';

function copyPublicEntry(sourcePath, targetPath) {
  const stat = fs.lstatSync(sourcePath);
  if (stat.isSymbolicLink()) throw new Error(`Public source snapshot does not copy symlinks: ${sourcePath}`);
  if (stat.isDirectory()) {
    fs.mkdirSync(targetPath, { recursive: true, mode: stat.mode & 0o777 });
    for (const name of fs.readdirSync(sourcePath)) {
      copyPublicEntry(path.join(sourcePath, name), path.join(targetPath, name));
    }
    fs.chmodSync(targetPath, stat.mode & 0o777);
    return;
  }
  if (!stat.isFile()) throw new Error(`Public source snapshot contains an unsupported entry: ${sourcePath}`);
  fs.mkdirSync(path.dirname(targetPath), { recursive: true, mode: 0o700 });
  fs.copyFileSync(sourcePath, targetPath);
  fs.chmodSync(targetPath, stat.mode & 0o777);
}

function copyPublicSource(snapshotRoot) {
  fs.mkdirSync(snapshotRoot, { recursive: true, mode: 0o700 });
  for (const entry of PUBLIC_SOURCE_PATHS) {
    const sourcePath = path.join(SOURCE_ROOT, entry);
    assert.ok(fs.existsSync(sourcePath), `expected public source path ${entry}`);
    copyPublicEntry(sourcePath, path.join(snapshotRoot, entry));
  }
}

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function fileHashes(root) {
  const result = {};
  const visit = (directory, prefix = '') => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const relative = path.posix.join(prefix, entry.name);
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute, relative);
      else if (entry.isFile()) result[relative] = digest(fs.readFileSync(absolute));
      else throw new Error(`Unexpected non-regular legacy fixture entry ${relative}`);
    }
  };
  visit(root);
  return result;
}

function assertPreservedFiles(root, expectedHashes) {
  for (const [relative, expectedHash] of Object.entries(expectedHashes)) {
    const target = path.join(root, ...relative.split('/'));
    assert.ok(fs.existsSync(target), `preserved file missing: ${relative}`);
    assert.equal(digest(fs.readFileSync(target)), expectedHash, `preserved file changed: ${relative}`);
  }
}

function makeEnvironment(scratchRoot) {
  const temp = path.join(scratchRoot, 'isolated tmp');
  const cache = path.join(scratchRoot, 'npm cache');
  const npmPath = (process.env.PATH || '').split(path.delimiter)
    .map((directory) => path.join(directory, 'npm'))
    .find((candidate) => {
      try { return fs.statSync(candidate).isFile() && (fs.statSync(candidate).mode & 0o111) !== 0; }
      catch { return false; }
    });
  if (!npmPath) throw new Error('npm is required for the isolated source snapshot check');
  fs.mkdirSync(temp, { recursive: true, mode: 0o700 });
  fs.mkdirSync(cache, { recursive: true, mode: 0o700 });
  const executableDirs = [...new Set([path.dirname(process.execPath), path.dirname(npmPath), '/usr/bin'])];
  return {
    TMPDIR: temp,
    TZ: 'UTC',
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    PATH: executableDirs.join(path.delimiter),
    npm_config_cache: cache,
    npm_config_userconfig: path.join(scratchRoot, 'isolated-npmrc'),
    npm_config_globalconfig: path.join(scratchRoot, 'isolated-global-npmrc'),
    npm_config_audit: 'false',
    npm_config_fund: 'false'
  };
}

function runNode(snapshotRoot, args, { env, input, cwd = snapshotRoot } = {}) {
  return spawnSync(process.execPath, args, {
    cwd,
    encoding: 'utf8',
    env,
    input,
    timeout: 30_000,
    maxBuffer: 2 * 1024 * 1024
  });
}

function runCli(snapshotRoot, env, args, { workspace, input } = {}) {
  const cliArgs = [path.join(snapshotRoot, 'src/cli.js'), ...args];
  if (workspace) cliArgs.push('--workspace', workspace);
  return runNode(snapshotRoot, cliArgs, { env, input });
}

function commandJson(result, label) {
  assert.equal(result.status, 0, `${label} failed: ${result.stderr || result.stdout}`);
  return JSON.parse(result.stdout);
}

function makeCsvRow(headers, fields) {
  return Object.fromEntries(headers.map((header) => [header, fields[header] ?? '']));
}

test('clean source compatibility snapshot supports fresh and legacy workspaces, bounded contracts, and fixture connectors', async (t) => {
  const scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'health-os-compatibility-'));
  t.after(() => {
    fs.rmSync(scratchRoot, { recursive: true, force: true });
    assert.equal(fs.existsSync(scratchRoot), false, 'compatibility-check workspace was not cleaned up');
  });
  const env = makeEnvironment(scratchRoot);
  const snapshotRoot = path.join(scratchRoot, 'clean source snapshot with spaces');
  const workspacesRoot = path.join(scratchRoot, 'external workspaces');
  fs.mkdirSync(workspacesRoot, { recursive: true, mode: 0o700 });
  copyPublicSource(snapshotRoot);

  const fixtureSource = path.join(snapshotRoot, 'src/fixture-connector.js');
  copyPublicEntry(
    path.join(SOURCE_ROOT, 'examples/connectors/synthetic-fixture-connector.mjs'),
    fixtureSource
  );
  const connectorRegistryPath = path.join(snapshotRoot, 'src/health-data-connectors.js');
  let connectorRegistry = fs.readFileSync(connectorRegistryPath, 'utf8');
  const ouraImport = "import { ouraConnector } from './oura-connector.js';";
  assert.ok(connectorRegistry.includes(ouraImport), 'connector registry import anchor changed');
  connectorRegistry = connectorRegistry.replace(
    ouraImport,
    `${ouraImport}\nimport { fixtureConnector } from './fixture-connector.js';`
  );
  const ouraRegistration = 'registerHealthDataConnector(ouraConnector);';
  assert.ok(connectorRegistry.includes(ouraRegistration), 'connector registry registration anchor changed');
  connectorRegistry = connectorRegistry.replace(
    ouraRegistration,
    `${ouraRegistration}\nregisterHealthDataConnector(fixtureConnector);`
  );
  fs.writeFileSync(connectorRegistryPath, connectorRegistry);

  assert.equal(fs.existsSync(path.join(snapshotRoot, '.git')), false);
  assert.equal(fs.existsSync(path.join(snapshotRoot, '.health-os')), false);
  assert.equal(fs.existsSync(path.join(snapshotRoot, 'node_modules')), false);
  const wrapperSource = path.join(SOURCE_ROOT, 'src/scripts/today.sh');
  const wrapperCopy = path.join(snapshotRoot, 'src/scripts/today.sh');
  assert.equal(fs.statSync(wrapperCopy).mode & 0o777, fs.statSync(wrapperSource).mode & 0o777);

  const npmCi = spawnSync('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund', '--offline'], {
    cwd: snapshotRoot, encoding: 'utf8', env, timeout: 30_000, maxBuffer: 2 * 1024 * 1024
  });
  assert.equal(npmCi.status, 0, `isolated npm ci failed: ${npmCi.stderr || npmCi.stdout}`);

  const version = commandJson(runCli(snapshotRoot, env, ['version', '--json']), 'version');
  assert.equal(version.data.name, 'health-os');
  const capabilities = commandJson(runCli(snapshotRoot, env, ['capabilities', '--json']), 'capabilities');
  assert.equal(capabilities.data.cli_json_schema_version, 1);
  assert.deepEqual(capabilities.data.workspace_schema_versions, [1]);
  assert.deepEqual(capabilities.data.wearable_observation_schema_versions, [1]);
  assert.ok(capabilities.data.contracts.json_stdin_commands.includes('validate-wearable-observations'));
  assert.ok(capabilities.data.contracts.read_only_preparation_commands.includes('prepare-training'));
  const registeredConnectors = commandJson(runCli(snapshotRoot, env, ['connectors', '--json']), 'registered connectors');
  const fixtureDeclaration = registeredConnectors.data.find(({ id }) => id === 'synthetic-fixture');
  assert.ok(fixtureDeclaration, 'registered fixture connector is missing from the stock CLI registry');
  assert.deepEqual(fixtureDeclaration.observationSchemaVersions, [1]);
  assert.deepEqual(fixtureDeclaration.physicalMetrics, ['hrv', 'resting_hr']);
  assert.deepEqual(fixtureDeclaration.proprietaryScores, []);

  const freshWorkspace = path.join(workspacesRoot, 'fresh workspace with spaces');
  const customProfilePath = 'personal/files/owner-card.md';
  const initialized = commandJson(runCli(snapshotRoot, env, [
    'init-workspace', '--json', '--profile', customProfilePath
  ], { workspace: freshWorkspace }), 'fresh workspace initialization');
  assert.equal(initialized.data.profile_path, customProfilePath);
  const freshProfileFile = path.join(freshWorkspace, '.health-os', customProfilePath);
  let profile = fs.readFileSync(freshProfileFile, 'utf8');
  profile = profile.replace('## Goals', '## Goals\n\nSynthetic goal: preserve this personalized card.');
  fs.writeFileSync(freshProfileFile, profile);
  const policyFile = path.join(freshWorkspace, '.health-os/config/preparation-policy.json');
  const policy = JSON.parse(fs.readFileSync(policyFile, 'utf8'));
  policy.session_selection.weekday_day_types.friday = 'B';
  fs.writeFileSync(policyFile, `${JSON.stringify(policy, null, 2)}\n`);
  const personalizedProfileHash = digest(fs.readFileSync(freshProfileFile));
  const personalizedPolicyHash = digest(fs.readFileSync(policyFile));
  commandJson(runCli(snapshotRoot, env, ['init-workspace', '--json'], { workspace: freshWorkspace }), 'fresh workspace reinitialization');
  assert.equal(digest(fs.readFileSync(freshProfileFile)), personalizedProfileHash);
  assert.equal(digest(fs.readFileSync(policyFile)), personalizedPolicyHash);
  const profileView = commandJson(runCli(snapshotRoot, env, ['profile-show', '--json'], { workspace: freshWorkspace }), 'custom profile view');
  assert.equal(profileView.data.profile_path, customProfilePath);
  assert.match(profileView.data.markdown, /Synthetic goal: preserve this personalized card/);
  const profileValidation = commandJson(runCli(snapshotRoot, env, ['profile-validate', '--json'], { workspace: freshWorkspace }), 'custom profile validation');
  assert.equal(profileValidation.data.ok, true);
  const preparation = commandJson(runCli(snapshotRoot, env, [
    'prepare-training', '--as-of', AS_OF, '--json'
  ], { workspace: freshWorkspace }), 'fresh workspace preparation');
  assert.equal(preparation.command, 'prepare-training');
  assert.equal(preparation.data.session_selection.selected_day_type, 'B');

  const genericCaller = runNode(snapshotRoot, [
    path.join(snapshotRoot, 'examples/generic-agent-caller.mjs'), freshWorkspace,
    '--as-of', AS_OF, '--session', 'A'
  ], { env });
  assert.equal(genericCaller.status, 0, `generic subprocess caller failed: ${genericCaller.stderr || genericCaller.stdout}`);
  const genericResult = JSON.parse(genericCaller.stdout);
  assert.equal(genericResult.as_of, AS_OF);
  assert.equal(genericResult.selected_day_type, 'A');
  assert.equal(typeof genericResult.recovery_status, 'string');

  const connectorSync = commandJson(runCli(snapshotRoot, env, [
    'sync-daily-source', '--source', 'synthetic-fixture', '--date', AS_OF,
    '--idempotency-key', 'synthetic-fixture-cli-sync', '--json'
  ], { workspace: freshWorkspace }), 'registered fixture connector sync');
  assert.equal(connectorSync.data.connector, 'synthetic-fixture');
  assert.equal(connectorSync.data.decision_available, false);
  assert.equal(connectorSync.data.mode, 'UNAVAILABLE');
  assert.deepEqual(connectorSync.data.observation_set.proprietary_scores, []);
  assert.deepEqual(
    connectorSync.data.observation_set.physical_metrics.map(({ metric, status }) => ({ metric, status })),
    [{ metric: 'hrv', status: 'observed' }, { metric: 'resting_hr', status: 'observed' }]
  );
  const observationStore = JSON.parse(fs.readFileSync(
    path.join(freshWorkspace, '.health-os/data/wearable-observations.json'), 'utf8'
  ));
  assert.ok(observationStore.observations.some(({ source, date }) =>
    source.id === 'synthetic-fixture' && date === AS_OF
  ));

  const callerCwd = path.join(scratchRoot, 'generic caller cwd with spaces');
  fs.mkdirSync(callerCwd, { recursive: true, mode: 0o700 });
  const wrapper = spawnSync(path.join(snapshotRoot, 'src/scripts/today.sh'), ['--date', AS_OF], {
    cwd: callerCwd,
    encoding: 'utf8',
    env: { ...env, HEALTH_OS_WORKSPACE: freshWorkspace },
    timeout: 30_000,
    maxBuffer: 2 * 1024 * 1024
  });
  assert.equal(wrapper.status, 0, `shell wrapper failed from external cwd: ${wrapper.stderr || wrapper.stdout}`);
  assert.match(wrapper.stdout, /Today/);

  const { CSV_HEADERS } = await import(pathToFileURL(path.join(snapshotRoot, 'src/engine.js')).href);
  const { writeCsv } = await import(pathToFileURL(path.join(snapshotRoot, 'src/csv.js')).href);
  const legacyWorkspace = path.join(workspacesRoot, 'older synthetic workspace');
  const privateRoot = path.join(legacyWorkspace, '.health-os');
  const legacyProfilePath = 'personal/files/coached-card.md';
  const legacyDirs = [
    'config', 'data', 'personal/files', 'personal/raw', 'memory/wiki', 'memory/evidence'
  ];
  for (const directory of legacyDirs) fs.mkdirSync(path.join(privateRoot, directory), { recursive: true, mode: 0o700 });
  let legacyProfile = fs.readFileSync(path.join(snapshotRoot, 'templates/personal-profile.md'), 'utf8');
  legacyProfile = legacyProfile.replace('# Personal health profile', '# Synthetic legacy profile')
    .replace('## Goals', '## Goals\n\nSynthetic goal from an older workspace.');
  const legacyProfileFile = path.join(privateRoot, legacyProfilePath);
  fs.writeFileSync(legacyProfileFile, legacyProfile);

  const trainingPlan = JSON.parse(fs.readFileSync(path.join(snapshotRoot, 'config/training-plan.json'), 'utf8'));
  trainingPlan.days.A[0].notes = 'Legacy synthetic owner customization';
  const trainingPlanFile = path.join(privateRoot, 'config/training-plan.json');
  fs.writeFileSync(trainingPlanFile, `${JSON.stringify(trainingPlan, null, 2)}\n`);
  const settings = JSON.parse(fs.readFileSync(path.join(snapshotRoot, 'config/exercise-settings.json'), 'utf8'));
  settings.exercises.squat.working_weight_kg = 77.5;
  const settingsFile = path.join(privateRoot, 'config/exercise-settings.json');
  fs.writeFileSync(settingsFile, `${JSON.stringify(settings, null, 2)}\n`);

  writeCsv(path.join(privateRoot, 'data/workout_sessions.csv'), CSV_HEADERS.workoutSessions, [makeCsvRow(CSV_HEADERS.workoutSessions, {
    session_id: 'legacy-session-2026-10-22', date: '2026-10-22', day_type: 'A', recommended_mode: 'BASE',
    actual_mode: 'BASE', duration_minutes: '45', session_rpe: '6', energy_pre: '4', soreness_pre: '2',
    completed_flag: 'true', notes: 'synthetic old session'
  })]);
  writeCsv(path.join(privateRoot, 'data/exercise_logs.csv'), CSV_HEADERS.exerciseLogs, [makeCsvRow(CSV_HEADERS.exerciseLogs, {
    session_id: 'legacy-session-2026-10-22', session_date: '2026-10-22', day_type: 'A', exercise_key: 'squat',
    exercise_name: 'Squat', set_count: '3', reps: '5|5|5', weight: '70', top_set_weight: '70',
    top_set_reps: '5', estimated_1rm: '81.67', completed_as_planned: 'true', actual_mode: 'BASE',
    session_rpe: '6', notes: 'synthetic legacy load'
  })]);
  writeCsv(path.join(privateRoot, 'data/recovery_snapshots.csv'), CSV_HEADERS.recoverySnapshots, [
    makeCsvRow(CSV_HEADERS.recoverySnapshots, { date: '2026-10-21', metric_name: 'hrv', metric_value: '49', unit: 'ms', source_sync_time: '2026-10-21T06:00:00Z' }),
    makeCsvRow(CSV_HEADERS.recoverySnapshots, { date: '2026-10-21', metric_name: 'resting_hr', metric_value: '56', unit: 'bpm', source_sync_time: '2026-10-21T06:00:00Z' })
  ]);
  writeCsv(path.join(privateRoot, 'data/daily_state.csv'), CSV_HEADERS.dailyState, [makeCsvRow(CSV_HEADERS.dailyState, {
    date: '2026-10-22', readiness_score: '80', sleep_score: '78', hrv: '49', hrv_baseline_28d: '49',
    hrv_delta_pct: '0', resting_hr: '56', resting_hr_baseline_28d: '56', resting_hr_delta: '0',
    sleep_efficiency: '0.9', total_sleep_minutes: '420', temperature_deviation: '0', recommended_mode: 'BASE',
    recommendation_reason: 'synthetic legacy state', source_sync_time: '2026-10-22T06:00:00Z'
  })]);

  const preservedFiles = {
    'personal/raw/original-wearable-export.csv': 'date,metric\n2026-10-22,synthetic\n',
    'personal/files/processed-recovery-note.md': '# Synthetic processed recovery note\n',
    'memory/wiki/reviewed-training.md': '---\ntitle: Synthetic reviewed training note\nstatus: observation\nconfidence: medium\nevidence_start: 2026-10-22\nevidence_end: 2026-10-22\nlast_reviewed: 2026-10-23\nprovenance: []\nhuman_confirmed: true\n---\n\nSynthetic reviewed wiki content for training.\n',
    'memory/evidence/reviewed-source.md': '---\ntitle: Synthetic legacy source evidence\nstatus: observation\nconfidence: medium\nevidence_start: 2026-10-21\nevidence_end: 2026-10-22\nlast_reviewed: 2026-10-23\nprovenance: []\nhuman_confirmed: true\n---\n\nSynthetic evidence excerpt for training.\n'
  };
  for (const [relative, contents] of Object.entries(preservedFiles)) {
    fs.writeFileSync(path.join(privateRoot, ...relative.split('/')), contents);
  }
  const legacyFilesBefore = fileHashes(privateRoot);
  const inspect = commandJson(runCli(snapshotRoot, env, ['workspace-inspect', '--json'], { workspace: legacyWorkspace }), 'legacy workspace inspection');
  assert.equal(inspect.data.status, 'unversioned');
  const dryRun = commandJson(runCli(snapshotRoot, env, [
    'workspace-migrate', '--to', '1', '--dry-run', '--profile', legacyProfilePath, '--json'
  ], { workspace: legacyWorkspace }), 'legacy migration dry-run');
  assert.equal(dryRun.data.template_would_be_created, false);
  assert.deepEqual(fileHashes(privateRoot), legacyFilesBefore);
  assert.equal(fs.existsSync(path.join(privateRoot, 'manifest.json')), false);

  const migrated = commandJson(runCli(snapshotRoot, env, [
    'workspace-migrate', '--to', '1', '--profile', legacyProfilePath, '--json'
  ], { workspace: legacyWorkspace }), 'legacy workspace migration');
  assert.equal(migrated.data.profile_path, legacyProfilePath);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(privateRoot, 'manifest.json'), 'utf8')), {
    schema_version: 1, profile_path: legacyProfilePath
  });
  assertPreservedFiles(privateRoot, legacyFilesBefore);

  commandJson(runCli(snapshotRoot, env, ['init-workspace', '--json'], { workspace: legacyWorkspace }), 'legacy workspace reinitialization');
  assertPreservedFiles(privateRoot, legacyFilesBefore);
  const migratedProfile = commandJson(runCli(snapshotRoot, env, ['profile-show', '--json'], { workspace: legacyWorkspace }), 'migrated profile view');
  assert.equal(migratedProfile.data.profile_path, legacyProfilePath);
  assert.match(migratedProfile.data.markdown, /Synthetic goal from an older workspace/);
  const next = commandJson(runCli(snapshotRoot, env, ['next', '--date', AS_OF, '--json'], { workspace: legacyWorkspace }), 'legacy next compatibility');
  assert.equal(next.data.dayType, 'B');
  const today = commandJson(runCli(snapshotRoot, env, ['today', '--date', AS_OF, '--json'], { workspace: legacyWorkspace }), 'legacy today compatibility');
  assert.match(today.data.text, /Today/);
  assertPreservedFiles(privateRoot, legacyFilesBefore);
  const legacyPreparation = commandJson(runCli(snapshotRoot, env, [
    'prepare-training', '--as-of', AS_OF, '--session', 'A', '--json'
  ], { workspace: legacyWorkspace }), 'migrated legacy workspace preparation');
  assert.equal(legacyPreparation.data.profile.status, 'available');
  assert.equal(legacyPreparation.data.workout.scheduled_only, true);
  assert.ok(legacyPreparation.data.workout.history.some((item) => item.session_id === 'legacy-session-2026-10-22'));
  assert.equal(legacyPreparation.data.workout.exercises.find((item) => item.exercise_key === 'squat').notes,
    'Legacy synthetic owner customization');
  assert.ok(legacyPreparation.data.gaps.some((gap) => gap.code === 'recovery_baseline_insufficient'));
  assertPreservedFiles(privateRoot, legacyFilesBefore);

  const fixtureExampleSnapshot = path.join(scratchRoot, 'fixture example source with spaces');
  copyPublicSource(fixtureExampleSnapshot);
  const tempBeforeFixture = fs.readdirSync(env.TMPDIR);
  const fixtureConnector = runNode(fixtureExampleSnapshot, [
    path.join(fixtureExampleSnapshot, 'examples/connectors/fixture-connector.mjs')
  ], { env });
  assert.equal(fixtureConnector.status, 0, `fixture connector example failed: ${fixtureConnector.stderr || fixtureConnector.stdout}`);
  const fixtureResult = JSON.parse(fixtureConnector.stdout);
  assert.equal(fixtureResult.connector, 'synthetic-fixture');
  assert.equal(fixtureResult.mode, 'UNAVAILABLE');
  assert.equal(fixtureResult.decision_available, false);
  assert.deepEqual(fixtureResult.proprietary_scores, []);

  const fixtureExampleAlias = path.join(scratchRoot, 'fixture example alias with spaces');
  fs.symlinkSync(fixtureExampleSnapshot, fixtureExampleAlias, 'dir');
  const aliasedFixtureConnector = runNode(fixtureExampleSnapshot, [
    path.join(fixtureExampleAlias, 'examples/connectors/fixture-connector.mjs')
  ], { env });
  assert.equal(aliasedFixtureConnector.status, 0,
    `fixture connector failed through a directory alias: ${aliasedFixtureConnector.stderr || aliasedFixtureConnector.stdout}`);
  const aliasedFixtureResult = JSON.parse(aliasedFixtureConnector.stdout);
  assert.equal(aliasedFixtureResult.connector, fixtureResult.connector);
  assert.equal(aliasedFixtureResult.decision_available, false);
  assert.deepEqual(fs.readdirSync(env.TMPDIR), tempBeforeFixture, 'fixture connector left its temporary workspace behind');
});
