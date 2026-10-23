import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { createHealthEvent, validateEventId } from '../src/event-contract.js';
import { buildPaths, repoRoot } from '../src/layout.js';

const PROFILE = 'personal/files/profile.md';
const CLI = path.join(repoRoot(), 'src/cli.js');

function runCli(args, options = {}) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd: repoRoot(), encoding: 'utf8', ...options });
}

function makePaths(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'health-os-event-store-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = buildPaths(root);
  fs.mkdirSync(path.dirname(paths.eventsDbFile), { recursive: true });
  fs.mkdirSync(path.dirname(paths.eventReviewFile), { recursive: true });
  return paths;
}

function event(sourceRef, {
  id = '30000000-0000-4000-8000-000000000001',
  weight = 90,
  type = 'strength.set',
  precision = 'minute',
  start = '2026-10-23T09:00:00+02:00',
  data = { weight_kg: weight }
} = {}) {
  return createHealthEvent({
    schema_version: 1,
    event_id: id,
    event_type: type,
    occurred: { start, end: null, precision, timezone: 'Europe/Warsaw' },
    data,
    source: { kind: 'manual', ref: sourceRef, fragment_id: '0' },
    extraction_version: 'manual-v1',
    epistemic_status: 'fact',
    uncertainty: { level: 'low', note: null }
  }, { profileId: PROFILE });
}

function mutate(paths, options) {
  return import('../src/event-store.js').then(({ mutateEvent }) => mutateEvent(paths, options));
}

test('event occurrence validation preserves date and timezone precision and rejects invalid bounds', () => {
  assert.equal(event('one', { precision: 'day', start: '2026-10-23' }).occurred.timezone, 'Europe/Warsaw');
  assert.equal(event('one', { precision: 'unknown', start: null }).occurred.start, null);
  assert.equal(event('one', { precision: 'second', start: '2026-10-23T09:00:00+14:00' }).occurred.start.endsWith('+14:00'), true);
  assert.equal(event('one', { precision: 'second', start: '2026-10-23T09:00:00-14:00' }).occurred.start.endsWith('-14:00'), true);
  assert.throws(() => event('one', { precision: 'second', start: '2026-10-23T09:00:00+14:01' }), /at most millisecond precision/);
  assert.throws(() => event('one', { precision: 'second', start: '2026-10-23T09:00:00+15:00' }), /at most millisecond precision/);
  assert.throws(() => event('one', { precision: 'second', start: '2026-10-23T09:00:00+23:59' }), /at most millisecond precision/);
  assert.throws(() => event('one', { precision: 'hour', start: '2026-10-23T09:00:00.001+02:00' }), /fractional seconds/);
  assert.throws(() => event('one', { precision: 'instant', start: '2026-10-23T09:00:00.0001+02:00' }), /at most millisecond precision/);
  assert.throws(() => createHealthEvent({
    schema_version: 1,
    event_type: 'strength.set',
    occurred: { start: '2026-10-24', end: '2026-10-23', precision: 'interval', timezone: null },
    data: {}, source: { kind: 'manual', ref: 'one' }, extraction_version: 'manual-v1',
    epistemic_status: 'fact', uncertainty: { level: 'unknown' }
  }, { profileId: PROFILE }), /start must not be after end/);
});

test('event UUIDs are canonicalized and arbitrary JSON data keys survive storage', async (t) => {
  const paths = makePaths(t);
  const { mutateEvent, queryEventById } = await import('../src/event-store.js');
  const data = JSON.parse('{"__proto__":{"preserved":true},"weight_kg":90}');
  const created = event('upper-uuid', { id: '30000000-0000-4000-8000-0000000000AA', data });
  assert.equal(created.event_id, created.event_id.toLowerCase());
  assert.equal(validateEventId('30000000-0000-4000-8000-0000000000AA'), created.event_id);
  mutateEvent(paths, { action: 'context-add', key: 'upper-uuid', request: { event: created }, event: created, profileId: PROFILE });
  const restored = queryEventById(paths, PROFILE, created.event_id);
  assert.equal(restored.event_id, created.event_id);
  assert.equal(Object.hasOwn(restored.data, '__proto__'), true);
  assert.deepEqual(restored.data.__proto__, { preserved: true });
});

