import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { CSV_HEADERS } from '../src/engine.js';
import { writeCsv } from '../src/csv.js';
import { MAX_JSON_OUTPUT_BYTES } from '../src/cli-contract.js';
import { buildPaths, repoRoot } from '../src/layout.js';

const ROOT = repoRoot();
const CLI = path.join(ROOT, 'src/cli.js');
const AS_OF = '2026-10-23';

function scratch(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'health-os-training-preparation-'));
  fs.mkdirSync(path.join(root, 'tmp'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function runCli(args, options = {}) {
  const { root = os.tmpdir(), tmpDir, env: extraEnv, ...spawnOptions } = options;
  const env = {
    ...process.env,
    TMPDIR: tmpDir || path.join(root, 'tmp'),
    ...extraEnv
  };
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env,
    ...spawnOptions
  });
}

function envelope(result) {
  assert.ok(result.stdout, `expected CLI JSON output; stderr was ${result.stderr}`);
  return JSON.parse(result.stdout);
}

function jsonCommand(root, workspace, ...args) {
  return runCli([...args, '--json', '--workspace', workspace], { root });
}

function initWorkspace(t, root, name = 'workspace') {
  const workspace = path.join(root, name);
  const result = jsonCommand(root, workspace, 'init-workspace');
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return { workspace, paths: buildPaths(workspace) };
}

function snapshotTree(root, { ignoreEventStoreAuxiliaryFiles = false, hashContents = false } = {}) {
  if (!fs.existsSync(root)) return null;
  const snapshot = {};
  const visit = (directory, prefix = '') => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (ignoreEventStoreAuxiliaryFiles && prefix === 'data' &&
          ['events.sqlite-wal', 'events.sqlite-shm'].includes(entry.name)) continue;
      const relative = path.posix.join(prefix, entry.name);
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute, relative);
      else if (entry.isFile()) {
        const bytes = fs.readFileSync(absolute);
        snapshot[relative] = hashContents ? createHash('sha256').update(bytes).digest('hex') : bytes;
      }
      else snapshot[relative] = `kind:${entry.isSymbolicLink() ? 'symlink' : 'other'}`;
    }
  };
  visit(root);
  return snapshot;
}

function makeEvent({
  id,
  type = 'subjective.energy',
  value = 1,
  occurred = { start: '2026-10-23T08:00:00Z', end: null, precision: 'minute', timezone: 'UTC' },
  epistemicStatus = 'fact',
  uncertainty = 'low',
  sourceRef = id
}) {
  return {
    schema_version: 1,
    event_id: id,
    event_type: type,
    occurred,
    data: { value },
    source: { kind: 'manual', ref: `synthetic:${sourceRef}`, fragment_id: '0' },
    extraction_version: 'synthetic-test-v1',
    epistemic_status: epistemicStatus,
    uncertainty: { level: uncertainty, note: null }
  };
}

function addEvent(root, workspace, event, key = 'event-add') {
  const result = runCli([
    'context-add', '--json', '--input-json', '--workspace', workspace,
    '--idempotency-key', key
  ], { root, input: JSON.stringify(event) });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return envelope(result).data;
}

function prepare(root, workspace, asOf = AS_OF, extraArgs = []) {
  const result = jsonCommand(root, workspace, 'prepare-training', '--as-of', asOf, ...extraArgs);
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  return envelope(result).data;
}

function preparationPolicy(paths) {
  return JSON.parse(fs.readFileSync(paths.preparationPolicyFile, 'utf8'));
}

function savePreparationPolicy(paths, policy) {
  fs.writeFileSync(paths.preparationPolicyFile, `${JSON.stringify(policy, null, 2)}\n`);
}

function writeSyntheticRecovery(paths, { through = AS_OF, samples = 14, syncTime = '2026-10-23T06:00:00Z' } = {}) {
  const target = new Date(`${through}T00:00:00Z`);
  const snapshots = [];
  const days = [];
  for (let offset = samples; offset >= 1; offset -= 1) {
    const date = new Date(target.getTime() - offset * 86_400_000).toISOString().slice(0, 10);
    snapshots.push(
      { date, metric_name: 'hrv', metric_value: '50', unit: 'ms', source_sync_time: `${date}T06:00:00Z` },
      { date, metric_name: 'resting_hr', metric_value: '55', unit: 'bpm', source_sync_time: `${date}T06:00:00Z` }
    );
  }
  days.push({
    date: through,
    readiness_score: '80', sleep_score: '78', hrv: '50', hrv_baseline_28d: '50', hrv_delta_pct: '0',
    resting_hr: '55', resting_hr_baseline_28d: '55', resting_hr_delta: '0', sleep_efficiency: '0.9',
    total_sleep_minutes: '420', temperature_deviation: '0', recommended_mode: 'FULL',
    recommendation_reason: 'synthetic-only input', source_sync_time: syncTime
  });
  snapshots.push(
    { date: through, metric_name: 'hrv', metric_value: '50', unit: 'ms', source_sync_time: syncTime },
    { date: through, metric_name: 'resting_hr', metric_value: '55', unit: 'bpm', source_sync_time: syncTime }
  );
  const futureDate = new Date(target.getTime() + 86_400_000).toISOString().slice(0, 10);
  days.push({
    ...days[0], date: futureDate, readiness_score: '1', sleep_score: '1', hrv: '999', resting_hr: '200',
    source_sync_time: `${futureDate}T06:00:00Z`, recommendation_reason: 'future synthetic recovery must be excluded'
  });
  snapshots.push(
    { date: futureDate, metric_name: 'hrv', metric_value: '999', unit: 'ms', source_sync_time: `${futureDate}T06:00:00Z` },
    { date: futureDate, metric_name: 'resting_hr', metric_value: '200', unit: 'bpm', source_sync_time: `${futureDate}T06:00:00Z` }
  );
  writeCsv(paths.recoverySnapshotsFile, CSV_HEADERS.recoverySnapshots, snapshots);
  writeCsv(paths.dailyStateFile, CSV_HEADERS.dailyState, days);
}

