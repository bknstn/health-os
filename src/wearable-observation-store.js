import fs from 'node:fs';

import { atomicWriteFileSync } from './coordination.js';
import {
  validateObservationDate,
  validateWearableObservationSet,
  WEARABLE_OBSERVATION_SCHEMA_VERSION
} from './wearable-observation-contract.js';

const MAX_OBSERVATION_SETS = 5_000;
const MAX_STORE_BYTES = 16 * 1024 * 1024;

function storeError(message) {
  return Object.assign(new Error(message), { code: 'HEALTH_OS_OBSERVATION_STORE_INVALID' });
}

function validateStore(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some((key) => !['schema_version', 'observations'].includes(key)) ||
      value.schema_version !== WEARABLE_OBSERVATION_SCHEMA_VERSION || !Array.isArray(value.observations) ||
      value.observations.length > MAX_OBSERVATION_SETS) {
    throw storeError('Wearable observation store has an unsupported or malformed schema');
  }
  const observations = value.observations.map((record) => validateWearableObservationSet(record));
  const identities = new Set();
  for (const record of observations) {
    const key = `${record.source.id}\u0000${record.date}`;
    if (identities.has(key)) throw storeError('Wearable observation store contains duplicate source/date records');
    identities.add(key);
  }
  return {
    schema_version: WEARABLE_OBSERVATION_SCHEMA_VERSION,
    observations: observations.sort((left, right) => left.date.localeCompare(right.date) || left.source.id.localeCompare(right.source.id))
  };
}

export function readWearableObservationStore(paths) {
  if (!fs.existsSync(paths.wearableObservationsFile)) {
    return { schema_version: WEARABLE_OBSERVATION_SCHEMA_VERSION, observations: [] };
  }
  let bytes;
  try {
    bytes = fs.readFileSync(paths.wearableObservationsFile);
  } catch (error) {
    throw storeError(`Cannot read wearable observation store: ${error.message}`);
  }
  if (bytes.byteLength > MAX_STORE_BYTES) throw storeError('Wearable observation store exceeds the supported size limit');
  let parsed;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw storeError('Wearable observation store is not valid JSON');
  }
  try {
    return validateStore(parsed);
  } catch (error) {
    if (error?.code === 'HEALTH_OS_OBSERVATION_STORE_INVALID') throw error;
    throw storeError(`Wearable observation store contains invalid data: ${error.message}`);
  }
}

export function writeWearableObservationSet(paths, input) {
  const observation = validateWearableObservationSet(input);
  const store = readWearableObservationStore(paths);
  const retained = store.observations.filter((existing) =>
    existing.source.id !== observation.source.id || existing.date !== observation.date);
  if (retained.length >= MAX_OBSERVATION_SETS) throw storeError('Wearable observation store has reached its record limit');
  const next = validateStore({
    schema_version: WEARABLE_OBSERVATION_SCHEMA_VERSION,
    observations: [...retained, observation]
  });
  const bytes = `${JSON.stringify(next, null, 2)}\n`;
  if (Buffer.byteLength(bytes) > MAX_STORE_BYTES) throw storeError('Wearable observation store would exceed the supported size limit');
  atomicWriteFileSync(paths.wearableObservationsFile, bytes, { encoding: 'utf8', mode: 0o600 });
  return observation;
}

export function listWearableObservationSets(paths, { source, date, limit = 50 } = {}) {
  if (source !== undefined && (typeof source !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(source))) {
    throw new Error('source must be a connector ID');
  }
  if (date !== undefined) validateObservationDate(date);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new Error('limit must be an integer from 1 to 50');
  const records = readWearableObservationStore(paths).observations.filter((record) =>
    (source === undefined || record.source.id === source) && (date === undefined || record.date === date));
  const ordered = records.sort((left, right) => right.date.localeCompare(left.date) || left.source.id.localeCompare(right.source.id));
  return {
    observations: ordered.slice(0, limit),
    matched_count: ordered.length,
    truncated: ordered.length > limit
  };
}

export function computeSourceBaselineCoverage(paths, sourceId, targetDate, metric, windowDays = 28) {
  if (typeof sourceId !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(sourceId)) throw new Error('sourceId must be a connector ID');
  const target = validateObservationDate(targetDate, 'targetDate');
  if (!Number.isSafeInteger(windowDays) || windowDays < 1 || windowDays > 365) throw new Error('windowDays must be from 1 to 365');
  if (typeof metric !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(metric)) throw new Error('metric must be a metric ID');

  const targetUtc = Date.parse(`${target}T00:00:00.000Z`);
  const valuesByDate = new Map();
  let baselineUnit;
  for (const observation of readWearableObservationStore(paths).observations) {
    if (observation.source.id !== sourceId || observation.date >= target) continue;
    const metricValue = observation.physical_metrics.find((item) => item.metric === metric);
    if (metricValue?.status !== 'observed') continue;
    const sampleDate = metricValue.observed_date || (metricValue.observed_at
      ? new Date(Date.parse(metricValue.observed_at)).toISOString().slice(0, 10)
      : null);
    if (!sampleDate || sampleDate >= target) continue;
    const sampleUtc = Date.parse(`${sampleDate}T00:00:00.000Z`);
    const daysAgo = (targetUtc - sampleUtc) / 86_400_000;
    if (daysAgo < 1 || daysAgo > windowDays) continue;
    if (baselineUnit !== undefined && baselineUnit !== metricValue.unit) {
      throw new Error(`Cannot compute ${sourceId} ${metric} baseline across mixed units (${baselineUnit} and ${metricValue.unit})`);
    }
    baselineUnit = metricValue.unit;
    if (valuesByDate.has(sampleDate) && valuesByDate.get(sampleDate) !== metricValue.value) {
      throw new Error(`Cannot compute ${sourceId} ${metric} baseline from conflicting values on ${sampleDate}`);
    }
    valuesByDate.set(sampleDate, metricValue.value);
  }
  const values = [...valuesByDate.values()];
  const observedDays = valuesByDate.size;
  return {
    status: observedDays === 0 ? 'unavailable' : observedDays === windowDays ? 'complete' : 'partial',
    value: observedDays === 0 ? null : Number((values.reduce((sum, value) => sum + value, 0) / observedDays).toFixed(2)),
    observed_days: observedDays,
    window_days: windowDays,
    scope: 'source',
    source_id: sourceId
  };
}
