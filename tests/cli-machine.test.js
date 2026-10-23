import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  beginIdempotentRequest,
  boundedJsonValue,
  CLI_JSON_SCHEMA_VERSION,
  makeSuccessEnvelope,
  MAX_JSON_OUTPUT_BYTES
} from '../src/cli-contract.js';
import { buildPaths, repoRoot } from '../src/layout.js';

const CLI = path.join(repoRoot(), 'src/cli.js');

function scratch(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'health-os-cli-contract-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function run(args, options = {}) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd: repoRoot(), encoding: 'utf8', ...options });
}

function readEnvelope(result) {
  assert.doesNotMatch(result.stderr, /./, `expected empty stderr, got ${result.stderr}`);
  return JSON.parse(result.stdout);
}

const recoveryPayload = {
  date: '2026-10-23',
  readiness_score: 80,
  sleep_score: 78,
  hrv: 50,
  hrv_baseline_28d: 45,
  resting_hr: 55,
  resting_hr_baseline_28d: 58,
  sleep_efficiency: 0.9,
  total_sleep_minutes: 420,
  temperature_deviation: 0,
  source_sync_time: '2026-10-23T06:00:00Z',
  raw_metrics: { readiness_score: 80, sleep_score: 78, hrv: 50, resting_hr: 55 }
};

const wearableObservationPayload = {
  schema_version: 1,
  date: '2026-10-23',
  source: { id: 'synthetic-sensor', label: 'Synthetic Sensor', reference: 'sample-1' },
  freshness: { status: 'unknown', observed_at: null, evaluated_at: null, max_age_seconds: null },
  physical_metrics: [{
    metric: 'hrv', status: 'observed', value: 49, unit: 'ms',
    observed_at: '2026-10-23T06:00:00Z', observed_date: null, source_ref: 'sample-1',
    baseline: {
      status: 'unavailable', value: null, observed_days: 0, window_days: 28,
      scope: 'source', source_id: 'synthetic-sensor'
    }
  }],
  proprietary_scores: []
};

const workoutPayload = {
  session: {
    day: 'A', actual_mode: 'BASE', duration_minutes: 45, session_rpe: 7,
    energy_pre: 7, soreness_pre: 2, notes: 'Synthetic test session'
  },
  exercises: [{ exercise_key: 'squat', sets: [{ weight: 60, reps: 5 }, { weight: 60, reps: 5 }] }]
};

test('version, capabilities, and JSON reads do not initialize a workspace', (t) => {
  const root = scratch(t);
  const workspace = path.join(root, 'missing', 'workspace');
  const version = readEnvelope(run(['version', '--json', '--workspace', workspace]));
  assert.equal(version.schema_version, CLI_JSON_SCHEMA_VERSION);
  assert.equal(version.command, 'version');
  assert.equal(version.data.version, '0.1.0');
  const capabilities = readEnvelope(run(['capabilities', '--json']));
  assert.ok(capabilities.data.contracts.idempotency_commands.includes('log-workout'));
  assert.ok(capabilities.data.contracts.json_stdin_commands.includes('ingest-daily-state'));
  assert.ok(capabilities.data.contracts.json_stdin_commands.includes('validate-wearable-observations'));
  assert.ok(capabilities.data.contracts.workspace_lock_commands.includes('ingest-wearable-observations'));
  assert.deepEqual(capabilities.data.health_event_schema_versions, [1]);
  assert.ok(capabilities.data.contracts.event_store_idempotency_commands.includes('context-add'));
  const invalid = run(['profile-validate', '--json', '--workspace', workspace]);
  const error = readEnvelope(invalid);
  assert.equal(invalid.status, 1);
  assert.equal(error.ok, false);
  assert.equal(fs.existsSync(workspace), false);
});

test('JSON stdin accepts normalized recovery data and distinguishes command payloads', (t) => {
  const root = scratch(t);
  const workspace = path.join(root, 'workspace');
  const ingest = run(['ingest-daily-state', '--json', '--input-json', '--workspace', workspace], {
    input: JSON.stringify(recoveryPayload)
  });
  const envelope = readEnvelope(ingest);
  assert.equal(ingest.status, 0, ingest.stdout);
  assert.equal(envelope.command, 'ingest-daily-state');
  assert.equal(envelope.data.date, recoveryPayload.date);
  assert.ok(['FULL', 'BASE', 'LIGHT'].includes(envelope.data.mode));

  const invalidShape = run(['ingest-daily-state', '--json', '--input-json', '--workspace', path.join(root, 'other')], {
    input: JSON.stringify({ command: 'ingest-daily-state', options: recoveryPayload })
  });
  const invalidEnvelope = readEnvelope(invalidShape);
  assert.equal(invalidShape.status, 1);
  assert.equal(invalidEnvelope.ok, false);
  assert.equal(fs.existsSync(path.join(root, 'other')), false);
});

