import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { buildPaths } from '../src/layout.js';
import { buildTimeline } from '../src/timeline.js';
import { createHealthEvent } from '../src/event-contract.js';

const WORKOUT_HEADERS = 'session_id,date,day_type,recommended_mode,actual_mode,duration_minutes,session_rpe,energy_pre,soreness_pre,completed_flag,notes';
const EXERCISE_HEADERS = 'session_id,session_date,day_type,exercise_key,exercise_name,set_count,reps,weight,top_set_weight,top_set_reps,estimated_1rm,completed_as_planned,actual_mode,session_rpe,notes';
const DAILY_HEADERS = 'date,readiness_score,sleep_score,hrv,hrv_baseline_28d,hrv_delta_pct,resting_hr,resting_hr_baseline_28d,resting_hr_delta,sleep_efficiency,total_sleep_minutes,temperature_deviation,recommended_mode,recommendation_reason,source_sync_time';
const SNAPSHOT_HEADERS = 'date,metric_name,metric_value,unit,source_sync_time';

function syntheticPaths(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'health-os-timeline-'));
  const paths = buildPaths(root);
  fs.mkdirSync(paths.dataDir, { recursive: true, mode: 0o700 });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return paths;
}

function event(eventId, { type = 'symptom', occurred, sourceKind = 'chat', ref = eventId, data = {} }) {
  return {
    schema_version: 1,
    event_id: eventId,
    profile_id: 'synthetic/profile.md',
    event_type: type,
    occurred,
    data,
    source: { kind: sourceKind, ref: `synthetic:${ref}`, fragment_id: '0' },
    extraction_version: 'test-v1',
    epistemic_status: 'fact',
    uncertainty: { level: 'low', note: null },
    status: 'active',
    revision: 1,
    ingested_at: '2026-04-05T10:00:00Z',
    updated_at: '2026-04-05T10:00:00Z'
  };
}

