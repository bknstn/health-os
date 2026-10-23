import fs from 'node:fs';
import { boundedJsonValue } from './cli-contract.js';

// Legacy source filters are `legacy.workout_session` and `legacy.recovery_day`.
// Event source filters use the HealthEvent `source.kind` value. `source_counts`
// describes returned items; `matched_count` includes an EventStore count when
// the caller bounded its event query before passing it here.
export const MAX_TIMELINE_LIMIT = 50;
const MAX_TEXT_CHARS = 2_000;
const MAX_EXERCISES_PER_SESSION = 25;
const MAX_RECOVERY_METRICS_PER_DAY = 25;
const MAX_SOURCE_ISSUE_SAMPLES = 50;
const MAX_TIMELINE_ITEMS_BYTES = 48_000;
const MAX_TIMELINE_DATA_BYTES = 32_000;
const MAX_TIMELINE_ITEM_DATA_BYTES = 12_000;

const HEADERS = {
  workoutSessions: [
    'session_id', 'date', 'day_type', 'recommended_mode', 'actual_mode',
    'duration_minutes', 'session_rpe', 'energy_pre', 'soreness_pre',
    'completed_flag', 'notes'
  ],
  exerciseLogs: [
    'session_id', 'session_date', 'day_type', 'exercise_key', 'exercise_name',
    'set_count', 'reps', 'weight', 'top_set_weight', 'top_set_reps',
    'estimated_1rm', 'completed_as_planned', 'actual_mode', 'session_rpe', 'notes'
  ],
  dailyState: [
    'date', 'readiness_score', 'sleep_score', 'hrv', 'hrv_baseline_28d',
    'hrv_delta_pct', 'resting_hr', 'resting_hr_baseline_28d', 'resting_hr_delta',
    'sleep_efficiency', 'total_sleep_minutes', 'temperature_deviation',
    'recommended_mode', 'recommendation_reason', 'source_sync_time'
  ],
  recoverySnapshots: ['date', 'metric_name', 'metric_value', 'unit', 'source_sync_time']
};

const SESSION_NUMBERS = new Set(['duration_minutes', 'session_rpe', 'energy_pre', 'soreness_pre']);
const EXERCISE_NUMBERS = new Set([
  'set_count', 'top_set_reps', 'estimated_1rm', 'session_rpe'
]);
const RECOVERY_NUMBERS = new Set([
  'readiness_score', 'sleep_score', 'hrv', 'hrv_baseline_28d', 'hrv_delta_pct',
  'resting_hr', 'resting_hr_baseline_28d', 'resting_hr_delta', 'sleep_efficiency',
  'total_sleep_minutes', 'temperature_deviation'
]);
const NUMBER_TEXT = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