function writeWorkoutHistory(paths, { futureWeight = '200', pastWeight = '60' } = {}) {
  const sessions = [
    {
      session_id: 'synthetic-past', date: '2026-10-22', day_type: 'A', recommended_mode: 'BASE', actual_mode: 'BASE',
      duration_minutes: '45', session_rpe: '6', energy_pre: '4', soreness_pre: '2', completed_flag: 'true', notes: 'past synthetic session'
    },
    {
      session_id: 'synthetic-future', date: '2026-10-24', day_type: 'A', recommended_mode: 'LIGHT', actual_mode: 'LIGHT',
      duration_minutes: '50', session_rpe: '10', energy_pre: '1', soreness_pre: '5', completed_flag: 'true', notes: 'future synthetic session'
    }
  ];
  const exerciseLogs = [
    {
      session_id: 'synthetic-past', session_date: '2026-10-22', day_type: 'A', exercise_key: 'squat', exercise_name: 'Squat',
      set_count: '3', reps: '5|5|5', weight: pastWeight, top_set_weight: pastWeight, top_set_reps: '5', estimated_1rm: '70',
      completed_as_planned: 'true', actual_mode: 'BASE', session_rpe: '6', notes: 'past load'
    },
    {
      session_id: 'synthetic-future', session_date: '2026-10-24', day_type: 'A', exercise_key: 'squat', exercise_name: 'Squat',
      set_count: '4', reps: '5|5|5|5', weight: futureWeight, top_set_weight: futureWeight, top_set_reps: '5', estimated_1rm: '233.33',
      completed_as_planned: 'true', actual_mode: 'FULL', session_rpe: '10', notes: 'future load must be excluded'
    }
  ];
  writeCsv(paths.workoutSessionsFile, CSV_HEADERS.workoutSessions, sessions);
  writeCsv(paths.exerciseLogsFile, CSV_HEADERS.exerciseLogs, exerciseLogs);
}

function wearableSet({ date, observedAt, readiness = 80, sleep = 78, hrv = 50, restingHr = 55, scoreAt = observedAt }) {
  const metric = (name, value, unit, timestamp) => ({
    metric: name, status: 'observed', value, unit,
    observed_at: timestamp, observed_date: null, source_ref: `${date}-${name}`
  });
  const evaluationAt = new Date(Date.parse(observedAt) + 300_000).toISOString();
  return {
    schema_version: 1,
    date,
    source: { id: 'synthetic-sensor', label: 'Synthetic Sensor', reference: `${date}-sample` },
    freshness: {
      status: 'fresh', observed_at: observedAt, evaluated_at: evaluationAt, max_age_seconds: 1800
    },
    physical_metrics: [
      metric('hrv', hrv, 'ms', observedAt),
      metric('resting_hr', restingHr, 'bpm', observedAt)
    ],
    proprietary_scores: [
      metric('readiness_score', readiness, 'score', scoreAt),
      metric('sleep_score', sleep, 'score', scoreAt)
    ]
  };
}

function ingestObservation(root, workspace, observation, key) {
  const result = runCli([
    'ingest-wearable-observations', '--json', '--input-json', '--workspace', workspace,
    '--idempotency-key', key
  ], { root, input: JSON.stringify(observation) });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return envelope(result).data.observation;
}

function memoryPage(paths, file, { title, status = 'observation', humanConfirmed = false, evidenceEnd = '2026-10-20', body }) {
  const target = path.join(paths.memoryWikiDir, file);
  fs.writeFileSync(target, [
    '---', `title: ${title}`, `status: ${status}`, 'confidence: low',
    `evidence_start: ${evidenceEnd}`, `evidence_end: ${evidenceEnd}`, `last_reviewed: ${evidenceEnd}`,
    'provenance: []', `human_confirmed: ${humanConfirmed}`, '---', '', body, ''
  ].join('\n'));
  return target;
}

