import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

import { atomicWriteFileSync } from './coordination.js';
import { stableJson } from './cli-contract.js';
import { eventSourceIdentity, isValidOccurrenceBound } from './event-contract.js';
import { findStaleEventProvenance, readEventReviewState } from './event-memory-review.js';

export const EVENT_STORE_SCHEMA_VERSION = 1;

function eventError(code, message) {
  return Object.assign(new Error(message), { code });
}

function hash(value) {
  return createHash('sha256').update(value).digest('hex');
}

function eventDigest(event) {
  return hash(stableJson({
    schema_version: event.schema_version,
    event_type: event.event_type,
    occurred: event.occurred,
    data: event.data,
    source: event.source,
    extraction_version: event.extraction_version,
    epistemic_status: event.epistemic_status,
    uncertainty: event.uncertainty
  }));
}

function readJsonField(value, label) {
  try {
    return JSON.parse(value);
  } catch {
    throw eventError('HEALTH_OS_EVENT_STORE_INVALID', `Invalid ${label} JSON in the event store`);
  }
}

function rowToEvent(row) {
  if (!row) return null;
  if (row.status === 'deleted') {
    return {
      event_id: row.event_id,
      profile_id: row.profile_id,
      status: 'deleted',
      revision: row.revision
    };
  }
  return {
    schema_version: EVENT_STORE_SCHEMA_VERSION,
    event_id: row.event_id,
    profile_id: row.profile_id,
    event_type: row.event_type,
    occurred: readJsonField(row.occurred_json, 'occurred'),
    data: readJsonField(row.data_json, 'data'),
    source: readJsonField(row.source_json, 'source'),
    extraction_version: row.extraction_version,
    epistemic_status: row.epistemic_status,
    uncertainty: readJsonField(row.uncertainty_json, 'uncertainty'),
    status: row.status,
    revision: row.revision,
    ingested_at: row.created_at,
    updated_at: row.updated_at,
    ...(row.superseded_by_event_id ? { superseded_by_event_id: row.superseded_by_event_id } : {})
  };
}

function databaseError(error) {
  if (error?.code?.startsWith('HEALTH_OS_')) return error;
  return eventError('HEALTH_OS_EVENT_STORE_INVALID', `Event store operation failed: ${error?.message || 'unknown database error'}`);
}

function assertSchema(db) {
  try {
    const version = db.prepare('PRAGMA user_version').get().user_version;
    if (version !== EVENT_STORE_SCHEMA_VERSION) {
      throw eventError('HEALTH_OS_EVENT_STORE_VERSION_UNSUPPORTED', `Unsupported event-store schema version ${version}; supported version is ${EVENT_STORE_SCHEMA_VERSION}`);
    }
    db.prepare('SELECT key, value FROM event_meta LIMIT 1').get();
    db.prepare('SELECT event_id, status, revision FROM health_events LIMIT 1').get();
    db.prepare('SELECT source_key, event_id FROM event_captures LIMIT 1').get();
    db.prepare('SELECT key_hash, request_digest, event_id FROM event_requests LIMIT 1').get();
    db.prepare('SELECT event_id, revision, digest FROM event_revisions LIMIT 1').get();
  } catch (error) {
    if (error?.code?.startsWith('HEALTH_OS_')) throw error;
    throw eventError('HEALTH_OS_EVENT_STORE_INVALID', `Event store schema is invalid: ${error.message}`);
  }
}

function openReadOnly(paths) {
  if (!fs.existsSync(paths.eventsDbFile)) return null;
  let db;
  try {
    db = new DatabaseSync(paths.eventsDbFile, { readOnly: true });
    assertSchema(db);
    return db;
  } catch (error) {
    db?.close();
    throw databaseError(error);
  }
}