test('timeline joins legacy workout and recovery rows while preserving day precision, blanks, and multiline CSV', (t) => {
  const paths = syntheticPaths(t);
  fs.writeFileSync(paths.workoutSessionsFile,
    `${WORKOUT_HEADERS}\n` +
    'session-1,2026-05-01,A,BASE,FULL,45,7,4,2,true,"Top set felt good\nsecond line with ""quoted"" text"\n');
  fs.writeFileSync(paths.exerciseLogsFile,
    `${EXERCISE_HEADERS}\n` +
    'session-1,2026-05-01,A,squat,Back squat,3,8|8|7,60,60,8,76.00,true,FULL,7,"kept moving"\n');
  fs.writeFileSync(paths.dailyStateFile,
    `${DAILY_HEADERS}\n` +
    '2026-05-01,82,77,,50,0,55,53,2,88,420,0.1,BASE,"normal day",2026-05-01T06:15:00+02:00\n');
  fs.writeFileSync(paths.recoverySnapshotsFile,
    `${SNAPSHOT_HEADERS}\n` +
    '2026-05-01,hrv,,ms,2026-05-01T06:15:00+02:00\n' +
    '2026-05-01,readiness_score,82,score,2026-05-01T06:15:00+02:00\n');

  const result = buildTimeline(paths, { limit: 10 });
  assert.equal(result.matched_count, 2);
  assert.equal(result.omitted_legacy_rows, 0);
  const workout = result.items.find((item) => item.type === 'workout');
  const recovery = result.items.find((item) => item.type === 'recovery');
  assert.equal(workout.occurred.start, '2026-05-01');
  assert.equal(workout.occurred.precision, 'day');
  assert.equal(workout.occurred.timezone, null);
  assert.match(workout.data.session.notes, /second line with "quoted" text/);
  assert.equal(workout.data.session.duration_minutes, 45);
  assert.equal(workout.data.exercises.length, 1);
  assert.equal(workout.source.kind, 'legacy.workout_session');
  assert.match(workout.source.ref, /^workout_sessions\.csv#session_id=/);
  assert.equal(recovery.data.daily_state.hrv, null);
  assert.equal(recovery.data.metrics.find((metric) => metric.metric_name === 'hrv').metric_value, null);
  assert.equal(recovery.source.kind, 'legacy.recovery_day');
  assert.equal(result.source_counts['legacy.workout_session'], 1);
  assert.equal(result.source_counts['legacy.recovery_day'], 1);
});

test('date filtering includes overlapping intervals and sorts offset timestamps by actual chronology', (t) => {
  const paths = syntheticPaths(t);
  const interval = event('00000000-0000-4000-8000-000000000001', {
    occurred: {
      start: '2026-04-04T23:00:00-02:00',
      end: '2026-04-05T02:00:00Z',
      precision: 'interval',
      timezone: null
    },
    sourceKind: 'note',
    data: { duration_minutes: null }
  });
  const earlierInstant = event('00000000-0000-4000-8000-000000000002', {
    occurred: { start: '2026-04-05T09:00:00+03:00', end: null, precision: 'minute', timezone: null },
    sourceKind: 'chat'
  });
  const laterInstant = event('00000000-0000-4000-8000-000000000003', {
    occurred: { start: '2026-04-05T08:30:00+01:00', end: null, precision: 'minute', timezone: null },
    sourceKind: 'chat'
  });
  const dayEvent = event('00000000-0000-4000-8000-000000000004', {
    occurred: { start: '2026-04-05', end: null, precision: 'day', timezone: 'Europe/Warsaw' },
    sourceKind: 'chat'
  });

  const result = buildTimeline(paths, {
    events: [laterInstant, dayEvent, interval, earlierInstant],
    since: '2026-04-05',
    through: '2026-04-05',
    types: ['symptom'],
    limit: 10
  });
  assert.deepEqual(result.items.map((item) => item.id), [
    dayEvent.event_id,
    interval.event_id,
    earlierInstant.event_id,
    laterInstant.event_id
  ]);
  assert.equal(result.items.find((item) => item.id === interval.event_id).occurred.start, '2026-04-04T23:00:00-02:00');
  assert.equal(result.items.find((item) => item.id === dayEvent.event_id).occurred.timezone, 'Europe/Warsaw');

  const sourced = buildTimeline(paths, {
    events: [laterInstant, dayEvent, interval, earlierInstant],
    since: '2026-04-05',
    through: '2026-04-05',
    types: ['symptom'],
    sources: ['note'],
    limit: 10
  });
  assert.deepEqual(sourced.items.map((item) => item.id), [interval.event_id]);
});

test('timeline applies the returned limit deterministically and incorporates bounded EventStore counts', (t) => {
  const paths = syntheticPaths(t);
  const newest = event('00000000-0000-4000-8000-000000000012', {
    occurred: { start: '2026-06-01T14:00:00Z', end: null, precision: 'minute', timezone: null }, sourceKind: 'chat'
  });
  const second = event('00000000-0000-4000-8000-000000000011', {
    occurred: { start: '2026-06-01T09:00:00-02:00', end: null, precision: 'minute', timezone: null }, sourceKind: 'chat'
  });
  const first = event('00000000-0000-4000-8000-000000000010', {
    occurred: { start: '2026-06-01T08:00:00+03:00', end: null, precision: 'minute', timezone: null }, sourceKind: 'chat'
  });
  const result = buildTimeline(paths, {
    events: [newest, second, first],
    event_matched_count: 5,
    event_truncated: true,
    event_source_counts: {
      counts: { chat: 3, note: 0, other: 2 },
      omitted_source_count: 0,
      complete: true
    },
    since: '2026-06-01',
    through: '2026-06-01',
    limit: 2
  });
  assert.deepEqual(result.items.map((item) => item.id), [first.event_id, second.event_id]);
  assert.equal(result.matched_count, 5);
  assert.equal(result.truncated, true);
  assert.equal(result.limit, 2);
  assert.deepEqual(result.source_counts, { chat: 2 });
  assert.deepEqual(result.matched_event_source_counts, { chat: 3, note: 0, other: 2 });
  assert.equal(result.matched_event_source_count_omitted, 0);
  assert.equal(result.matched_event_source_counts_complete, true);
  assert.equal(result.items[0].ingested_at, '2026-04-05T10:00:00Z');
  assert.equal(result.items[0].updated_at, '2026-04-05T10:00:00Z');
});

test('unknown event times remain visible without a date filter and do not match a date interval', (t) => {
  const paths = syntheticPaths(t);
  const unknown = event('00000000-0000-4000-8000-000000000021', {
    occurred: { start: null, end: null, precision: 'unknown', timezone: null },
    data: { quantity: null }
  });
  const all = buildTimeline(paths, { events: [unknown] });
  const dated = buildTimeline(paths, { events: [unknown], since: '2026-06-01', through: '2026-06-30' });
  assert.equal(all.items.length, 1);
  assert.equal(all.items[0].occurred.precision, 'unknown');
  assert.equal(all.items[0].data.quantity, null);
  assert.equal(dated.items.length, 0);
});

test('invalid legacy headers, malformed rows, and invalid dates are counted as omissions', (t) => {
  const paths = syntheticPaths(t);
  fs.writeFileSync(paths.workoutSessionsFile,
    `${WORKOUT_HEADERS}\n` +
    'bad-date,2026-02-30,A,BASE,FULL,40,6,4,1,true,invalid date\n' +
    'malformed,2026-06-02,A,BASE,FULL,40,6,4,1,true,"unfinished\n');
  fs.writeFileSync(paths.exerciseLogsFile, `${EXERCISE_HEADERS}\n`);
  fs.writeFileSync(paths.dailyStateFile, 'wrong,legacy,header\n2026-06-01,row\n');
  fs.writeFileSync(paths.recoverySnapshotsFile,
    `${SNAPSHOT_HEADERS}\n` +
    '2026-13-01,hrv,50,ms,\n');

  const result = buildTimeline(paths);
  assert.equal(result.items.length, 0);
  assert.equal(result.omitted_legacy_rows, 4);
  assert.deepEqual(result.omission_counts, {
    'workout_sessions.csv': 2,
    'daily_state.csv': 1,
    'recovery_snapshots.csv': 1
  });
  assert.ok(result.source_issues.some((issue) => issue.source === 'daily_state.csv' && issue.reason === 'invalid_header'));
});

test('malformed numeric legacy values remain text with an issue instead of becoming zero', (t) => {
  const paths = syntheticPaths(t);
  fs.writeFileSync(paths.workoutSessionsFile,
    `${WORKOUT_HEADERS}\n` +
    'session-2,2026-07-02,B,BASE,LIGHT,forty,6,4,1,true,synthetic\n');
  fs.writeFileSync(paths.exerciseLogsFile, `${EXERCISE_HEADERS}\n`);

  const result = buildTimeline(paths, { types: ['workout'] });
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].data.session.duration_minutes, 'forty');
  assert.deepEqual(result.items[0].data.issues, [
    { field: 'session.duration_minutes', reason: 'invalid_number', value: 'forty' }
  ]);
});