function runGenericAgentWrapper(root, workspace, asOf) {
  const wrapper = [
    "const { spawnSync } = require('node:child_process');",
    'const cli = process.argv[1]; const workspace = process.argv[2]; const asOf = process.argv[3];',
    'const result = spawnSync(process.execPath, [cli, "prepare-training", "--as-of", asOf, "--workspace", workspace, "--json"], { encoding: "utf8" });',
    'if (result.status !== 0) { process.stderr.write(result.stderr || result.stdout); process.exit(result.status || 1); }',
    'const envelope = JSON.parse(result.stdout); process.stdout.write(JSON.stringify({ schema_version: envelope.schema_version, data: envelope.data }));'
  ].join('\n');
  return spawnSync(process.execPath, ['-e', wrapper, CLI, workspace, asOf], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, TMPDIR: path.join(root, 'tmp') }
  });
}

test('the same as-of preparation is available through the CLI and a generic JSON subprocess wrapper', (t) => {
  const root = scratch(t);
  const { workspace, paths } = initWorkspace(t, root);
  writeWorkoutHistory(paths);
  writeSyntheticRecovery(paths);

  const before = snapshotTree(paths.trackerRoot);
  const terminal = jsonCommand(root, workspace, 'prepare-training', '--as-of', AS_OF);
  assert.equal(terminal.status, 0, terminal.stderr || terminal.stdout);
  const direct = envelope(terminal);
  const wrapper = runGenericAgentWrapper(root, workspace, AS_OF);
  assert.equal(wrapper.status, 0, wrapper.stderr || wrapper.stdout);
  const wrapped = JSON.parse(wrapper.stdout);

  assert.equal(direct.command, 'prepare-training');
  assert.equal(direct.schema_version, wrapped.schema_version);
  assert.deepEqual(direct.data, wrapped.data);
  assert.equal(direct.data.as_of.date, AS_OF);
  assert.deepEqual(snapshotTree(paths.trackerRoot), before);
});

test('weekday assignment and approved substitution follow workspace policy while legacy next stays compatible', (t) => {
  const root = scratch(t);
  const { workspace, paths } = initWorkspace(t, root);
  writeWorkoutHistory(paths);
  const policy = preparationPolicy(paths);
  policy.session_selection.weekday_day_types.friday = 'B';
  policy.substitutions.allowed = [{ from: 'deadlift', to: 'squat' }];
  savePreparationPolicy(paths, policy);

  const nextBefore = jsonCommand(root, workspace, 'next', '--date', AS_OF);
  assert.equal(nextBefore.status, 0, nextBefore.stderr || nextBefore.stdout);
  const before = envelope(nextBefore).data;
  assert.equal(before.dayType, 'B');

  const assigned = prepare(root, workspace, AS_OF, ['--substitute', 'deadlift=squat']);
  assert.equal(assigned.session_selection.selected_day_type, 'B');
  assert.equal(assigned.session_selection.strategy, 'weekday_mapping');
  assert.ok(assigned.workout.exercises.some((exercise) => exercise.exercise_key === 'squat'));
  assert.deepEqual(assigned.session_selection.substitutions, [{ from: 'deadlift', to: 'squat' }]);

  const explicit = prepare(root, workspace, AS_OF, ['--session', 'A']);
  assert.equal(explicit.session_selection.requested_day_type, 'A');
  assert.equal(explicit.session_selection.selected_day_type, 'A');
  assert.equal(explicit.session_selection.explicit, true);
  assert.ok(explicit.workout.exercises.some((exercise) => exercise.exercise_key === 'squat'));

  const nextAfter = jsonCommand(root, workspace, 'next', '--date', AS_OF);
  assert.equal(nextAfter.status, 0, nextAfter.stderr || nextAfter.stdout);
  assert.deepEqual(envelope(nextAfter).data, before);
  assert.deepEqual(JSON.parse(fs.readFileSync(paths.preparationPolicyFile, 'utf8')), policy);
});