test('capture identity deduplicates same content while generated ingestion metadata stays outside the digest', async (t) => {
  const paths = makePaths(t);
  const { mutateEvent, queryEventById } = await import('../src/event-store.js');
  const firstEvent = event('message-1');
  const request = { command: 'context-add', payload: { source: firstEvent.source, weight: 90 } };
  const first = mutateEvent(paths, { action: 'context-add', key: 'first-key', request, event: firstEvent, profileId: PROFILE });
  const duplicate = mutateEvent(paths, {
    action: 'context-add', key: 'second-key', request: { ...request, retry: 1 },
    event: event('message-1', { id: '30000000-0000-4000-8000-000000000002' }), profileId: PROFILE
  });
  assert.equal(first.status, 'created');
  assert.equal(duplicate.status, 'duplicate');
  assert.equal(duplicate.event.event_id, firstEvent.event_id);
  assert.equal(typeof queryEventById(paths, PROFILE, firstEvent.event_id).ingested_at, 'string');
  assert.equal(typeof queryEventById(paths, PROFILE, firstEvent.event_id).updated_at, 'string');
});

test('separate workspaces keep event rows independent even with matching capture references', async (t) => {
  const firstPaths = makePaths(t);
  const secondPaths = makePaths(t);
  const { mutateEvent, queryEvents } = await import('../src/event-store.js');
  const firstEvent = event('same-message', { weight: 60 });
  const secondEvent = event('same-message', { id: '30000000-0000-4000-8000-000000000002', weight: 80 });
  mutateEvent(firstPaths, { action: 'context-add', key: 'same-capture', request: { event: firstEvent }, event: firstEvent, profileId: PROFILE });
  mutateEvent(secondPaths, { action: 'context-add', key: 'same-capture', request: { event: secondEvent }, event: secondEvent, profileId: PROFILE });
  assert.equal(queryEvents(firstPaths, PROFILE).events[0].data.weight_kg, 60);
  assert.equal(queryEvents(secondPaths, PROFILE).events[0].data.weight_kg, 80);
});

test('old capture and idempotency replay follow supersession to replacement and then tombstone', async (t) => {
  const paths = makePaths(t);
  const { mutateEvent } = await import('../src/event-store.js');
  const oldEvent = event('source-old');
  const oldRequest = { command: 'context-add', event: oldEvent };
  mutateEvent(paths, { action: 'context-add', key: 'old-add', request: oldRequest, event: oldEvent, profileId: PROFILE });

  const replacement = event('source-new', { id: '30000000-0000-4000-8000-000000000002', weight: 95 });
  const replacementRequest = { command: 'context-add', event: replacement, supersedes: oldEvent.event_id, expected_revision: 1 };
  const superseded = mutateEvent(paths, {
    action: 'context-add', key: 'replacement-add', request: replacementRequest, event: replacement,
    profileId: PROFILE, supersedesEventId: oldEvent.event_id, expectedRevision: 1
  });
  assert.equal(superseded.event.event_id, replacement.event_id);

  const oldKeyReplay = mutateEvent(paths, { action: 'context-add', key: 'old-add', request: oldRequest, event: oldEvent, profileId: PROFILE });
  const newKeyOldCapture = mutateEvent(paths, {
    action: 'context-add', key: 'old-capture-retry', request: { ...oldRequest, retry: true }, event: oldEvent, profileId: PROFILE
  });
  assert.equal(oldKeyReplay.event.event_id, replacement.event_id);
  assert.equal(newKeyOldCapture.status, 'superseded_replay');
  assert.equal(newKeyOldCapture.event.event_id, replacement.event_id);
  assert.equal(newKeyOldCapture.event.data.weight_kg, 95);

  const deleted = mutateEvent(paths, {
    action: 'context-delete', key: 'delete-replacement', request: { event_id: replacement.event_id, expected_revision: 1 },
    eventId: replacement.event_id, profileId: PROFILE, expectedRevision: 1
  });
  assert.equal(deleted.event.status, 'deleted');
  const oldCaptureAfterDelete = mutateEvent(paths, {
    action: 'context-add', key: 'old-capture-after-delete', request: { ...oldRequest, after_delete: true }, event: oldEvent, profileId: PROFILE
  });
  assert.deepEqual(oldCaptureAfterDelete.event, {
    event_id: replacement.event_id, profile_id: PROFILE, status: 'deleted', revision: 2
  });
  assert.equal(oldCaptureAfterDelete.status, 'tombstone');
  const oldKeyAfterDelete = mutateEvent(paths, { action: 'context-add', key: 'old-add', request: oldRequest, event: oldEvent, profileId: PROFILE });
  assert.equal(oldKeyAfterDelete.status, 'replayed');
  assert.deepEqual(oldKeyAfterDelete.event, oldCaptureAfterDelete.event);
  assert.equal(Object.hasOwn(oldKeyAfterDelete.event, 'data'), false);
});