function openWritable(paths) {
  fs.mkdirSync(path.dirname(paths.eventsDbFile), { recursive: true, mode: 0o700 });
  const fileExists = fs.existsSync(paths.eventsDbFile);
  const initialize = !fileExists || fs.statSync(paths.eventsDbFile).size === 0;
  if (!fileExists) {
    const descriptor = fs.openSync(paths.eventsDbFile, 'wx', 0o600);
    fs.closeSync(descriptor);
  } else if (!initialize) {
    const check = new DatabaseSync(paths.eventsDbFile, { readOnly: true });
    try { assertSchema(check); } finally { check.close(); }
  }
  try {
    // SQLite derives WAL/SHM permissions from the database mode, so secure the
    // database before it opens or creates those sidecars.
    fs.chmodSync(paths.eventsDbFile, 0o600);
  } catch (error) {
    if (error.code !== 'ENOSYS' && error.code !== 'ENOTSUP') {
      throw eventError('HEALTH_OS_EVENT_STORE_PERMISSIONS', `Cannot secure event-store file permissions: ${error.message}`);
    }
  }
  const db = new DatabaseSync(paths.eventsDbFile);
  try {
    if (initialize) {
      db.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA foreign_keys = ON;
        CREATE TABLE event_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE health_events (
          event_id TEXT PRIMARY KEY,
          profile_id TEXT NOT NULL,
          event_type TEXT,
          occurred_json TEXT,
          data_json TEXT,
          source_json TEXT,
          extraction_version TEXT,
          epistemic_status TEXT,
          uncertainty_json TEXT,
          status TEXT NOT NULL CHECK(status IN ('active','superseded','deleted')),
          superseded_by_event_id TEXT,
          revision INTEGER NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX health_events_profile_state ON health_events(profile_id, status, event_type);
        CREATE TABLE event_captures (
          source_key TEXT PRIMARY KEY,
          event_id TEXT NOT NULL
        );
        CREATE TABLE event_requests (
          key_hash TEXT PRIMARY KEY,
          request_digest TEXT NOT NULL,
          event_id TEXT NOT NULL,
          action TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE TABLE event_revisions (
          event_id TEXT NOT NULL,
          revision INTEGER NOT NULL,
          digest TEXT NOT NULL,
          action TEXT NOT NULL,
          created_at TEXT NOT NULL,
          PRIMARY KEY(event_id, revision)
        );
      `);
      db.prepare('INSERT INTO event_meta(key, value) VALUES (?, ?)').run('store_id', randomUUID());
      db.prepare('INSERT INTO event_meta(key, value) VALUES (?, ?)').run('generation', '0');
      db.exec(`PRAGMA user_version = ${EVENT_STORE_SCHEMA_VERSION}`);
    } else {
      assertSchema(db);
    }
    db.exec('PRAGMA foreign_keys = ON');
    return db;
  } catch (error) {
    db.close();
    throw databaseError(error);
  }
}

function getMeta(db, key) {
  const row = db.prepare('SELECT value FROM event_meta WHERE key = ?').get(key);
  return row?.value;
}

export function readEventStoreStatus(paths) {
  const db = openReadOnly(paths);
  if (!db) return { exists: false, store_id: null, generation: 0 };
  try {
    const storeId = getMeta(db, 'store_id');
    const generation = Number(getMeta(db, 'generation'));
    if (typeof storeId !== 'string' || !Number.isSafeInteger(generation) || generation < 0) {
      throw eventError('HEALTH_OS_EVENT_STORE_INVALID', 'Event store metadata is invalid');
    }
    return { exists: true, store_id: storeId, generation };
  } finally {
    db.close();
  }
}

function readReviewState(paths, storeId, generation, { reconcileAhead = false, db } = {}) {
  if (!fs.existsSync(paths.eventReviewFile)) {
    if (generation !== 0) {
      throw eventError('HEALTH_OS_EVENT_REVIEW_STATE_MISSING', 'Event changes exist without derived-memory review state; memory stays blocked until the workspace is reconciled');
    }
    return {
      schema_version: 1,
      store_id: storeId,
      reviewed_generation: 0,
      required_generation: 0,
      pending: false,
      changed_events: []
    };
  }
  let state;
  try {
    state = JSON.parse(fs.readFileSync(paths.eventReviewFile, 'utf8'));
  } catch {
    throw eventError('HEALTH_OS_EVENT_REVIEW_STATE_INVALID', 'Derived-memory event review state is unreadable; memory stays blocked');
  }
  if (!state || state.schema_version !== 1 || state.store_id !== storeId ||
      !Number.isSafeInteger(state.reviewed_generation) || !Number.isSafeInteger(state.required_generation) ||
      state.reviewed_generation < 0 || state.required_generation < state.reviewed_generation ||
      typeof state.pending !== 'boolean' || !Array.isArray(state.changed_events)) {
    throw eventError('HEALTH_OS_EVENT_REVIEW_STATE_INVALID', 'Derived-memory event review state is inconsistent with the event store');
  }
  const changedIds = new Set();
  for (const item of state.changed_events) {
    if (!item || typeof item.event_id !== 'string' || typeof item.profile_id !== 'string' ||
        !Number.isSafeInteger(item.revision) || item.revision < 1 ||
        !['active', 'superseded', 'deleted'].includes(item.status) ||
        !Number.isSafeInteger(item.generation) || item.generation < 1 || item.generation > state.required_generation ||
        changedIds.has(item.event_id)) {
      throw eventError('HEALTH_OS_EVENT_REVIEW_STATE_INVALID', 'Derived-memory event review state contains malformed or duplicate event rows');
    }
    changedIds.add(item.event_id);
  }
  if (state.required_generation < generation) {
    throw eventError('HEALTH_OS_EVENT_REVIEW_STATE_INVALID', 'Event store is newer than its derived-memory review state; memory stays blocked');
  }
  if (state.required_generation > generation + 1) {
    throw eventError('HEALTH_OS_EVENT_REVIEW_STATE_INVALID', 'Event review state is ahead of the event store by more than one uncommitted operation');
  }
  if (state.required_generation === generation + 1) {
    if (reconcileAhead) {
      if (!db) {
        throw eventError('HEALTH_OS_EVENT_REVIEW_STATE_INVALID', 'Cannot reconcile an interrupted event review without reading the event database');
      }
      const previous = new Map(state.changed_events.map((item) => [item.event_id, item]));
      state.changed_events = db.prepare('SELECT event_id, profile_id, status, revision FROM health_events ORDER BY event_id').all()
        .map((row) => ({
          event_id: row.event_id,
          profile_id: row.profile_id,
          status: row.status,
          revision: row.revision,
          generation: Math.min(generation, previous.get(row.event_id)?.generation || generation)
        }));
      state.required_generation = generation;
      state.pending = state.reviewed_generation < generation;
      atomicWriteFileSync(paths.eventReviewFile, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    }
  }
  return state;
}

function assertRowsMatchReview(db, review, generation) {
  const reviewRows = review.changed_events.filter((item) => item.generation <= generation);
  const reviewById = new Map(reviewRows.map((item) => [item.event_id, item]));
  const dbRows = db.prepare('SELECT event_id, profile_id, status, revision FROM health_events ORDER BY event_id').all();
  if (dbRows.length !== reviewById.size) {
    throw eventError('HEALTH_OS_EVENT_REVIEW_STATE_INVALID', 'Derived-memory review state does not list the current event-store rows');
  }
  for (const row of dbRows) {
    const item = reviewById.get(row.event_id);
    if (!item || item.profile_id !== row.profile_id || item.status !== row.status || item.revision !== row.revision) {
      throw eventError('HEALTH_OS_EVENT_REVIEW_STATE_INVALID', `Derived-memory review state does not match event ${row.event_id}`);
    }
  }
}

export function assertEventMemoryReviewMatchesStore(paths, { allowPending = false } = {}) {
  const status = readEventStoreStatus(paths);
  const review = readEventReviewState(paths, { allowPending });
  if (!status.exists) {
    if (review) {
      throw eventError('HEALTH_OS_EVENT_STORE_MISSING', 'The event store is missing but derived-memory review state records event history; memory stays blocked');
    }
    return review;
  }
  if (!review || review.store_id !== status.store_id) {
    throw eventError('HEALTH_OS_EVENT_REVIEW_STATE_INVALID', 'Event store identity does not match derived-memory review state');
  }
  const precommit = review.pending && review.required_generation === status.generation + 1;
  const committedPending = review.pending && review.required_generation === status.generation && review.reviewed_generation < status.generation;
  const current = !review.pending && review.required_generation === status.generation && review.reviewed_generation === status.generation;
  if (!precommit && !committedPending && !current) {
    throw eventError('HEALTH_OS_EVENT_REVIEW_STATE_INVALID', 'Event generation does not match derived-memory review state');
  }
  if (!precommit) {
    const db = openReadOnly(paths);
    try { assertRowsMatchReview(db, review, status.generation); }
    finally { db.close(); }
  }
  return review;
}

function writeReviewState(paths, state) {
  atomicWriteFileSync(paths.eventReviewFile, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
}

function storeEventRow(db, event, status, revision, supersededBy = null, at = new Date().toISOString()) {
  db.prepare(`
    INSERT INTO health_events(
      event_id, profile_id, event_type, occurred_json, data_json, source_json,
      extraction_version, epistemic_status, uncertainty_json, status,
      superseded_by_event_id, revision, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    event.event_id,
    event.profile_id,
    event.event_type,
    JSON.stringify(event.occurred),
    JSON.stringify(event.data),
    JSON.stringify(event.source),
    event.extraction_version,
    event.epistemic_status,
    JSON.stringify(event.uncertainty),
    status,
    supersededBy,
    revision,
    at,
    at
  );
}

function eventById(db, eventId) {
  return db.prepare('SELECT * FROM health_events WHERE event_id = ?').get(eventId) || null;
}

function recordRevision(db, eventId, revision, digest, action, at) {
  db.prepare('INSERT INTO event_revisions(event_id, revision, digest, action, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(eventId, revision, digest, action, at);
}

function resolveLatestEvent(db, eventId) {
  const visited = new Set();
  let row = eventById(db, eventId);
  while (row?.status === 'superseded') {
    if (visited.has(row.event_id) || !row.superseded_by_event_id) {
      throw eventError('HEALTH_OS_EVENT_STORE_INVALID', `Supersession chain for event ${row.event_id} is invalid`);
    }
    visited.add(row.event_id);
    row = eventById(db, row.superseded_by_event_id);
  }
  if (!row) throw eventError('HEALTH_OS_EVENT_STORE_INVALID', `Event ${eventId} references a missing superseding event`);
  return row;
}

function existingRequest(db, keyHash, requestDigest) {
  const request = db.prepare('SELECT * FROM event_requests WHERE key_hash = ?').get(keyHash);
  if (!request) return null;
  if (request.request_digest !== requestDigest) {
    throw eventError('HEALTH_OS_IDEMPOTENCY_CONFLICT', 'idempotency key was already used for a different event request');
  }
  return { request, event: rowToEvent(resolveLatestEvent(db, request.event_id)) };
}

function updateReviewBeforeCommit(paths, db, generation, changedEvents) {
  const storeId = getMeta(db, 'store_id');
  const state = readReviewState(paths, storeId, generation, { reconcileAhead: true, db });
  assertRowsMatchReview(db, state, generation);
  const nextGeneration = generation + 1;
  const changes = new Map(state.changed_events.map((item) => [item.event_id, item]));
  for (const change of changedEvents) {
    changes.set(change.event_id, { ...change, generation: nextGeneration });
  }
  const nextState = {
    schema_version: 1,
    store_id: storeId,
    reviewed_generation: state.reviewed_generation,
    required_generation: nextGeneration,
    pending: true,
    changed_events: [...changes.values()]
  };
  writeReviewState(paths, nextState);
  db.prepare('UPDATE event_meta SET value = ? WHERE key = ?').run(String(nextGeneration), 'generation');
  return nextGeneration;
}

function saveRequest(db, keyHash, digest, eventId, action, at) {
  db.prepare('INSERT INTO event_requests(key_hash, request_digest, event_id, action, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(keyHash, digest, eventId, action, at);
}

function saveDuplicateRequest(db, keyHash, digest, eventId, action, at) {
  saveRequest(db, keyHash, digest, eventId, action, at);
}

function activeError(eventId, action) {
  return eventError('HEALTH_OS_EVENT_STATE_CONFLICT', `Cannot ${action} event ${eventId} because it is deleted or superseded`);
}

function operationRequestDigest(request) {
  return hash(stableJson(request));
}

function sourceKey(event) {
  return hash(eventSourceIdentity(event));
}

function contentMatches(row, event) {
  return row && row.status !== 'deleted' && eventDigest(rowToEvent(row)) === eventDigest(event);
}

/** Apply one event mutation. The caller holds the shared workspace lock. */
export function mutateEvent(paths, { action, key, request, event, eventId, profileId, supersedesEventId, expectedRevision }) {
  const digest = operationRequestDigest(request);
  const keyHash = hash(key);
  const db = openWritable(paths);
  let transaction = false;
  try {
    db.exec('BEGIN IMMEDIATE');
    transaction = true;
    const currentGeneration = Number(getMeta(db, 'generation'));
    const replay = existingRequest(db, keyHash, digest);
    if (replay) {
      db.exec('COMMIT');
      transaction = false;
      return { status: 'replayed', event: replay.event, generation: currentGeneration };
    }

    const at = new Date().toISOString();
    if (action === 'context-add') {
      const identityKey = sourceKey(event);
      const capture = db.prepare('SELECT event_id FROM event_captures WHERE source_key = ?').get(identityKey);
      if (capture) {
        const existing = eventById(db, capture.event_id);
        const latest = resolveLatestEvent(db, capture.event_id);
        if (latest.status === 'deleted') {
          saveDuplicateRequest(db, keyHash, digest, capture.event_id, action, at);
          db.exec('COMMIT');
          transaction = false;
          return { status: 'tombstone', event: rowToEvent(latest), generation: currentGeneration };
        }
        if (existing?.status === 'superseded') {
          if (!contentMatches(existing, event)) {
            throw eventError('HEALTH_OS_EVENT_CAPTURE_CONFLICT', 'This source and fragment already identify a different event; use context-correct or choose a new source fragment');
          }
          saveDuplicateRequest(db, keyHash, digest, capture.event_id, action, at);
          db.exec('COMMIT');
          transaction = false;
          return { status: 'superseded_replay', event: rowToEvent(latest), generation: currentGeneration };
        }
        if (!contentMatches(existing, event)) {
          throw eventError('HEALTH_OS_EVENT_CAPTURE_CONFLICT', 'This source and fragment already identify a different event; use context-correct or choose a new source fragment');
        }
        saveDuplicateRequest(db, keyHash, digest, capture.event_id, action, at);
        db.exec('COMMIT');
        transaction = false;
        return { status: 'duplicate', event: rowToEvent(existing), generation: currentGeneration };
      }
      if (eventById(db, event.event_id)) {
        throw eventError('HEALTH_OS_EVENT_ID_CONFLICT', `Event id ${event.event_id} already exists`);
      }

      let supersededRow = null;
      if (supersedesEventId) {
        supersededRow = eventById(db, supersedesEventId);
        if (!supersededRow || supersededRow.profile_id !== event.profile_id || supersededRow.status !== 'active') {
          throw activeError(supersedesEventId, 'supersede');
        }
        if (supersededRow.revision !== expectedRevision) {
          throw eventError('HEALTH_OS_EVENT_REVISION_CONFLICT', `Event ${supersedesEventId} is at revision ${supersededRow.revision}, not expected revision ${expectedRevision}`);
        }
      }

      updateReviewBeforeCommit(paths, db, currentGeneration, [
        ...(supersededRow ? [{ event_id: supersedesEventId, profile_id: supersededRow.profile_id, revision: supersededRow.revision + 1, status: 'superseded' }] : []),
        { event_id: event.event_id, profile_id: event.profile_id, revision: 1, status: 'active' }
      ]);
      storeEventRow(db, event, 'active', 1, null, at);
      db.prepare('INSERT INTO event_captures(source_key, event_id) VALUES (?, ?)').run(identityKey, event.event_id);
      recordRevision(db, event.event_id, 1, eventDigest(event), action, at);
      if (supersededRow) {
        db.prepare(`UPDATE health_events SET status = 'superseded', superseded_by_event_id = ?, revision = revision + 1, updated_at = ? WHERE event_id = ?`)
          .run(event.event_id, at, supersedesEventId);
        recordRevision(db, supersedesEventId, supersededRow.revision + 1, hash(`${supersededRow.event_id}:${supersededRow.revision + 1}:superseded:${event.event_id}`), 'context-supersede', at);
      }
      saveRequest(db, keyHash, digest, event.event_id, action, at);
      db.exec('COMMIT');
      transaction = false;
      return { status: supersededRow ? 'superseded' : 'created', event: rowToEvent(eventById(db, event.event_id)), generation: currentGeneration + 1 };
    }

    const current = eventById(db, eventId);
    if (!current || current.profile_id !== profileId || (action === 'context-correct' && current.profile_id !== event?.profile_id)) {
      throw eventError('HEALTH_OS_EVENT_NOT_FOUND', `Event ${eventId} was not found in the selected profile`);
    }
    if (action === 'context-correct') {
      if (current.status !== 'active') throw activeError(eventId, 'correct');
      if (current.revision !== expectedRevision) {
        throw eventError('HEALTH_OS_EVENT_REVISION_CONFLICT', `Event ${eventId} is at revision ${current.revision}, not expected revision ${expectedRevision}`);
      }
      const corrected = { ...event, event_id: eventId, profile_id: current.profile_id };
      const prior = rowToEvent(current);
      if (eventSourceIdentity(prior) !== eventSourceIdentity(corrected)) {
        throw eventError('HEALTH_OS_EVENT_SOURCE_IMMUTABLE', 'Correction must preserve source kind, reference, and fragment id');
      }
      if (eventId !== corrected.event_id) throw eventError('HEALTH_OS_EVENT_ID_CONFLICT', 'Correction cannot change the event id');
      const revision = current.revision + 1;
      updateReviewBeforeCommit(paths, db, currentGeneration, [{ event_id: eventId, profile_id: current.profile_id, revision, status: 'active' }]);
      db.prepare(`UPDATE health_events SET event_type=?, occurred_json=?, data_json=?, source_json=?, extraction_version=?, epistemic_status=?, uncertainty_json=?, revision=?, updated_at=? WHERE event_id=?`)
        .run(corrected.event_type, JSON.stringify(corrected.occurred), JSON.stringify(corrected.data), JSON.stringify(corrected.source), corrected.extraction_version, corrected.epistemic_status, JSON.stringify(corrected.uncertainty), revision, at, eventId);
      recordRevision(db, eventId, revision, eventDigest(corrected), action, at);
      saveRequest(db, keyHash, digest, eventId, action, at);
      db.exec('COMMIT');
      transaction = false;
      return { status: 'corrected', event: rowToEvent(eventById(db, eventId)), generation: currentGeneration + 1 };
    }

    if (action === 'context-delete') {
      if (current.status === 'deleted') {
        saveDuplicateRequest(db, keyHash, digest, eventId, action, at);
        db.exec('COMMIT');
        transaction = false;
        return { status: 'tombstone', event: rowToEvent(current), generation: currentGeneration };
      }
      if (current.revision !== expectedRevision) {
        throw eventError('HEALTH_OS_EVENT_REVISION_CONFLICT', `Event ${eventId} is at revision ${current.revision}, not expected revision ${expectedRevision}`);
      }
      const revision = current.revision + 1;
      updateReviewBeforeCommit(paths, db, currentGeneration, [{ event_id: eventId, profile_id: current.profile_id, revision, status: 'deleted' }]);
      // Event bodies and revision payloads are never retained; deletion also removes revision digests.
      db.prepare(`UPDATE health_events SET event_type=NULL, occurred_json=NULL, data_json=NULL, source_json=NULL, extraction_version=NULL, epistemic_status=NULL, uncertainty_json=NULL, status='deleted', superseded_by_event_id=NULL, revision=?, updated_at=? WHERE event_id=?`)
        .run(revision, at, eventId);
      db.prepare('DELETE FROM event_revisions WHERE event_id = ?').run(eventId);
      saveRequest(db, keyHash, digest, eventId, action, at);
      db.exec('COMMIT');
      transaction = false;
      return { status: 'deleted', event: rowToEvent(eventById(db, eventId)), generation: currentGeneration + 1 };
    }

    throw eventError('HEALTH_OS_EVENT_OPERATION_INVALID', `Unsupported event action ${action}`);
  } catch (error) {
    if (transaction) {
      try { db.exec('ROLLBACK'); } catch { /* transaction may already be closed */ }
    }
    throw databaseError(error);
  } finally {
    db.close();
  }
}

export function queryEvents(paths, profileId, filters = {}) {
  const db = openReadOnly(paths);
  if (!db) return { events: [], generation: 0, matched_count: 0, truncated: false, source_counts: { counts: {}, omitted_source_count: 0, complete: true } };
  try {
    const generation = Number(getMeta(db, 'generation'));
    if (!Number.isSafeInteger(generation) || generation < 0) throw eventError('HEALTH_OS_EVENT_STORE_INVALID', 'Event store generation is invalid');
    if (!profileId) return { events: [], generation, matched_count: 0, truncated: false, source_counts: { counts: {}, omitted_source_count: 0, complete: true } };
    const clauses = ['profile_id = ?'];
    const params = [profileId];
    if (!filters.includeInactive) clauses.push("status = 'active'");
    if (filters.epistemicStatus) { clauses.push('epistemic_status = ?'); params.push(filters.epistemicStatus); }
    const typeClauses = [];
    if (filters.types !== undefined && !Array.isArray(filters.types)) {
      throw eventError('HEALTH_OS_EVENT_QUERY_INVALID', 'Event query types must be an array');
    }
    if (filters.typePrefixes !== undefined && !Array.isArray(filters.typePrefixes)) {
      throw eventError('HEALTH_OS_EVENT_QUERY_INVALID', 'Event query typePrefixes must be an array');
    }
    if (filters.types?.length) {
      const types = filters.types.filter((type) => typeof type === 'string' && /^[a-z][a-z0-9_.-]{0,63}$/.test(type));
      if (types.length !== filters.types.length || types.length > 50) {
        throw eventError('HEALTH_OS_EVENT_QUERY_INVALID', 'Event query types must contain at most 50 lower-case event types');
      }
      typeClauses.push(`event_type IN (${types.map(() => '?').join(',')})`);
      params.push(...types);
    }
    if (filters.typePrefixes?.length) {
      const prefixes = filters.typePrefixes.filter((prefix) => typeof prefix === 'string' && /^[a-z][a-z0-9_.-]{0,63}$/.test(prefix));
      if (prefixes.length !== filters.typePrefixes.length || prefixes.length > 10) {
        throw eventError('HEALTH_OS_EVENT_QUERY_INVALID', 'Event query typePrefixes must contain at most 10 lower-case event-type prefixes');
      }
      typeClauses.push(`(${prefixes.map(() => 'event_type LIKE ?').join(' OR ')})`);
      params.push(...prefixes.map((prefix) => `${prefix}%`));
    }
    if (typeClauses.length) clauses.push(`(${typeClauses.join(' OR ')})`);
    if (filters.sources?.length) {
      clauses.push(`json_extract(source_json, '$.kind') IN (${filters.sources.map(() => '?').join(',')})`);
      params.push(...filters.sources);
    }
    // SQLite date()/julianday normalize RFC3339 offsets to UTC while retaining date-only labels.
    const startDay = "date(json_extract(occurred_json, '$.start'))";
    const endDay = "date(json_extract(occurred_json, '$.end'))";
    if (filters.since) {
      clauses.push(`(${endDay} >= ? OR (${endDay} IS NULL AND ${startDay} >= ?))`);
      params.push(filters.since, filters.since);
    }
    if (filters.through) {
      clauses.push(`${startDay} <= ?`);
      params.push(filters.through);
    }
    if (filters.asOfDate !== undefined) {
      if (typeof filters.asOfDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(filters.asOfDate) ||
          !Number.isFinite(Date.parse(`${filters.asOfDate}T00:00:00.000Z`)) ||
          new Date(`${filters.asOfDate}T00:00:00.000Z`).toISOString().slice(0, 10) !== filters.asOfDate) {
        throw eventError('HEALTH_OS_EVENT_QUERY_INVALID', 'Event query asOfDate must be a real YYYY-MM-DD date');
      }
      const precision = "json_extract(occurred_json, '$.precision')";
      const start = "json_extract(occurred_json, '$.start')";
      const end = "json_extract(occurred_json, '$.end')";
      clauses.push(`(((${precision} IN ('day', 'instant', 'second', 'minute', 'hour')) AND date(${start}) <= ?) OR
        ((${precision} = 'interval') AND date(${end}) <= ?))`);
      params.push(filters.asOfDate, filters.asOfDate);
    }
    if (filters.asOfTimestamp !== undefined) {
      const fraction = typeof filters.asOfTimestamp === 'string'
        ? (filters.asOfTimestamp.match(/\.(\d+)/)?.[1] || '')
        : '';
      if (typeof filters.asOfTimestamp !== 'string' || !filters.asOfTimestamp.includes('T') ||
          fraction.length > 3 || !isValidOccurrenceBound(filters.asOfTimestamp)) {
        throw eventError('HEALTH_OS_EVENT_QUERY_INVALID', 'Event query asOfTimestamp must be a valid RFC3339 timestamp with at most millisecond precision');
      }
      const precision = "json_extract(occurred_json, '$.precision')";
      const start = "json_extract(occurred_json, '$.start')";
      const end = "json_extract(occurred_json, '$.end')";
      clauses.push(`(((${precision} = 'day') AND date(${start}) < date(?)) OR
        ((${precision} IN ('instant', 'second', 'minute', 'hour')) AND julianday(${start}) <= julianday(?)) OR
        ((${precision} = 'interval') AND
          ((length(${start}) = 10 AND date(${end}) < date(?)) OR
           (length(${start}) > 10 AND julianday(${start}) <= julianday(?) AND julianday(${end}) <= julianday(?)))))`);
      params.push(filters.asOfTimestamp, filters.asOfTimestamp, filters.asOfTimestamp, filters.asOfTimestamp, filters.asOfTimestamp);
    }
    if (filters.eventId) { clauses.push('event_id = ?'); params.push(filters.eventId); }
    const where = clauses.join(' AND ');
    const matchedCount = db.prepare(`SELECT COUNT(*) AS count FROM health_events WHERE ${where}`).get(...params).count;
    const limit = filters.limit === undefined ? 25 : Number(filters.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
      throw eventError('HEALTH_OS_EVENT_QUERY_INVALID', 'Event query limit must be an integer from 1 to 50');
    }
    const sourceCountRows = db.prepare(`SELECT json_extract(source_json, '$.kind') AS source, COUNT(*) AS count
      FROM health_events WHERE ${where} GROUP BY source ORDER BY count DESC, source ASC LIMIT 20`).all(...params);
    const sourceCounts = Object.fromEntries(sourceCountRows.map((row) => [row.source || 'unknown', row.count]));
    const countedSources = sourceCountRows.reduce((sum, row) => sum + row.count, 0);
    const orderBy = filters.order === 'timeline'
      ? `CASE WHEN json_extract(occurred_json, '$.start') IS NULL THEN 1 ELSE 0 END,
        julianday(json_extract(occurred_json, '$.start')) ASC,
        CASE json_extract(occurred_json, '$.precision') WHEN 'day' THEN 0 WHEN 'interval' THEN 1 WHEN 'unknown' THEN 3 ELSE 2 END,
        json_extract(source_json, '$.kind') ASC, json_extract(source_json, '$.ref') ASC, event_id ASC`
      : `CASE WHEN ${startDay} IS NULL THEN 1 ELSE 0 END,
        julianday(json_extract(occurred_json, '$.start')) DESC, event_id ASC`;
    const rows = db.prepare(`SELECT * FROM health_events WHERE ${where} ORDER BY ${orderBy} LIMIT ?`)
      .all(...params, limit);
    return {
      events: rows.map(rowToEvent),
      generation,
      matched_count: matchedCount,
      truncated: matchedCount > rows.length,
      source_counts: {
        counts: sourceCounts,
        omitted_source_count: matchedCount - countedSources,
        complete: matchedCount <= countedSources
      }
    };
  } finally {
    db.close();
  }
}

export function queryEventById(paths, profileId, eventId) {
  return queryEvents(paths, profileId, { eventId, includeInactive: true }).events[0] || null;
}

export function revalidateEventMemory(paths, generation) {
  const status = readEventStoreStatus(paths);
  const rawReview = readEventReviewState(paths, { allowPending: true });
  const recoveredAheadMarker = rawReview?.required_generation === status.generation + 1;
  const db = status.exists ? openReadOnly(paths) : null;
  let state;
  try { state = readReviewState(paths, status.store_id, status.generation, { reconcileAhead: true, db }); }
  finally { db?.close(); }
  if (!state.pending && state.reviewed_generation === status.generation && !recoveredAheadMarker) {
    throw eventError('HEALTH_OS_MEMORY_REVALIDATION_NOT_PENDING', 'There is no unreviewed event generation');
  }
  if (generation !== state.required_generation || generation !== status.generation) {
    throw eventError('HEALTH_OS_EVENT_GENERATION_CONFLICT', `--generation must equal the current event-store generation ${status.generation} and review target ${state.required_generation}`);
  }
  const checkDb = status.exists ? openReadOnly(paths) : null;
  if (checkDb) {
    try { assertRowsMatchReview(checkDb, state, status.generation); }
    finally { checkDb.close(); }
  }
  const stale = findStaleEventProvenance(paths, state);
  if (stale.length) {
    throw eventError('HEALTH_OS_MEMORY_EVENT_PROVENANCE_STALE', `Derived pages still cite ${stale.length} deleted or stale event reference(s); update those Markdown references before revalidation`);
  }
  const reviewed = {
    ...state,
    reviewed_generation: generation,
    required_generation: generation,
    pending: false
  };
  writeReviewState(paths, reviewed);
  if (!state.pending && state.reviewed_generation === generation && recoveredAheadMarker) {
    return { reviewed_generation: generation, store_id: status.store_id, recovered_interrupted_write: true };
  }
  return { reviewed_generation: generation, store_id: status.store_id };
}