test('latest low-uncertainty facts govern subjective adjustments without stacking; pending and uncertain events remain signals', (t) => {
  const root = scratch(t);
  const { workspace } = initWorkspace(t, root);
  const baseline = prepare(root, workspace, AS_OF, ['--session', 'A']);
  const firstLowEnergy = makeEvent({
    id: '40000000-0000-4000-8000-000000000001', value: 1,
    occurred: { start: '2026-10-22T09:00:00Z', end: null, precision: 'minute', timezone: 'UTC' }, sourceRef: 'energy-check-in-1'
  });
  addEvent(root, workspace, firstLowEnergy, 'energy-check-in-1');
  const onceAdjusted = prepare(root, workspace, AS_OF, ['--session', 'A']);
  const repeatedLowEnergy = makeEvent({
    id: '40000000-0000-4000-8000-000000000002', value: 1,
    occurred: { start: '2026-10-22T10:00:00Z', end: null, precision: 'minute', timezone: 'UTC' }, sourceRef: 'energy-check-in-2'
  });
  addEvent(root, workspace, repeatedLowEnergy, 'energy-check-in-2');
  const twiceReported = prepare(root, workspace, AS_OF, ['--session', 'A']);
  const latestNormalEnergy = makeEvent({
    id: '40000000-0000-4000-8000-000000000003', value: 5,
    occurred: { start: '2026-10-23T08:00:00Z', end: null, precision: 'minute', timezone: 'UTC' }, sourceRef: 'energy-check-in-latest'
  });
  addEvent(root, workspace, latestNormalEnergy, 'energy-check-in-latest');
  const latestFact = prepare(root, workspace, AS_OF, ['--session', 'A']);

  const highUncertainty = makeEvent({
    id: '40000000-0000-4000-8000-000000000004', value: 1, epistemicStatus: 'fact', uncertainty: 'high',
    occurred: { start: '2026-10-23T09:00:00Z', end: null, precision: 'minute', timezone: 'UTC' }, sourceRef: 'uncertain-energy'
  });
  const pending = makeEvent({
    id: '40000000-0000-4000-8000-000000000005', value: 1, epistemicStatus: 'pending', uncertainty: 'low',
    occurred: { start: '2026-10-23T10:00:00Z', end: null, precision: 'minute', timezone: 'UTC' }, sourceRef: 'pending-energy'
  });
  addEvent(root, workspace, highUncertainty, 'uncertain-energy');
  addEvent(root, workspace, pending, 'pending-energy');
  const signaled = prepare(root, workspace, AS_OF, ['--session', 'A']);

  assert.notDeepEqual(onceAdjusted.workout.exercises, baseline.workout.exercises);
  assert.deepEqual(
    twiceReported.workout.exercises.map(({ exercise_key, target_sets }) => ({ exercise_key, target_sets })),
    onceAdjusted.workout.exercises.map(({ exercise_key, target_sets }) => ({ exercise_key, target_sets }))
  );
  assert.deepEqual(latestFact.workout.exercises, baseline.workout.exercises);
  assert.deepEqual(signaled.workout.exercises, latestFact.workout.exercises);
  assert.ok(onceAdjusted.subjective.applied.some((item) => item.event_id === firstLowEnergy.event_id));
  assert.ok(twiceReported.subjective.applied.some((item) => item.event_id === repeatedLowEnergy.event_id));
  assert.ok(twiceReported.workout.exercises.every((exercise) =>
    exercise.subjective_adjustment?.event_ids.includes(repeatedLowEnergy.event_id)));
  assert.ok(signaled.subjective.signals.some((item) => item.event_id === highUncertainty.event_id));
  assert.ok(signaled.subjective.signals.some((item) => item.event_id === pending.event_id));
  assert.equal(signaled.memory.status, 'blocked');
  assert.equal(JSON.stringify(signaled.memory).includes('energy-check-in'), false);
});

test('configured non-subjective event types can adjust while unconfigured subjective types remain signals', (t) => {
  const root = scratch(t);
  const { workspace, paths } = initWorkspace(t, root);
  const policy = preparationPolicy(paths);
  policy.subjective.events['recovery.checkin'] = {
    field: 'value', minimum: 0, maximum: 5,
    adjustment: { operator: 'lte', threshold: 2, target_sets_delta: -2 }
  };
  savePreparationPolicy(paths, policy);

  const configured = makeEvent({
    id: '40000000-0000-4000-8000-000000000011', type: 'recovery.checkin', value: 1,
    occurred: { start: '2026-10-23T08:00:00Z', end: null, precision: 'minute', timezone: 'UTC' },
    sourceRef: 'configured-recovery-checkin'
  });
  const unconfigured = makeEvent({
    id: '40000000-0000-4000-8000-000000000012', type: 'subjective.mobility', value: 1,
    occurred: { start: '2026-10-23T09:00:00Z', end: null, precision: 'minute', timezone: 'UTC' },
    sourceRef: 'unconfigured-mobility'
  });
  addEvent(root, workspace, configured, 'configured-recovery-checkin');
  addEvent(root, workspace, unconfigured, 'unconfigured-mobility');
  const result = prepare(root, workspace, AS_OF, ['--session', 'A']);

  assert.deepEqual(result.subjective.applied.map((item) => item.event_id), [configured.event_id]);
  assert.ok(result.subjective.signals.some((item) => item.event_id === unconfigured.event_id));
  assert.equal(result.subjective.applied.some((item) => item.event_id === unconfigured.event_id), false);
  assert.equal(result.workout.exercises.find((item) => item.exercise_key === 'squat').target_sets, 2);
});