test('observation validation is read-only and observation ingestion is locked, stored, and idempotent', (t) => {
  const root = scratch(t);
  const uncreated = path.join(root, 'uncreated');
  const invalidPayload = structuredClone(wearableObservationPayload);
  invalidPayload.date = '2026-02-30';
  const invalid = run(['validate-wearable-observations', '--json', '--input-json', '--workspace', uncreated], {
    input: JSON.stringify(invalidPayload)
  });
  assert.equal(invalid.status, 1);
  assert.equal(readEnvelope(invalid).ok, false);
  assert.equal(fs.existsSync(uncreated), false);

  const workspace = path.join(root, 'workspace');
  const args = [
    'ingest-wearable-observations', '--json', '--input-json', '--workspace', workspace,
    '--idempotency-key', 'observation-1'
  ];
  const first = run(args, { input: JSON.stringify(wearableObservationPayload) });
  const firstEnvelope = readEnvelope(first);
  assert.equal(first.status, 0, first.stdout);
  assert.equal(firstEnvelope.idempotency.status, 'completed');
  assert.equal(firstEnvelope.data.observation.proprietary_scores.length, 0);

  const replay = run(args, { input: JSON.stringify(wearableObservationPayload) });
  assert.equal(replay.status, 0, replay.stdout);
  assert.equal(readEnvelope(replay).idempotency.status, 'replayed');

  const query = run(['wearable-observations', '--json', '--workspace', workspace, '--source', 'synthetic-sensor']);
  const queryEnvelope = readEnvelope(query);
  assert.equal(query.status, 0, query.stdout);
  assert.equal(queryEnvelope.data.matched_count, 1);
  assert.equal(queryEnvelope.data.observations[0].physical_metrics[0].value, 49);
});

test('JSON workout logging replays the same key without appending twice and detects digest conflicts', (t) => {
  const root = scratch(t);
  const workspace = path.join(root, 'workspace');
  const args = ['log-workout', '--json', '--input-json', '--workspace', workspace, '--date', '2026-10-23', '--idempotency-key', 'workout-1'];
  const first = run(args, { input: JSON.stringify(workoutPayload) });
  const firstEnvelope = readEnvelope(first);
  assert.equal(first.status, 0, first.stdout);
  assert.equal(firstEnvelope.idempotency.status, 'completed');

  const replay = run(args, { input: JSON.stringify(workoutPayload) });
  const replayEnvelope = readEnvelope(replay);
  assert.equal(replay.status, 0, replay.stdout);
  assert.equal(replayEnvelope.idempotency.status, 'replayed');
  assert.equal(replayEnvelope.data.session_id, firstEnvelope.data.session_id);

  const conflictingPayload = structuredClone(workoutPayload);
  conflictingPayload.session.notes = 'Different synthetic payload';
  const conflict = run(args, { input: JSON.stringify(conflictingPayload) });
  const conflictEnvelope = readEnvelope(conflict);
  assert.equal(conflict.status, 1);
  assert.equal(conflictEnvelope.error.code, 'HEALTH_OS_IDEMPOTENCY_CONFLICT');
  const sessions = fs.readFileSync(path.join(workspace, '.health-os/data/workout_sessions.csv'), 'utf8');
  assert.equal((sessions.match(/session-2026-10-23-/g) || []).length, 1);
});

test('idempotent validation failures replay their original error envelope and exit status', (t) => {
  const root = scratch(t);
  const workspace = path.join(root, 'workspace');
  assert.equal(run(['init-workspace', '--workspace', workspace]).status, 0);
  fs.writeFileSync(path.join(workspace, '.health-os/memory/wiki/invalid.md'), '# No metadata\n');
  const args = ['memory-lint', '--json', '--workspace', workspace, '--date', '2026-10-23', '--idempotency-key', 'lint-failure'];

  const first = run(args);
  const firstEnvelope = readEnvelope(first);
  const replay = run(args);
  const replayEnvelope = readEnvelope(replay);
  assert.equal(first.status, 1);
  assert.equal(replay.status, 1);
  assert.equal(firstEnvelope.error.code, 'HEALTH_OS_VALIDATION_FAILED');
  assert.equal(replayEnvelope.error.code, firstEnvelope.error.code);
  assert.equal(replayEnvelope.error.message, firstEnvelope.error.message);
  assert.equal(replayEnvelope.idempotency.status, 'replayed');
  assert.deepEqual(replayEnvelope.data, firstEnvelope.data);
});

test('idempotency fingerprints include effective import name and exact copied bytes', (t) => {
  const root = scratch(t);
  const workspace = path.join(root, 'workspace');
  const firstFile = path.join(root, 'first.txt');
  const secondFile = path.join(root, 'second.txt');
  fs.writeFileSync(firstFile, Buffer.from([0, 1, 255]));
  fs.writeFileSync(secondFile, Buffer.from([0, 1, 255]));
  const base = ['import-personal-file', '--json', '--workspace', workspace, '--idempotency-key', 'import-1'];
  const first = run([...base, '--file', firstFile]);
  assert.equal(first.status, 0, first.stderr);
  const conflict = run([...base, '--file', secondFile]);
  const envelope = JSON.parse(conflict.stdout);
  assert.equal(conflict.status, 1);
  assert.equal(envelope.error.code, 'HEALTH_OS_IDEMPOTENCY_CONFLICT');
  assert.equal(fs.readFileSync(path.join(workspace, '.health-os/personal/raw/first.txt')).length, 3);
  assert.equal(fs.existsSync(path.join(workspace, '.health-os/personal/raw/second.txt')), false);
});