test('correction uses optimistic revision and derived memory remains blocked until generation review', async (t) => {
  const paths = makePaths(t);
  const { mutateEvent, assertEventMemoryReviewMatchesStore, revalidateEventMemory } = await import('../src/event-store.js');
  const original = event('source-correct');
  mutateEvent(paths, { action: 'context-add', key: 'add-correct', request: { add: original }, event: original, profileId: PROFILE });
  const corrected = event('source-correct', { id: original.event_id, weight: 92 });
  const correction = mutateEvent(paths, {
    action: 'context-correct', key: 'correct-v1', request: { event: corrected, expected_revision: 1 },
    event: corrected, eventId: original.event_id, profileId: PROFILE, expectedRevision: 1
  });
  assert.equal(correction.event.revision, 2);
  assert.throws(() => mutateEvent(paths, {
    action: 'context-correct', key: 'stale-correct', request: { event: original, expected_revision: 1 },
    event: original, eventId: original.event_id, profileId: PROFILE, expectedRevision: 1
  }), { code: 'HEALTH_OS_EVENT_REVISION_CONFLICT' });
  assert.throws(() => assertEventMemoryReviewMatchesStore(paths), { code: 'HEALTH_OS_MEMORY_REVALIDATION_REQUIRED' });
  const reviewed = revalidateEventMemory(paths, 2);
  assert.equal(reviewed.reviewed_generation, 2);
  assert.equal(assertEventMemoryReviewMatchesStore(paths).pending, false);
});

test('review refuses deleted or stale provenance until every page is updated', async (t) => {
  const paths = makePaths(t);
  const { mutateEvent, revalidateEventMemory } = await import('../src/event-store.js');
  fs.mkdirSync(paths.memoryWikiDir, { recursive: true });
  const original = event('source-memory');
  mutateEvent(paths, { action: 'context-add', key: 'memory-add', request: { event: original }, event: original, profileId: PROFILE });
  const page = path.join(paths.memoryWikiDir, 'synthetic.md');
  fs.writeFileSync(page, `# Synthetic\n\nhealth-event:${original.event_id}@1\n`);

  const corrected = event('source-memory', { id: original.event_id, weight: 92 });
  mutateEvent(paths, {
    action: 'context-correct', key: 'memory-correct', request: { event: corrected, expected_revision: 1 },
    event: corrected, eventId: original.event_id, profileId: PROFILE, expectedRevision: 1
  });
  assert.throws(() => revalidateEventMemory(paths, 2), { code: 'HEALTH_OS_MEMORY_EVENT_PROVENANCE_STALE' });
  fs.writeFileSync(page, `# Synthetic\n\nhealth-event:${original.event_id.toUpperCase()}@2\n`);
  assert.equal(revalidateEventMemory(paths, 2).reviewed_generation, 2);

  mutateEvent(paths, {
    action: 'context-delete', key: 'memory-delete', request: { event_id: original.event_id, expected_revision: 2 },
    eventId: original.event_id, profileId: PROFILE, expectedRevision: 2
  });
  assert.throws(() => revalidateEventMemory(paths, 3), { code: 'HEALTH_OS_MEMORY_EVENT_PROVENANCE_STALE' });
});