test('event-review pending state and stale memory provenance never expose derived page text', (t) => {
  const root = scratch(t);
  const { workspace, paths } = initWorkspace(t, root);
  const event = makeEvent({ id: '40000000-0000-4000-8000-000000000004', sourceRef: 'memory-gate' });
  const added = addEvent(root, workspace, event, 'memory-gate');
  const wiki = path.join(paths.memoryWikiDir, 'synthetic-preparation.md');
  const privateText = 'synthetic-memory-secret phrase for preparation retrieval';
  fs.writeFileSync(wiki, [
    '---', 'title: Synthetic preparation note', 'status: observation', 'confidence: low',
    'evidence_start: 2026-10-20', 'evidence_end: 2026-10-22', 'last_reviewed: 2026-10-22',
    'provenance: []', 'human_confirmed: false', '---', '',
    `${privateText} health-event:${event.event_id}@1`, ''
  ].join('\n'));

  const pending = prepare(root, workspace);
  assert.equal(pending.memory.status, 'blocked');
  assert.doesNotMatch(JSON.stringify(pending.memory), /synthetic-memory-secret/);

  const review = jsonCommand(root, workspace, 'context-revalidate-memory', '--generation', String(added.generation));
  assert.equal(review.status, 0, review.stderr || review.stdout);
  const available = prepare(root, workspace);
  assert.equal(available.memory.status, 'available');
  assert.match(JSON.stringify(available.memory), /synthetic-memory-secret/);

  const corrected = { ...event, data: { value: 2 } };
  const correction = runCli([
    'context-correct', '--json', '--input-json', '--workspace', workspace, '--event-id', event.event_id,
    '--expected-revision', '1', '--idempotency-key', 'memory-gate-correction'
  ], { root, input: JSON.stringify(corrected) });
  assert.equal(correction.status, 0, correction.stderr || correction.stdout);

  const reviewState = JSON.parse(fs.readFileSync(paths.eventReviewFile, 'utf8'));
  reviewState.reviewed_generation = reviewState.required_generation;
  reviewState.pending = false;
  reviewState.changed_events = reviewState.changed_events.map((item) => item.event_id === event.event_id
    ? { ...item, revision: 2 }
    : item);
  fs.writeFileSync(paths.eventReviewFile, `${JSON.stringify(reviewState, null, 2)}\n`);
  const staleProvenance = prepare(root, workspace);
  assert.equal(staleProvenance.memory.status, 'blocked');
  assert.doesNotMatch(JSON.stringify(staleProvenance.memory), /synthetic-memory-secret/);
});

test('as-of date excludes future workout, recovery, event, and evidence rows while reporting baseline gaps', (t) => {
  const root = scratch(t);
  const { workspace, paths } = initWorkspace(t, root);
  writeWorkoutHistory(paths);
  writeSyntheticRecovery(paths, { samples: 13 });
  const futureEvent = makeEvent({
    id: '40000000-0000-4000-8000-000000000005',
    occurred: { start: '2026-10-24T09:00:00Z', end: null, precision: 'minute', timezone: 'UTC' },
    sourceRef: 'future-event'
  });
  addEvent(root, workspace, futureEvent, 'future-event');
  const sameDayDateEvent = makeEvent({
    id: '40000000-0000-4000-8000-000000000009', type: 'subjective.pain', value: 3,
    occurred: { start: AS_OF, end: null, precision: 'day', timezone: 'UTC' }, sourceRef: 'same-day-date-event'
  });
  const sameDayAdded = addEvent(root, workspace, sameDayDateEvent, 'same-day-date-event');
  const evidenceDir = paths.memoryEvidenceDir;
  fs.writeFileSync(path.join(evidenceDir, 'weekly-2026-10-22.md'), [
    '---', 'title: Prior synthetic evidence', 'status: observation', 'confidence: low',
    'evidence_start: 2026-10-20', 'evidence_end: 2026-10-22', 'last_reviewed: 2026-10-22',
    'provenance: []', 'human_confirmed: false', '---', '', 'squat load before-cutoff synthetic training recovery evidence', ''
  ].join('\n'));
  fs.writeFileSync(path.join(evidenceDir, 'weekly-2026-10-24.md'), [
    '---', 'title: Future synthetic evidence', 'status: observation', 'confidence: low',
    'evidence_start: 2026-10-24', 'evidence_end: 2026-10-24', 'last_reviewed: 2026-10-24',
    'provenance: []', 'human_confirmed: false', '---', '', 'squat load future-cutoff synthetic evidence must be excluded', ''
  ].join('\n'));
  const reviewed = jsonCommand(root, workspace, 'context-revalidate-memory', '--generation', String(sameDayAdded.generation));
  assert.equal(reviewed.status, 0, reviewed.stderr || reviewed.stdout);
  const output = prepare(root, workspace);
  const serialized = JSON.stringify(output);

  assert.match(serialized, /synthetic-past/);
  assert.doesNotMatch(serialized, /synthetic-future|future load must be excluded|233\.33/);
  assert.match(serialized, new RegExp(sameDayDateEvent.event_id));
  assert.match(serialized, /before-cutoff synthetic training recovery evidence/);
  assert.doesNotMatch(serialized, /future-cutoff synthetic evidence/);
  assert.doesNotMatch(serialized, new RegExp(futureEvent.event_id));
  assert.doesNotMatch(serialized, /999|future synthetic recovery must be excluded/);
  assert.match(serialized, /baseline/i);
});