function isValidDay(value) {
  if (typeof value !== 'string' || !DAY.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function isValidTimestamp(value) {
  return typeof value === 'string' && TIMESTAMP.test(value) &&
    isValidDay(value.slice(0, 10)) && Number.isFinite(Date.parse(value));
}

function csvRecords(content) {
  const records = [];
  let row = [];
  let field = '';
  let state = 'start';
  let invalid = false;
  let touched = false;

  const finishField = () => {
    row.push(field);
    field = '';
    state = 'start';
  };
  const finishRecord = () => {
    finishField();
    const blank = row.length === 1 && row[0] === '' && !invalid;
    if (!blank) records.push({ values: row, invalid });
    row = [];
    invalid = false;
    touched = false;
  };
  for (let index = 0; index < content.length; index += 1) {
    const char = content[index];
    touched = true;

    if (state === 'quoted') {
      if (char === '"') {
        if (content[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          state = 'after_quote';
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '\r' || char === '\n') {
      if (state === 'after_quote' || state === 'start' || state === 'unquoted') {
        finishRecord();
        if (char === '\r' && content[index + 1] === '\n') index += 1;
        continue;
      }
    }

    if (state === 'start') {
      if (char === '"') state = 'quoted';
      else if (char === ',') finishField();
      else {
        field += char;
        state = 'unquoted';
      }
    } else if (state === 'unquoted') {
      if (char === ',') finishField();
      else if (char === '"') {
        invalid = true;
        field += char;
      } else field += char;
    } else if (state === 'after_quote') {
      if (char === ',') finishField();
      else {
        invalid = true;
        field += char;
        state = 'unquoted';
      }
    }
  }

  if (touched || row.length || field || invalid) {
    if (state === 'quoted') invalid = true;
    finishRecord();
  }
  return records;
}

function readLegacyRows(filePath, expectedHeaders, key, stats) {
  if (!fs.existsSync(filePath)) return [];
  const records = csvRecords(fs.readFileSync(filePath, 'utf8'));
  if (records.length === 0) {
    addSourceIssue(stats, { source: key, reason: 'missing_header' });
    return [];
  }

  const header = records[0];
  const headers = header.values.map((value, index) => index === 0 ? value.replace(/^\uFEFF/, '') : value);
  const validHeader = !header.invalid && headers.length === expectedHeaders.length &&
    headers.every((value, index) => value === expectedHeaders[index]);
  if (!validHeader) {
    addSourceIssue(stats, { source: key, reason: 'invalid_header' });
    stats.omissionCounts[key] = (stats.omissionCounts[key] || 0) + records.length - 1;
    stats.omitted += records.length - 1;
    return [];
  }

  const rows = [];
  for (let index = 1; index < records.length; index += 1) {
    const record = records[index];
    if (record.invalid || record.values.length !== headers.length) {
      omit(stats, key, record.invalid ? 'malformed_csv' : 'column_count');
      continue;
    }
    rows.push(Object.fromEntries(headers.map((name, column) => [name, record.values[column]])));
  }
  return rows;
}

function omit(stats, source, reason) {
  stats.omitted += 1;
  stats.omissionCounts[source] = (stats.omissionCounts[source] || 0) + 1;
  addSourceIssue(stats, { source, reason });
}

function addSourceIssue(stats, issue) {
  stats.issueCount += 1;
  if (stats.issues.length < MAX_SOURCE_ISSUE_SAMPLES) stats.issues.push(issue);
}

function nonBlank(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function limitedText(value, field, issues) {
  const chars = [...value];
  if (chars.length <= MAX_TEXT_CHARS) return value;
  issues.push({ field, reason: 'value_truncated', original_chars: chars.length });
  return `${chars.slice(0, MAX_TEXT_CHARS - 1).join('')}…`;
}

function textValue(value, field, issues) {
  if (!nonBlank(value)) return null;
  return limitedText(value, field, issues);
}

function numberValue(value, field, issues) {
  if (!nonBlank(value)) return null;
  const normalized = value.trim();
  const number = NUMBER_TEXT.test(normalized) ? Number(normalized) : NaN;
  if (Number.isFinite(number)) return number;
  const retainedValue = limitedText(value, field, issues);
  issues.push({ field, reason: 'invalid_number', value: retainedValue });
  return retainedValue;
}

function booleanValue(value, field, issues) {
  if (!nonBlank(value)) return null;
  if (value === 'true') return true;
  if (value === 'false') return false;
  const retainedValue = limitedText(value, field, issues);
  issues.push({ field, reason: 'invalid_boolean', value: retainedValue });
  return retainedValue;
}

function sourceRef(file, key, value) {
  return `${file}#${key}=${encodeURIComponent(value)}`;
}

function validRowDate(row, key, stats) {
  if (!isValidDay(row.date)) {
    omit(stats, key, nonBlank(row.date) ? 'invalid_date' : 'missing_date');
    return false;
  }
  return true;
}

function workoutItems(paths, stats) {
  const sessionRows = readLegacyRows(paths.workoutSessionsFile, HEADERS.workoutSessions, 'workout_sessions.csv', stats);
  const exerciseRows = readLegacyRows(paths.exerciseLogsFile, HEADERS.exerciseLogs, 'exercise_logs.csv', stats);
  const groupedExercises = new Map();
  const seenExerciseKeys = new Set();
  const duplicateSessions = new Set();
  const sessionsById = new Map();

  for (const row of sessionRows) {
    if (!validRowDate(row, 'workout_sessions.csv', stats)) continue;
    if (!nonBlank(row.session_id) || [...row.session_id].length > 512) {
      omit(stats, 'workout_sessions.csv', nonBlank(row.session_id) ? 'invalid_session_id' : 'missing_session_id');
      continue;
    }
    const sessionId = row.session_id;
    if (sessionsById.has(sessionId)) duplicateSessions.add(sessionId);
    sessionsById.set(sessionId, row);
  }

  for (const [sessionId, row] of sessionsById) {
    if (!duplicateSessions.has(sessionId)) continue;
    omit(stats, 'workout_sessions.csv', 'duplicate_session_id');
    // Each duplicate was already retained once in the map; account for the first row too.
    const copies = sessionRows.filter((candidate) => candidate.session_id === sessionId && isValidDay(candidate.date)).length;
    for (let index = 1; index < copies; index += 1) omit(stats, 'workout_sessions.csv', 'duplicate_session_id');
    sessionsById.delete(sessionId);
  }

  for (const row of exerciseRows) {
    if (!nonBlank(row.session_id) || !sessionsById.has(row.session_id)) {
      omit(stats, 'exercise_logs.csv', 'orphan_exercise');
      continue;
    }
    const session = sessionsById.get(row.session_id);
    if (!isValidDay(row.session_date) || row.session_date !== session.date || !nonBlank(row.exercise_key) || [...row.exercise_key].length > 512) {
      omit(stats, 'exercise_logs.csv', !isValidDay(row.session_date) ? 'invalid_date' : 'invalid_join');
      continue;
    }
    const exerciseIdentity = `${row.session_id}\u0000${row.exercise_key}`;
    if (seenExerciseKeys.has(exerciseIdentity)) {
      omit(stats, 'exercise_logs.csv', 'duplicate_exercise');
      continue;
    }
    seenExerciseKeys.add(exerciseIdentity);
    const exercises = groupedExercises.get(row.session_id) || { rows: [], total: 0 };
    exercises.total += 1;
    if (exercises.rows.length < MAX_EXERCISES_PER_SESSION + 1) exercises.rows.push(row);
    groupedExercises.set(row.session_id, exercises);
  }

  const items = [];
  for (const row of sessionsById.values()) {
    const issues = [];
    const session = {};
    for (const header of HEADERS.workoutSessions) {
      if (SESSION_NUMBERS.has(header)) session[header] = numberValue(row[header], `session.${header}`, issues);
      else if (header === 'completed_flag') session[header] = booleanValue(row[header], `session.${header}`, issues);
      else session[header] = textValue(row[header], `session.${header}`, issues);
    }

    const exerciseGroup = groupedExercises.get(row.session_id) || { rows: [], total: 0 };
    const allExercises = exerciseGroup.rows;
    const exerciseRowsForItem = allExercises.slice(0, MAX_EXERCISES_PER_SESSION);
    const exercises = exerciseRowsForItem.map((exercise) => {
      const exerciseIssues = [];
      const value = {};
      for (const header of HEADERS.exerciseLogs) {
        if (EXERCISE_NUMBERS.has(header)) value[header] = numberValue(exercise[header], `exercise.${header}`, exerciseIssues);
        else if (header === 'weight' || header === 'top_set_weight') {
          value[header] = exercise[header] === 'bw' ? 'bw' : numberValue(exercise[header], `exercise.${header}`, exerciseIssues);
        } else if (header === 'completed_as_planned') {
          value[header] = booleanValue(exercise[header], `exercise.${header}`, exerciseIssues);
        } else value[header] = textValue(exercise[header], `exercise.${header}`, exerciseIssues);
      }
      value.issues = exerciseIssues;
      const ref = sourceRef('exercise_logs.csv', 'session_id', row.session_id) +
        `&exercise_key=${encodeURIComponent(exercise.exercise_key)}`;
      value.source = { kind: 'legacy.exercise_log', ref, fragment_id: exercise.exercise_key };
      return value;
    });

    const ref = sourceRef('workout_sessions.csv', 'session_id', row.session_id);
    items.push({
      id: `legacy.workout_session:${encodeURIComponent(row.session_id)}`,
      type: 'workout',
      occurred: { start: row.date, end: null, precision: 'day', timezone: null },
      data: {
        ...(exerciseGroup.total > exercises.length ? { exercises_truncated: exerciseGroup.total - exercises.length } : {}),
        session,
        issues,
        exercises
      },
      source: { kind: 'legacy.workout_session', ref, fragment_id: '0' },
      ...(issues.some((issue) => issue.reason === 'value_truncated') ||
        exercises.some((exercise) => exercise.issues.some((issue) => issue.reason === 'value_truncated')) ||
        exerciseGroup.total > exercises.length
        ? { record_content_truncated: true } : {})
    });
  }
  return items;
}

function recoveryItems(paths, stats) {
  const dailyRows = readLegacyRows(paths.dailyStateFile, HEADERS.dailyState, 'daily_state.csv', stats);
  const snapshotRows = readLegacyRows(paths.recoverySnapshotsFile, HEADERS.recoverySnapshots, 'recovery_snapshots.csv', stats);
  const dailyByDate = new Map();
  const duplicateDates = new Set();

  for (const row of dailyRows) {
    if (!validRowDate(row, 'daily_state.csv', stats)) continue;
    if (dailyByDate.has(row.date)) duplicateDates.add(row.date);
    else dailyByDate.set(row.date, row);
  }
  for (const date of duplicateDates) {
    const copies = dailyRows.filter((row) => row.date === date && isValidDay(row.date)).length;
    for (let index = 0; index < copies; index += 1) omit(stats, 'daily_state.csv', 'duplicate_date');
    dailyByDate.delete(date);
  }

  const metricsByDate = new Map();
  const metricCountsByDate = new Map();
  const seenMetrics = new Set();
  for (const row of snapshotRows) {
    if (!isValidDay(row.date)) {
      omit(stats, 'recovery_snapshots.csv', nonBlank(row.date) ? 'invalid_date' : 'missing_date');
      continue;
    }
    if (!nonBlank(row.metric_name) || [...row.metric_name].length > 512) {
      omit(stats, 'recovery_snapshots.csv', 'missing_metric_name');
      continue;
    }
    const identity = `${row.date}\u0000${row.metric_name}`;
    if (seenMetrics.has(identity)) {
      omit(stats, 'recovery_snapshots.csv', 'duplicate_metric');
      continue;
    }
    seenMetrics.add(identity);
    const entries = metricsByDate.get(row.date) || [];
    metricCountsByDate.set(row.date, (metricCountsByDate.get(row.date) || 0) + 1);
    const issues = [];
    const ref = sourceRef('recovery_snapshots.csv', 'date', row.date) +
      `&metric_name=${encodeURIComponent(row.metric_name)}`;
    if (entries.length < MAX_RECOVERY_METRICS_PER_DAY + 1) entries.push({
      metric_name: row.metric_name,
      metric_value: numberValue(row.metric_value, `metrics.${row.metric_name}`, issues),
      unit: textValue(row.unit, `metrics.${row.metric_name}.unit`, issues),
      source_sync_time: textValue(row.source_sync_time, `metrics.${row.metric_name}.source_sync_time`, issues),
      source: { kind: 'legacy.recovery_snapshot', ref, fragment_id: row.metric_name },
      issues
    });
    metricsByDate.set(row.date, entries);
  }

  const dates = new Set([...dailyByDate.keys(), ...metricsByDate.keys()]);
  const items = [];
  for (const date of dates) {
    const daily = dailyByDate.get(date) || null;
    const issues = [];
    let dailyState = null;
    let primaryRef;
    if (daily) {
      dailyState = {};
      for (const header of HEADERS.dailyState) {
        if (RECOVERY_NUMBERS.has(header)) dailyState[header] = numberValue(daily[header], `daily_state.${header}`, issues);
        else dailyState[header] = textValue(daily[header], `daily_state.${header}`, issues);
      }
      primaryRef = sourceRef('daily_state.csv', 'date', date);
    } else {
      primaryRef = sourceRef('recovery_snapshots.csv', 'date', date);
    }
    const allMetrics = metricsByDate.get(date) || [];
    const totalMetrics = metricCountsByDate.get(date) || 0;
    const metrics = allMetrics.slice(0, MAX_RECOVERY_METRICS_PER_DAY);
    items.push({
      id: `legacy.recovery_day:${date}`,
      type: 'recovery',
      occurred: { start: date, end: null, precision: 'day', timezone: null },
      data: {
        date,
        daily_state: dailyState,
        metrics,
        issues,
        ...(totalMetrics > metrics.length ? { metrics_truncated: totalMetrics - metrics.length } : {})
      },
      source: { kind: 'legacy.recovery_day', ref: primaryRef, fragment_id: '0' },
      ...(totalMetrics > metrics.length || issues.some((issue) => issue.reason === 'value_truncated') ||
        metrics.some((metric) => metric.issues.some((issue) => issue.reason === 'value_truncated'))
        ? { record_content_truncated: true } : {})
    });
  }
  return items;
}

function eventItems(events) {
  if (events == null) return [];
  const input = Array.isArray(events) ? events : events.events;
  if (!Array.isArray(input)) throw new Error('timeline events must be an array or an EventStore query result');
  return input.filter((event) => event && typeof event === 'object' && (!event.status || event.status === 'active'))
    .map((event) => ({
      schema_version: event.schema_version,
      id: event.event_id,
      profile_id: event.profile_id,
      type: event.event_type,
      occurred: event.occurred,
      data: event.data,
      source: event.source,
      extraction_version: event.extraction_version,
      epistemic_status: event.epistemic_status,
      uncertainty: event.uncertainty,
      ...(event.status ? { status: event.status } : {}),
      ...(event.revision !== undefined ? { revision: event.revision } : {}),
      ...(event.superseded_by_event_id ? { superseded_by_event_id: event.superseded_by_event_id } : {}),
      ...(event.ingested_at ? { ingested_at: event.ingested_at } : {}),
      ...(event.updated_at ? { updated_at: event.updated_at } : {})
    }));
}

function normalizeFilterList(value, label) {
  if (value === undefined || value === null) return [];
  const list = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : null;
  if (!list || list.some((item) => typeof item !== 'string' || !item.trim())) {
    throw new Error(`timeline ${label} must be an array of non-empty strings`);
  }
  return [...new Set(list.map((item) => item.trim()))];
}

function normalizeSourceCounts(value) {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      !value.counts || typeof value.counts !== 'object' || Array.isArray(value.counts) ||
      (value.omitted_source_count !== undefined && (!Number.isSafeInteger(value.omitted_source_count) || value.omitted_source_count < 0)) ||
      (value.complete !== undefined && typeof value.complete !== 'boolean') ||
      Object.entries(value.counts).some(([key, count]) => !key || [...key].length > 64 || !Number.isSafeInteger(count) || count < 0)) {
    throw new Error('timeline event_source_counts must map source kinds to non-negative integer counts');
  }
  const entries = Object.entries(value.counts).sort(([left], [right]) => left.localeCompare(right));
  const kept = entries.slice(0, 20);
  const omittedFromTimeline = entries.slice(20).reduce((total, [, count]) => total + count, 0);
  const omittedSourceCount = (value.omitted_source_count || 0) + omittedFromTimeline;
  if (!Number.isSafeInteger(omittedSourceCount)) throw new Error('timeline event_source_counts omitted total exceeds the integer safety limit');
  return {
    counts: Object.fromEntries(kept),
    omitted_source_count: omittedSourceCount,
    complete: value.complete === true && omittedSourceCount === 0
  };
}

function dateRange(filters) {
  for (const field of ['since', 'through']) {
    if (filters[field] !== undefined && !isValidDay(filters[field])) {
      throw new Error(`timeline ${field} must be a valid YYYY-MM-DD date`);
    }
  }
  if (filters.since && filters.through && filters.since > filters.through) {
    throw new Error('timeline since must be on or before through');
  }
  return {
    start: filters.since ? Date.parse(`${filters.since}T00:00:00.000Z`) : -Infinity,
    end: filters.through ? Date.parse(`${filters.through}T23:59:59.999Z`) : Infinity
  };
}

function boundEpoch(value, isEnd = false) {
  if (isValidTimestamp(value)) return Date.parse(value);
  if (isValidDay(value)) {
    const start = Date.parse(`${value}T00:00:00.000Z`);
    return isEnd ? start + 86_400_000 - 1 : start;
  }
  return null;
}

function matchesDateRange(item, range, hasDateFilter) {
  if (!hasDateFilter) return true;
  const occurrence = item.occurred;
  if (!occurrence || occurrence.precision === 'unknown' || occurrence.start == null) return false;
  const start = boundEpoch(occurrence.start);
  const end = occurrence.end == null ? start : boundEpoch(occurrence.end, true);
  if (start == null || end == null || end < start) return false;
  return start <= range.end && end >= range.start;
}

function sortPosition(item) {
  const occurrence = item.occurred;
  if (!occurrence || occurrence.precision === 'unknown' || occurrence.start == null) return Infinity;
  return boundEpoch(occurrence.start) ?? Infinity;
}

function binaryCompare(left, right) {
  return Buffer.compare(Buffer.from(String(left), 'utf8'), Buffer.from(String(right), 'utf8'));
}

function precisionRank(precision) {
  if (precision === 'day') return 0;
  if (precision === 'interval') return 1;
  if (precision === 'unknown') return 3;
  return 2;
}

function compareItems(left, right) {
  const leftTime = sortPosition(left);
  const rightTime = sortPosition(right);
  if (leftTime < rightTime) return -1;
  if (leftTime > rightTime) return 1;
  const rankDiff = precisionRank(left.occurred?.precision) - precisionRank(right.occurred?.precision);
  if (rankDiff) return rankDiff;
  return binaryCompare(left.source?.kind || '', right.source?.kind || '') ||
    binaryCompare(left.source?.ref || '', right.source?.ref || '') ||
    binaryCompare(left.id || '', right.id || '');
}

function boundItems(selected) {
  const outputMeta = [];
  const outputSources = [];
  let metadataBytes = 2; // JSON array brackets
  for (const item of selected) {
    const { data, record_content_truncated, ...metadata } = item;
    const boundedMeta = { ...metadata, data: null, data_truncated: Boolean(record_content_truncated) };
    const json = JSON.stringify(boundedMeta);
    const nextSize = metadataBytes + (outputMeta.length ? 1 : 0) + Buffer.byteLength(json);
    if (nextSize > MAX_TIMELINE_ITEMS_BYTES) break;
    outputMeta.push(boundedMeta);
    outputSources.push(data);
    metadataBytes = nextSize;
  }

  let remainingDataBytes = Math.min(MAX_TIMELINE_DATA_BYTES, MAX_TIMELINE_ITEMS_BYTES - metadataBytes);
  const items = outputMeta.map((metadata, index) => {
    const remainingRecords = outputMeta.length - index;
    const dataBudget = Math.min(MAX_TIMELINE_ITEM_DATA_BYTES, Math.floor(remainingDataBytes / remainingRecords));
    const sourceData = outputSources[index];
    let data = sourceData;
    let wasTruncated = metadata.data_truncated;
    if (dataBudget >= 32) {
      const boundedData = boundedJsonValue(sourceData, dataBudget + 2_048, MAX_TEXT_CHARS);
      data = boundedData.value;
      wasTruncated ||= Boolean(boundedData.truncation);
    } else {
      data = null;
      wasTruncated = true;
    }
    remainingDataBytes -= dataBudget;
    return { ...metadata, data, data_truncated: wasTruncated };
  });
  return {
    items,
    omitted: selected.length - items.length,
    dataTruncatedCount: items.filter((item) => item.data_truncated).length
  };
}

/**
 * Compose active HealthEvents with authoritative legacy CSV records.
 * `since` / `through` are inclusive UTC calendar dates. Timestamp offsets are
 * preserved and used for chronology. Day precision stays day precision; the
 * deterministic tie order for records whose within-day time is unknown is not
 * a claim about when those records occurred.
 */
export function buildTimeline(paths, {
  events = [], since, through, types, sources, limit = MAX_TIMELINE_LIMIT,
  event_matched_count, event_truncated, event_source_counts
} = {}) {
  if (!paths || typeof paths !== 'object') throw new Error('timeline paths are required');
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_TIMELINE_LIMIT) {
    throw new Error(`timeline limit must be an integer from 1 to ${MAX_TIMELINE_LIMIT}`);
  }
  const typeFilters = new Set(normalizeFilterList(types, 'types'));
  const sourceFilters = new Set(normalizeFilterList(sources, 'sources'));
  const range = dateRange({ since, through });
  const stats = { omitted: 0, omissionCounts: {}, issues: [], issueCount: 0 };
  const suppliedEvents = eventItems(events);
  const legacyItems = [...workoutItems(paths, stats), ...recoveryItems(paths, stats)];
  const allItems = [...suppliedEvents, ...legacyItems];
  const hasDateFilter = Boolean(since || through);
  const matching = allItems.filter((item) =>
    (!typeFilters.size || typeFilters.has(item.type)) &&
    (!sourceFilters.size || sourceFilters.has(item.source?.kind)) &&
    matchesDateRange(item, range, hasDateFilter)
  ).sort(compareItems);
  const eventCount = event_matched_count ?? events?.event_matched_count ?? events?.matched_count;
  if (eventCount !== undefined && (!Number.isSafeInteger(eventCount) || eventCount < suppliedEvents.length)) {
    throw new Error('timeline event_matched_count must be an integer at least as large as the supplied active events');
  }
  const eventIsTruncated = event_truncated ?? events?.event_truncated ?? events?.truncated ?? false;
  if (typeof eventIsTruncated !== 'boolean') throw new Error('timeline event_truncated must be a boolean');
  const matchedEventSourceCounts = normalizeSourceCounts(
    event_source_counts ?? events?.event_source_counts ?? events?.source_counts
  );
  const suppliedEventItems = new Set(suppliedEvents);
  const suppliedEventMatches = matching.filter((item) => suppliedEventItems.has(item)).length;
  const unmatchedEventCount = eventCount === undefined ? 0 : Math.max(0, eventCount - suppliedEventMatches);
  const matchedCount = matching.length + unmatchedEventCount;
  const selected = matching.slice(0, limit);
  const bounded = boundItems(selected);
  const items = bounded.items;
  const recordsWithTruncatedContent = bounded.dataTruncatedCount;
  const contentTruncated = bounded.omitted > 0 || recordsWithTruncatedContent > 0;
  const sourceCountEntries = new Map();
  for (const item of items) {
    const key = item.source?.kind || 'unknown';
    sourceCountEntries.set(key, (sourceCountEntries.get(key) || 0) + 1);
  }
  const sourceCounts = Object.fromEntries(sourceCountEntries);
  return {
    items,
    matched_count: matchedCount,
    limit,
    truncated: matchedCount > limit || eventIsTruncated || contentTruncated,
    returned_count: items.length,
    content_truncated: contentTruncated,
    records_with_truncated_content: recordsWithTruncatedContent,
    ...(contentTruncated ? {
      content_truncation: {
        item_bytes_limit: MAX_TIMELINE_ITEMS_BYTES,
        total_data_bytes_limit: MAX_TIMELINE_DATA_BYTES,
        item_data_bytes_limit: MAX_TIMELINE_ITEM_DATA_BYTES,
        data_records_truncated: recordsWithTruncatedContent,
        items_omitted_for_metadata: bounded.omitted
      }
    } : {}),
    ordering_note: 'Day-only and unknown occurrence times do not establish within-day chronology; their position relative to exact times is deterministic only.',
    omitted_legacy_rows: stats.omitted,
    omission_counts: stats.omissionCounts,
    source_counts: sourceCounts,
    ...(matchedEventSourceCounts ? {
      matched_event_source_counts: matchedEventSourceCounts.counts,
      matched_event_source_count_omitted: matchedEventSourceCounts.omitted_source_count,
      matched_event_source_counts_complete: matchedEventSourceCounts.complete
    } : {}),
    source_issue_count: stats.issueCount,
    source_issues_truncated: stats.issueCount > stats.issues.length,
    source_issues: stats.issues
  };
}