test('timeline bounds long legacy text and oversized per-record collections with truncation metadata', (t) => {
  const paths = syntheticPaths(t);
  fs.writeFileSync(paths.workoutSessionsFile,
    `${WORKOUT_HEADERS}\n` +
    `session-3,2026-07-03,A,BASE,FULL,40,6,4,1,true,${'x'.repeat(3_000)}\n`);
  const exercises = Array.from({ length: 51 }, (_, index) =>
    `session-3,2026-07-03,A,exercise-${index},Synthetic exercise,3,8|8|8,20,20,8,25.33,true,FULL,6,`);
  fs.writeFileSync(paths.exerciseLogsFile, `${EXERCISE_HEADERS}\n${exercises.join('\n')}\n`);

  const result = buildTimeline(paths, { types: ['workout'] });
  const workout = result.items[0];
  assert.equal(workout.data.session.notes.length, 2_000);
  assert.ok(workout.data.exercises.length > 0 && workout.data.exercises.length <= 25);
  assert.equal(workout.data.exercises_truncated, 26);
  assert.equal(result.content_truncated, true);
  assert.equal(result.records_with_truncated_content, 1);
});

test('timeline keeps omission totals exact while bounding the source issue sample', (t) => {
  const paths = syntheticPaths(t);
  const invalidRows = Array.from({ length: 55 }, () => 'not-a-date,82,77,50,50,0,55,53,2,88,420,0.1,BASE,synthetic,');
  fs.writeFileSync(paths.dailyStateFile, `${DAILY_HEADERS}\n${invalidRows.join('\n')}\n`);

  const result = buildTimeline(paths);
  assert.equal(result.omitted_legacy_rows, 55);
  assert.equal(result.omission_counts['daily_state.csv'], 55);
  assert.equal(result.source_issue_count, 55);
  assert.equal(result.source_issues.length, 50);
  assert.equal(result.source_issues_truncated, true);
});