test('timestamp cutoffs exclude later exact events and do not turn day-only records into exact history', (t) => {
  const root = scratch(t);
  const { workspace } = initWorkspace(t, root);
  const earlier = makeEvent({
    id: '40000000-0000-4000-8000-000000000006', value: 1,
    occurred: { start: '2026-10-23T11:00:00Z', end: null, precision: 'minute', timezone: 'UTC' }, sourceRef: 'earlier-event'
  });
  const later = makeEvent({
    id: '40000000-0000-4000-8000-000000000007', value: 1,
    occurred: { start: '2026-10-23T13:00:00Z', end: null, precision: 'minute', timezone: 'UTC' }, sourceRef: 'later-event'
  });
  const dayOnly = makeEvent({
    id: '40000000-0000-4000-8000-000000000008', value: 1,
    occurred: { start: '2026-10-23', end: null, precision: 'day', timezone: 'UTC' }, sourceRef: 'day-only-event'
  });
  const crossingInterval = makeEvent({
    id: '40000000-0000-4000-8000-000000000010', type: 'subjective.pain', value: 3,
    occurred: { start: '2026-10-23T11:00:00Z', end: '2026-10-23T13:00:00Z', precision: 'interval', timezone: 'UTC' },
    sourceRef: 'interval-crosses-cutoff'
  });
  addEvent(root, workspace, earlier, 'earlier-event');
  addEvent(root, workspace, later, 'later-event');
  addEvent(root, workspace, dayOnly, 'day-only-event');
  addEvent(root, workspace, crossingInterval, 'crossing-interval');
  const output = prepare(root, workspace, '2026-10-23T12:00:00Z');
  const serialized = JSON.stringify(output);

  assert.match(serialized, new RegExp(earlier.event_id));
  assert.doesNotMatch(serialized, new RegExp(later.event_id));
  assert.doesNotMatch(serialized, new RegExp(dayOnly.event_id));
  assert.doesNotMatch(serialized, new RegExp(crossingInterval.event_id));
  assert.match(serialized, /2026-10-23T12:00:00Z/);
});

test('fresh observation-backed recovery uses only timestamp-eligible samples and refuses stale scores', (t) => {
  const root = scratch(t);
  const { workspace, paths } = initWorkspace(t, root);
  const policy = preparationPolicy(paths);
  policy.recovery.baseline_window_days = 7;
  policy.recovery.baseline_min_observed_days = 2;
  savePreparationPolicy(paths, policy);

  for (const [date, value] of [['2026-10-21', 50], ['2026-10-22', 52]]) {
    ingestObservation(root, workspace, wearableSet({
      date, observedAt: `${date}T06:00:00Z`, hrv: value, restingHr: 55
    }), `baseline-${date}`);
  }
  ingestObservation(root, workspace, wearableSet({
    date: AS_OF, observedAt: `${AS_OF}T06:00:00Z`, hrv: 51, restingHr: 56
  }), 'current-recovery');

  const before = snapshotTree(paths.trackerRoot);
  const available = prepare(root, workspace, '2026-10-23T12:00:00Z');
  assert.equal(available.recovery.status, 'available');
  assert.equal(available.recovery.source_type, 'wearable_observation_set');
  assert.equal(available.recovery.source.id, 'synthetic-sensor');
  assert.equal(available.recovery.baselines.hrv.observed_days, 2);
  assert.equal(available.recovery.decision.status, 'available');
  assert.equal(available.recovery.legacy_recommendation_used, false);
  assert.deepEqual(snapshotTree(paths.trackerRoot), before);

  const staleRoot = path.join(root, 'stale-score');
  fs.mkdirSync(staleRoot);
  fs.mkdirSync(path.join(staleRoot, 'tmp'));
  const staleWorkspace = path.join(staleRoot, 'workspace');
  const initialized = jsonCommand(staleRoot, staleWorkspace, 'init-workspace');
  assert.equal(initialized.status, 0, initialized.stderr || initialized.stdout);
  const stalePaths = buildPaths(staleWorkspace);
  const stalePolicy = preparationPolicy(stalePaths);
  stalePolicy.recovery.baseline_window_days = 7;
  stalePolicy.recovery.baseline_min_observed_days = 2;
  savePreparationPolicy(stalePaths, stalePolicy);
  for (const [date, value] of [['2026-10-21', 50], ['2026-10-22', 52]]) {
    ingestObservation(staleRoot, staleWorkspace, wearableSet({
      date, observedAt: `${date}T06:00:00Z`, hrv: value, restingHr: 55
    }), `stale-baseline-${date}`);
  }
  ingestObservation(staleRoot, staleWorkspace, wearableSet({
    date: AS_OF, observedAt: `${AS_OF}T06:00:00Z`, scoreAt: '2026-10-21T06:00:00Z'
  }), 'stale-current-score');
  const stale = prepare(staleRoot, staleWorkspace, '2026-10-23T12:00:00Z');
  assert.equal(stale.recovery.status, 'unavailable');
  assert.ok(stale.recovery.decision.reasons.includes('current_metrics_stale_or_unknown'));
  assert.equal(stale.recovery.legacy_recommendation_used, false);
});