test('review state reconciles from SQLite after a failed post-marker correction', async (t) => {
  const paths = makePaths(t);
  const { DatabaseSync } = await import('node:sqlite');
  const { mutateEvent, assertEventMemoryReviewMatchesStore, revalidateEventMemory } = await import('../src/event-store.js');
  const original = event('source-interrupted');
  mutateEvent(paths, { action: 'context-add', key: 'interrupt-add', request: { event: original }, event: original, profileId: PROFILE });
  revalidateEventMemory(paths, 1);

  const db = new DatabaseSync(paths.eventsDbFile);
  db.exec(`CREATE TRIGGER fail_health_event_update BEFORE UPDATE ON health_events
    BEGIN SELECT RAISE(ABORT, 'synthetic failure after review marker'); END`);
  db.close();
  const corrected = event('source-interrupted', { id: original.event_id, weight: 91 });
  assert.throws(() => mutateEvent(paths, {
    action: 'context-correct', key: 'interrupt-correction', request: { event: corrected, expected_revision: 1 },
    event: corrected, eventId: original.event_id, profileId: PROFILE, expectedRevision: 1
  }), { code: 'HEALTH_OS_EVENT_STORE_INVALID' });

  const recovered = revalidateEventMemory(paths, 1);
  assert.equal(recovered.recovered_interrupted_write, true);
  assert.equal(assertEventMemoryReviewMatchesStore(paths).pending, false);
  const state = JSON.parse(fs.readFileSync(paths.eventReviewFile, 'utf8'));
  assert.deepEqual(state.changed_events.map(({ event_id, revision, status }) => ({ event_id, revision, status })), [
    { event_id: original.event_id, revision: 1, status: 'active' }
  ]);
});

test('read-only query of a missing event store does not create workspace files', async (t) => {
  const paths = makePaths(t);
  fs.rmSync(paths.trackerRoot, { recursive: true, force: true });
  const { queryEvents } = await import('../src/event-store.js');
  const result = queryEvents(paths, PROFILE, { limit: 10 });
  assert.deepEqual(result.events, []);
  assert.equal(fs.existsSync(paths.trackerRoot), false);
});

test('event database is created owner-only under a permissive umask', async (t) => {
  const paths = makePaths(t);
  const { mutateEvent } = await import('../src/event-store.js');
  const previous = process.umask(0o022);
  t.after(() => process.umask(previous));
  const firstEvent = event('secure-db');
  mutateEvent(paths, { action: 'context-add', key: 'secure-add', request: { add: firstEvent }, event: firstEvent, profileId: PROFILE });
  const mode = fs.statSync(paths.eventsDbFile).mode & 0o777;
  assert.equal(mode, 0o600);
});