test('large valid events retain complete timeline metadata when their data is clipped', (t) => {
  const paths = syntheticPaths(t);
  const events = Array.from({ length: 3 }, (_, index) => ({
    ...createHealthEvent({
      schema_version: 1,
      event_id: `00000000-0000-4000-8000-00000000003${index}`,
      event_type: 'symptom',
      occurred: {
        start: '2026-08-01T10:00:00.123Z',
        end: null,
        precision: 'instant',
        timezone: null
      },
      data: { note: 'x'.repeat(14_000), quantity: null },
      source: { kind: 'synthetic.chat', ref: `synthetic:${index}:${'r'.repeat(1_880)}`, fragment_id: '0' },
      extraction_version: 'test-v1',
      epistemic_status: 'fact',
      uncertainty: { level: 'medium', note: null }
    }, {
      profileId: 'synthetic/profile.md',
      eventId: `00000000-0000-4000-8000-00000000003${index}`
    }),
    status: 'active',
    revision: 1,
    ingested_at: '2026-08-01T11:00:00Z',
    updated_at: '2026-08-01T11:00:00Z'
  }));

  const result = buildTimeline(paths, { events, types: ['symptom'], limit: 3 });
  assert.equal(result.returned_count, 3);
  assert.equal(result.matched_count, 3);
  assert.deepEqual(result.source_counts, { 'synthetic.chat': 3 });
  assert.equal(result.content_truncated, true);
  for (const [index, item] of result.items.entries()) {
    const sourceEvent = events[index];
    assert.equal(item.id, sourceEvent.event_id);
    assert.equal(item.type, sourceEvent.event_type);
    assert.deepEqual(item.occurred, sourceEvent.occurred);
    assert.deepEqual(item.source, sourceEvent.source);
    assert.equal(item.status, 'active');
    assert.equal(item.revision, 1);
    assert.deepEqual(item.uncertainty, sourceEvent.uncertainty);
    assert.equal(item.ingested_at, '2026-08-01T11:00:00Z');
    assert.equal(item.updated_at, '2026-08-01T11:00:00Z');
    assert.ok(item.data.note.length < sourceEvent.data.note.length);
    assert.equal(item.data_truncated, true);
  }
});

test('same-time tie order matches SQLite bytewise source reference order', (t) => {
  const paths = syntheticPaths(t);
  const references = ['\u{10000}', '\uE000', 'a', 'A'];
  const events = references.map((ref, index) => event(
    `00000000-0000-4000-8000-00000000004${index}`,
    {
      occurred: { start: '2026-09-01T12:00:00Z', end: null, precision: 'instant', timezone: null },
      sourceKind: 'synthetic.tie',
      ref
    }
  ));

  const result = buildTimeline(paths, { events, limit: 2 });
  assert.deepEqual(result.items.map((item) => item.source.ref), ['synthetic:A', 'synthetic:a']);
  assert.equal(result.source_counts['synthetic.tie'], 2);
});

test('source counts safely preserve valid kinds that shadow Object properties', (t) => {
  const paths = syntheticPaths(t);
  const item = event('00000000-0000-4000-8000-000000000051', {
    occurred: { start: '2026-09-02T12:00:00Z', end: null, precision: 'instant', timezone: null },
    sourceKind: 'constructor'
  });

  const result = buildTimeline(paths, { events: [item] });
  assert.deepEqual(result.source_counts, { constructor: 1 });
  assert.equal(Object.getPrototypeOf(result.source_counts), Object.prototype);
});