test('legacy recovery source-sync instants honor UTC offsets and reject future backfills', (t) => {
  const root = scratch(t);
  const { workspace, paths } = initWorkspace(t, root);
  const policy = preparationPolicy(paths);
  policy.recovery.allow_legacy_unscoped_baseline = true;
  savePreparationPolicy(paths, policy);
  writeCsv(paths.dailyStateFile, CSV_HEADERS.dailyState, [{
    date: '2026-10-22', readiness_score: '90', sleep_score: '90', hrv: '60', hrv_baseline_28d: '55',
    hrv_delta_pct: '9', resting_hr: '50', resting_hr_baseline_28d: '55', resting_hr_delta: '-5',
    sleep_efficiency: '0.95', total_sleep_minutes: '480', temperature_deviation: '0',
    recommended_mode: 'FULL', recommendation_reason: 'future backfill must not leak',
    source_sync_time: '2026-10-24T09:00:00Z'
  }]);
  writeCsv(paths.recoverySnapshotsFile, CSV_HEADERS.recoverySnapshots, [
    { date: '2026-10-21', metric_name: 'hrv', metric_value: '50', unit: 'ms', source_sync_time: '2026-10-21T06:00:00Z' },
    { date: '2026-10-21', metric_name: 'resting_hr', metric_value: '55', unit: 'bpm', source_sync_time: '2026-10-21T06:00:00Z' }
  ]);
  const result = prepare(root, workspace, AS_OF);
  assert.equal(result.recovery.status, 'unavailable');
  assert.equal(result.recovery.date, null);
  assert.ok(result.gaps.some((gap) => gap.code === 'recovery_missing'));
  assert.doesNotMatch(JSON.stringify(result.recovery), /future backfill must not leak|"date":"2026-10-22"/);

  const offsetWorkspace = initWorkspace(t, root, 'offset-workspace');
  const offsetPolicy = preparationPolicy(offsetWorkspace.paths);
  offsetPolicy.recovery.allow_legacy_unscoped_baseline = true;
  offsetPolicy.recovery.baseline_window_days = 7;
  offsetPolicy.recovery.baseline_min_observed_days = 1;
  savePreparationPolicy(offsetWorkspace.paths, offsetPolicy);
  writeCsv(offsetWorkspace.paths.dailyStateFile, CSV_HEADERS.dailyState, [{
    date: '2026-10-22', readiness_score: '80', sleep_score: '78', hrv: '51', hrv_baseline_28d: '50',
    hrv_delta_pct: '2', resting_hr: '54', resting_hr_baseline_28d: '55', resting_hr_delta: '-1',
    sleep_efficiency: '0.9', total_sleep_minutes: '420', temperature_deviation: '0',
    recommended_mode: 'BASE', recommendation_reason: 'offset timestamp is before cutoff',
    source_sync_time: '2026-10-23T11:30:00+02:00'
  }]);
  writeCsv(offsetWorkspace.paths.recoverySnapshotsFile, CSV_HEADERS.recoverySnapshots, [
    { date: '2026-10-21', metric_name: 'hrv', metric_value: '50', unit: 'ms', source_sync_time: '2026-10-21T06:00:00Z' },
    { date: '2026-10-21', metric_name: 'resting_hr', metric_value: '55', unit: 'bpm', source_sync_time: '2026-10-21T06:00:00Z' }
  ]);
  const offset = prepare(root, offsetWorkspace.workspace, '2026-10-23T12:00:00+02:00');
  assert.equal(offset.as_of.timestamp, '2026-10-23T12:00:00+02:00');
  assert.equal(offset.recovery.date, '2026-10-22');
  assert.equal(offset.recovery.status, 'available');
});