test('JSON profile output retains its own character-count metadata', (t) => {
  const root = scratch(t);
  const workspace = path.join(root, 'workspace');
  assert.equal(run(['init-workspace', '--workspace', workspace]).status, 0);
  const profile = path.join(workspace, '.health-os/personal/files/profile.md');
  fs.appendFileSync(profile, `\n${'я'.repeat(32_000)}\n`);
  const result = run(['profile-show', '--json', '--workspace', workspace, '--max-chars', '40000']);
  const envelope = readEnvelope(result);
  assert.equal(result.status, 0);
  assert.equal([...envelope.data.markdown].length, envelope.data.total_chars);
  assert.equal(envelope.data.returned_chars, envelope.data.total_chars);
  assert.equal(envelope.data.truncated, false);
  assert.equal(envelope.truncation, undefined);
});

test('JSON output bounding reports truncation without cutting envelope syntax', () => {
  const bounded = boundedJsonValue({ rows: Array.from({ length: 150 }, (_, index) => index), text: 'x'.repeat(20_000) });
  assert.equal(bounded.truncation.truncated, true);
  assert.equal(bounded.value.rows.length, 100);
  assert.ok(bounded.value.text.length <= 12_001);
  assert.ok(Buffer.byteLength(JSON.stringify(bounded.value)) < 256 * 1024);
});

test('complete JSON envelopes fit the advertised serialized byte limit', () => {
  const rows = Array.from({ length: 100 }, () => Object.fromEntries(
    Array.from({ length: 100 }, (_, index) => [`key-${index}`, 'a'.repeat(50)])
  ));
  const envelope = makeSuccessEnvelope('synthetic-large-result', rows);
  assert.ok(Buffer.byteLength(JSON.stringify(envelope)) + 1 <= MAX_JSON_OUTPUT_BYTES);
  assert.equal(envelope.truncation?.truncated, true);
});

test('token rotation requires a destination or explicit export before contacting the provider', (t) => {
  const root = scratch(t);
  const fetchSource = "globalThis.fetch = async () => { process.stderr.write('MOCK_PROVIDER_CALLED\\n'); throw new Error('synthetic provider call'); };";
  const nodeOptions = `--import=data:text/javascript;base64,${Buffer.from(fetchSource).toString('base64')}`;
  const env = {
    ...process.env,
    NODE_OPTIONS: nodeOptions,
    OURA_TOKEN_FILE: '',
    OURA_CLIENT_ID: 'synthetic-client',
    OURA_CLIENT_SECRET: 'synthetic-secret',
    OURA_CODE: 'synthetic-code',
    OURA_REFRESH_TOKEN: 'synthetic-refresh'
  };
  for (const command of ['oura-exchange-code', 'oura-refresh-token']) {
    const result = run([command, '--workspace', path.join(root, command)], { env });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /requires --token-file or OURA_TOKEN_FILE/);
    assert.doesNotMatch(result.stderr, /MOCK_PROVIDER_CALLED/);
  }
});

test('zero progression increments remain valid for set-working-weight', (t) => {
  const root = scratch(t);
  const workspace = path.join(root, 'workspace');
  assert.equal(run(['init-workspace', '--workspace', workspace]).status, 0);
  const result = run([
    'set-working-weight', '--workspace', workspace, '--exercise', 'core', '--weight', '0.5', '--increment', '0'
  ]);
  assert.equal(result.status, 0, result.stderr);
  const settings = JSON.parse(fs.readFileSync(path.join(workspace, '.health-os/config/exercise-settings.json'), 'utf8'));
  assert.equal(settings.exercises.core.working_weight_kg, 0.5);
  assert.equal(settings.exercises.core.increment_kg, 0);
});

test('JSON errors are bounded, use stdout, and leave stderr clear', (t) => {
  const root = scratch(t);
  const workspace = path.join(root, 'uncreated');
  const malformed = `${' '.repeat(5_000)}{`;
  const result = run(['validate-daily-state', '--json', '--workspace', workspace], { input: malformed });
  const envelope = readEnvelope(result);
  assert.equal(result.status, 1);
  assert.equal(envelope.ok, false);
  assert.ok(envelope.error.message.length <= 1_001);
  assert.equal(fs.existsSync(workspace), false);
});

test('an interrupted idempotency record fails closed instead of replaying a new write', (t) => {
  const root = scratch(t);
  const paths = buildPaths(root);
  fs.mkdirSync(paths.trackerRoot, { recursive: true });
  const request = { command: 'synthetic-write', payload: 'synthetic' };
  const started = beginIdempotentRequest(paths, 'pending-case', request);
  assert.equal(started.status, 'new');
  assert.throws(() => beginIdempotentRequest(paths, 'pending-case', request), {
    code: 'HEALTH_OS_IDEMPOTENCY_IN_PROGRESS'
  });
});