test('CLI event JSON uses stdin, canonical UUIDs, optimistic edits, and memory replay invalidation', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'health-os-event-store-cli-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'workspace');
  assert.equal(runCli(['init-workspace', '--workspace', workspace]).status, 0);
  const profileFile = path.join(workspace, '.health-os/personal/files/profile.md');
  fs.writeFileSync(profileFile, fs.readFileSync(path.join(repoRoot(), 'templates/personal-profile.md')));

  const uppercaseId = '30000000-0000-4000-8000-0000000000AA';
  const input = {
    schema_version: 1, event_id: uppercaseId, event_type: 'strength.set',
    occurred: { start: '2026-10-23T09:00:00+02:00', end: null, precision: 'minute', timezone: 'Europe/Warsaw' },
    data: JSON.parse('{"__proto__":{"preserved":true},"exercise":"squat","weight_kg":90}'),
    source: { kind: 'manual', ref: 'cli-test-message', fragment_id: '0' },
    extraction_version: 'manual-v1', epistemic_status: 'fact', uncertainty: { level: 'low', note: null }
  };
  const added = runCli([
    'context-add', '--json', '--input-json', '--workspace', workspace, '--idempotency-key', 'cli-add'
  ], { input: JSON.stringify(input) });
  assert.equal(added.status, 0, added.stdout);
  if (added.stderr) assert.match(added.stderr, /ExperimentalWarning: SQLite is an experimental feature/);
  const addedEnvelope = JSON.parse(added.stdout);
  const eventId = addedEnvelope.data.event.event_id;
  assert.equal(eventId, uppercaseId.toLowerCase());

  const query = runCli(['context-query', '--json', '--workspace', workspace, '--event-id', uppercaseId]);
  assert.equal(query.status, 0, query.stdout);
  const queried = JSON.parse(query.stdout).data.events[0];
  assert.equal(queried.event_id, eventId);
  assert.deepEqual(queried.data.__proto__, { preserved: true });

  const pending = runCli([
    'memory-context', '--json', '--workspace', workspace, '--query', 'squat', '--idempotency-key', 'cached-memory'
  ]);
  assert.equal(pending.status, 1);
  assert.equal(JSON.parse(pending.stdout).error.code, 'HEALTH_OS_MEMORY_REVALIDATION_REQUIRED');
  const reviewed = runCli(['context-revalidate-memory', '--json', '--workspace', workspace, '--generation', '1']);
  assert.equal(reviewed.status, 0, reviewed.stdout);

  const wiki = path.join(workspace, '.health-os/memory/wiki/synthetic.md');
  fs.writeFileSync(wiki, [
    '---', 'title: Synthetic squat note', 'status: observation', 'confidence: low',
    'evidence_start: 2026-10-23', 'evidence_end: 2026-10-23', 'last_reviewed: 2026-10-23',
    'provenance: []', 'human_confirmed: false', '---', '',
    `Observed squat load. health-event:${eventId}@1`, ''
  ].join('\n'));
  const cached = runCli([
    'memory-context', '--json', '--workspace', workspace, '--query', 'squat', '--idempotency-key', 'cached-memory'
  ]);
  assert.equal(cached.status, 0, cached.stdout);

  const corrected = { ...input, data: { exercise: 'squat', weight_kg: 95 } };
  const correction = runCli([
    'context-correct', '--json', '--input-json', '--workspace', workspace, '--event-id', eventId,
    '--expected-revision', '1', '--idempotency-key', 'cli-correct'
  ], { input: JSON.stringify(corrected) });
  assert.equal(correction.status, 0, correction.stdout);
  const staleCache = runCli([
    'memory-context', '--json', '--workspace', workspace, '--query', 'squat', '--idempotency-key', 'cached-memory'
  ]);
  assert.equal(staleCache.status, 1);
  assert.equal(JSON.parse(staleCache.stdout).error.code, 'HEALTH_OS_MEMORY_REVALIDATION_REQUIRED');
});

test('event type filters union configured types and prefixes before timestamp cutoff and limit', async (t) => {
  const paths = makePaths(t);
  const { mutateEvent, queryEvents } = await import('../src/event-store.js');
  const records = [
    event('configured-checkin', {
      id: '30000000-0000-4000-8000-000000000011', type: 'recovery.checkin',
      start: '2026-10-23T09:00:00Z', precision: 'minute'
    }),
    event('subjective-energy', {
      id: '30000000-0000-4000-8000-000000000012', type: 'subjective.energy',
      start: '2026-10-23T10:00:00Z', precision: 'minute'
    }),
    event('future-subjective', {
      id: '30000000-0000-4000-8000-000000000013', type: 'subjective.energy',
      start: '2026-10-23T11:00:00Z', precision: 'minute'
    })
  ];
  for (const [index, item] of records.entries()) {
    mutateEvent(paths, {
      action: 'context-add', key: `type-filter-${index}`, request: { event: item }, event: item, profileId: PROFILE
    });
  }

  const result = queryEvents(paths, PROFILE, {
    types: ['recovery.checkin'], typePrefixes: ['subjective.'],
    asOfTimestamp: '2026-10-23T10:30:00Z', limit: 1
  });
  assert.equal(result.matched_count, 2);
  assert.equal(result.truncated, true);
  assert.deepEqual(result.events.map((item) => item.event_type), ['subjective.energy']);
  assert.throws(() => queryEvents(paths, PROFILE, { types: 'recovery.checkin' }), /types must be an array/);
});