test('memory retrieval favors older relevant evidence and omits unconfirmed accepted rules', (t) => {
  const root = scratch(t);
  const { workspace, paths } = initWorkspace(t, root);
  memoryPage(paths, 'older-squat-preparation.md', {
    title: 'Squat preparation note', evidenceEnd: '2026-10-10',
    body: 'Synthetic squat preparation: training workout recovery and readiness context.'
  });
  for (let index = 0; index < 6; index += 1) {
    memoryPage(paths, `newer-generic-${index}.md`, {
      title: `Newer training page ${index}`, evidenceEnd: '2026-10-22',
      body: `Synthetic training page ${index} with unrelated gardening details.`
    });
  }
  memoryPage(paths, 'unconfirmed-rule.md', {
    title: 'Unconfirmed squat rule', status: 'accepted_rule', humanConfirmed: false,
    body: 'Synthetic rule: reduce squat training whenever readiness is low.'
  });
  const result = prepare(root, workspace, AS_OF, ['--session', 'A']);
  const evidence = result.memory.evidence;
  assert.ok(evidence.some((item) => item.file.endsWith('older-squat-preparation.md')));
  assert.ok(evidence.length <= 5);
  assert.ok(evidence.every((item) => item.excerpt.length <= 1_000));
  assert.equal(evidence.some((item) => item.file.endsWith('unconfirmed-rule.md')), false);
  assert.equal(evidence.some((item) => item.status === 'accepted_rule' && item.file.endsWith('unconfirmed-rule.md')), false);
  assert.ok(result.gaps.some((gap) => gap.code === 'memory_rule_unconfirmed'));
});

test('bounded preparation context stays within the advertised JSON and collection limits', (t) => {
  const root = scratch(t);
  const { workspace, paths } = initWorkspace(t, root);
  for (let index = 0; index < 30; index += 1) {
    memoryPage(paths, `bounded-${String(index).padStart(2, '0')}.md`, {
      title: `Synthetic squat preparation ${index}`, evidenceEnd: `2026-10-${String(20 - Math.min(index, 9)).padStart(2, '0')}`,
      body: `squat training preparation ${index} ${'bounded synthetic context '.repeat(80)}`
    });
  }
  const result = jsonCommand(root, workspace, 'prepare-training', '--as-of', AS_OF, '--session', 'A');
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.ok(Buffer.byteLength(result.stdout) <= MAX_JSON_OUTPUT_BYTES);
  const data = envelope(result).data;
  assert.ok(data.memory.evidence.length <= 5);
  assert.ok(data.memory.evidence.every((item) => item.excerpt.length <= 1_000));
  assert.ok(data.workout.history.length <= 20);
});

test('preparation is read-only for missing or incomplete workspaces and rejects request journaling', (t) => {
  const root = scratch(t);
  const missing = path.join(root, 'missing-workspace');
  const missingResult = jsonCommand(root, missing, 'prepare-training', '--as-of', AS_OF);
  assert.equal(missingResult.status, 1);
  assert.equal(fs.existsSync(missing), false);

  const { workspace, paths } = initWorkspace(t, root, 'incomplete-workspace');
  fs.rmSync(paths.preparationPolicyFile);
  const before = snapshotTree(paths.trackerRoot);
  const absentPolicy = jsonCommand(root, workspace, 'prepare-training', '--as-of', AS_OF);
  assert.equal(absentPolicy.status, 1);
  assert.deepEqual(snapshotTree(paths.trackerRoot), before);

  fs.copyFileSync(path.join(ROOT, 'config/preparation-policy.json'), paths.preparationPolicyFile);
  const completeBefore = snapshotTree(paths.trackerRoot);
  const journal = jsonCommand(root, workspace, 'prepare-training', '--as-of', AS_OF, '--idempotency-key', 'read-only-preparation');
  assert.equal(journal.status, 1);
  assert.deepEqual(snapshotTree(paths.trackerRoot), completeBefore);

  fs.rmSync(path.join(paths.personalFilesDir, 'profile.md'));
  const missingProfileBefore = snapshotTree(paths.trackerRoot);
  const missingProfile = jsonCommand(root, workspace, 'prepare-training', '--as-of', AS_OF);
  assert.equal(missingProfile.status, 0, `${missingProfile.stderr}\n${missingProfile.stdout}`);
  const profileGap = envelope(missingProfile).data;
  assert.equal(profileGap.profile.status, 'missing');
  assert.ok(profileGap.gaps.some((gap) => gap.code === 'profile_missing'));
  assert.deepEqual(snapshotTree(paths.trackerRoot), missingProfileBefore);
});

test('preparation leaves populated EventStore and domain files unchanged while allowing SQLite auxiliary state', (t) => {
  const root = scratch(t);
  const { workspace, paths } = initWorkspace(t, root);
  const event = makeEvent({
    id: '40000000-0000-4000-8000-000000000031', sourceRef: 'readonly-populated-store'
  });
  addEvent(root, workspace, event, 'readonly-populated-store');

  const eventDbBefore = createHash('sha256').update(fs.readFileSync(paths.eventsDbFile)).digest('hex');
  const domainFilesBefore = snapshotTree(paths.trackerRoot, {
    ignoreEventStoreAuxiliaryFiles: true, hashContents: true
  });
  const result = prepare(root, workspace, AS_OF);

  assert.ok(result.subjective.selected_facts.some((item) => item.event_id === event.event_id));
  assert.equal(createHash('sha256').update(fs.readFileSync(paths.eventsDbFile)).digest('hex'), eventDbBefore);
  assert.deepEqual(snapshotTree(paths.trackerRoot, {
    ignoreEventStoreAuxiliaryFiles: true, hashContents: true
  }), domainFilesBefore);
});
