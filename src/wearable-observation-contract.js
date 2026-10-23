export const WEARABLE_OBSERVATION_SCHEMA_VERSION = 1;

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function rejectUnknownKeys(value, allowed, label) {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) throw new Error(`${label} contains unsupported field "${unknown[0]}"`);
}

function requireObject(value, label, allowed) {
  if (!isPlainObject(value)) throw new Error(`${label} must be an object`);
  rejectUnknownKeys(value, allowed, label);
  return value;
}

function requireString(value, label, { maxLength = 200, pattern } = {}) {
  if (typeof value !== 'string' || value.trim() === '' || value.length > maxLength || value !== value.trim()) {
    throw new Error(`${label} must be a non-empty trimmed string of at most ${maxLength} characters`);
  }
  if (pattern && !pattern.test(value)) throw new Error(`${label} has an invalid format`);
  return value;
}

function requireFiniteNumber(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${label} must be a finite number`);
  }
  return value;
}

export function validateObservationDate(value, label = 'date') {
  const text = requireString(value, label, { maxLength: 10, pattern: /^\d{4}-\d{2}-\d{2}$/ });
  const [year, month, day] = text.split('-').map(Number);
  if (year < 1 || month < 1 || month > 12 || day < 1) throw new Error(`${label} must be a real YYYY-MM-DD date`);
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(0, 0, 0, 0);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw new Error(`${label} must be a real YYYY-MM-DD date`);
  }
  return text;
}

export function validateObservationTimestamp(value, label) {
  const text = requireString(value, label, {
    maxLength: 40,
    pattern: /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/
  });
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/);
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, offset] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  validateObservationDate(`${yearText}-${monthText}-${dayText}`, `${label} date`);
  if (hour > 23 || minute > 59 || second > 59) throw new Error(`${label} has an invalid time`);
  if (offset !== 'Z') {
    const [offsetHours, offsetMinutes] = offset.slice(1).split(':').map(Number);
    if (offsetHours > 14 || offsetMinutes > 59 || (offsetHours === 14 && offsetMinutes !== 0)) {
      throw new Error(`${label} has an invalid UTC offset`);
    }
  }
  if (!Number.isFinite(Date.parse(text))) throw new Error(`${label} must be a valid RFC3339 timestamp`);
  return text;
}

function normalizeSource(value) {
  const source = requireObject(value, 'source', ['id', 'label', 'reference']);
  if (typeof source.reference !== 'string' && source.reference !== null) {
    throw new Error('source.reference must be a string or null');
  }
  if (typeof source.reference === 'string' && (source.reference.length > 500 || source.reference.trim() !== source.reference)) {
    throw new Error('source.reference must be a trimmed string of at most 500 characters');
  }
  return {
    id: requireString(source.id, 'source.id', { maxLength: 64, pattern: /^[a-z][a-z0-9-]*$/ }),
    label: requireString(source.label, 'source.label'),
    reference: source.reference
  };
}

function normalizeFreshness(value) {
  const freshness = requireObject(value, 'freshness', ['status', 'observed_at', 'evaluated_at', 'max_age_seconds']);
  const status = requireString(freshness.status, 'freshness.status', { maxLength: 10 });
  if (!['fresh', 'stale', 'unknown'].includes(status)) throw new Error('freshness.status must be fresh, stale, or unknown');
  const observedAt = freshness.observed_at === null
    ? null
    : validateObservationTimestamp(freshness.observed_at, 'freshness.observed_at');
  const evaluatedAt = freshness.evaluated_at === null
    ? null
    : validateObservationTimestamp(freshness.evaluated_at, 'freshness.evaluated_at');
  const maxAge = freshness.max_age_seconds === null
    ? null
    : requireFiniteNumber(freshness.max_age_seconds, 'freshness.max_age_seconds');
  if (maxAge !== null && (!Number.isSafeInteger(maxAge) || maxAge < 0)) {
    throw new Error('freshness.max_age_seconds must be a nonnegative integer or null');
  }
  if (status === 'unknown') {
    if (observedAt !== null || evaluatedAt !== null || maxAge !== null) {
      throw new Error('unknown freshness must use null timestamps and max_age_seconds');
    }
  } else {
    if (!observedAt || !evaluatedAt || maxAge === null) {
      throw new Error('fresh or stale freshness requires observed_at, evaluated_at, and max_age_seconds');
    }
    const ageMs = Date.parse(evaluatedAt) - Date.parse(observedAt);
    if (ageMs < 0) throw new Error('freshness.evaluated_at cannot precede observed_at');
    const shouldBeFresh = ageMs <= maxAge * 1000;
    if ((status === 'fresh') !== shouldBeFresh) {
      throw new Error('freshness.status does not match its timestamps and max_age_seconds');
    }
  }
  return { status, observed_at: observedAt, evaluated_at: evaluatedAt, max_age_seconds: maxAge };
}

function normalizeBaseline(value, label, sourceId) {
  if (value === undefined || value === null) return null;
  const baseline = requireObject(value, label, ['status', 'value', 'observed_days', 'window_days', 'scope', 'source_id']);
  const status = requireString(baseline.status, `${label}.status`, { maxLength: 12 });
  if (!['complete', 'partial', 'unavailable', 'unknown'].includes(status)) {
    throw new Error(`${label}.status must be complete, partial, unavailable, or unknown`);
  }
  const baselineValue = baseline.value === null ? null : requireFiniteNumber(baseline.value, `${label}.value`);
  const observedDays = baseline.observed_days === null ? null : baseline.observed_days;
  const windowDays = baseline.window_days === null ? null : baseline.window_days;
  for (const [field, number] of [['observed_days', observedDays], ['window_days', windowDays]]) {
    if (number !== null && (!Number.isSafeInteger(number) || number < 0)) {
      throw new Error(`${label}.${field} must be a nonnegative integer or null`);
    }
  }
  if (windowDays !== null && (windowDays < 1 || windowDays > 365)) {
    throw new Error(`${label}.window_days must be from 1 to 365 or null`);
  }
  if (observedDays !== null && windowDays !== null && observedDays > windowDays) {
    throw new Error(`${label}.observed_days cannot exceed window_days`);
  }
  const scope = requireString(baseline.scope, `${label}.scope`, { maxLength: 20 });
  if (!['source', 'legacy_unscoped', 'external'].includes(scope)) {
    throw new Error(`${label}.scope must be source, legacy_unscoped, or external`);
  }
  const source = baseline.source_id === null
    ? null
    : requireString(baseline.source_id, `${label}.source_id`, { maxLength: 64, pattern: /^[a-z][a-z0-9-]*$/ });
  if (scope === 'source' && source !== sourceId) throw new Error(`${label}.source_id must match the observation source`);
  if (scope !== 'source' && source !== null) throw new Error(`${label}.source_id must be null unless scope is source`);

  if (status === 'complete' && (baselineValue === null || observedDays === null || windowDays === null || windowDays < 1 || observedDays !== windowDays)) {
    throw new Error(`${label} complete status requires a value and complete day coverage`);
  }
  if (status === 'partial' && (baselineValue === null || observedDays === null || windowDays === null || observedDays < 1 || observedDays >= windowDays)) {
    throw new Error(`${label} partial status requires a value and partial day coverage`);
  }
  if (status === 'unavailable' && (baselineValue !== null || observedDays !== 0 || windowDays === null)) {
    throw new Error(`${label} unavailable status requires a null value, zero observed days, and a window`);
  }
  if (status === 'unknown' && (observedDays !== null || windowDays !== null)) {
    throw new Error(`${label} unknown coverage requires null observed_days and window_days`);
  }
  return {
    status,
    value: baselineValue,
    observed_days: observedDays,
    window_days: windowDays,
    scope,
    source_id: source
  };
}

function normalizeMetric(value, label, date, sourceId, { score = false } = {}) {
  const allowed = ['metric', 'status', 'value', 'unit', 'observed_at', 'observed_date', 'source_ref'];
  if (!score) allowed.push('baseline');
  const metric = requireObject(value, label, allowed);
  const id = requireString(metric.metric, `${label}.metric`, { maxLength: 64, pattern: /^[a-z][a-z0-9_]*$/ });
  const status = requireString(metric.status, `${label}.status`, { maxLength: 12 });
  if (!['observed', 'missing', 'unsupported'].includes(status)) {
    throw new Error(`${label}.status must be observed, missing, or unsupported`);
  }
  const number = metric.value === null ? null : requireFiniteNumber(metric.value, `${label}.value`);
  if ((status === 'observed') !== (number !== null)) {
    throw new Error(`${label}.value must be numeric only when status is observed`);
  }
  const observedAt = metric.observed_at === null
    ? null
    : validateObservationTimestamp(metric.observed_at, `${label}.observed_at`);
  const observedDate = metric.observed_date === null
    ? null
    : validateObservationDate(metric.observed_date, `${label}.observed_date`);
  if (observedAt !== null && observedDate !== null) {
    throw new Error(`${label} must use observed_at or observed_date, not both`);
  }
  if (status !== 'observed' && (observedAt !== null || observedDate !== null)) {
    throw new Error(`${label} missing or unsupported metrics cannot have observation timestamps`);
  }
  const sourceRef = metric.source_ref === null
    ? null
    : requireString(metric.source_ref, `${label}.source_ref`, { maxLength: 200 });
  const normalized = {
    metric: id,
    status,
    value: number,
    unit: requireString(metric.unit, `${label}.unit`, { maxLength: 40 }),
    observed_at: observedAt,
    observed_date: observedDate,
    source_ref: sourceRef
  };
  if (!score) normalized.baseline = normalizeBaseline(metric.baseline, `${label}.baseline`, sourceId);
  if (observedDate && observedDate > date) throw new Error(`${label}.observed_date cannot be after the observation-set date`);
  if (observedAt && observedAt.slice(0, 10) > date) throw new Error(`${label}.observed_at cannot be after the observation-set date`);
  return normalized;
}

function normalizeMetricList(value, label, date, sourceId, options) {
  if (!Array.isArray(value) || value.length > 100) throw new Error(`${label} must be an array with at most 100 entries`);
  const normalized = value.map((item, index) => normalizeMetric(item, `${label}[${index}]`, date, sourceId, options));
  const seen = new Set();
  for (const item of normalized) {
    if (seen.has(item.metric)) throw new Error(`${label} contains duplicate metric ${item.metric}`);
    seen.add(item.metric);
  }
  return normalized.sort((left, right) => left.metric.localeCompare(right.metric));
}

export function validateWearableObservationSet(input) {
  const value = requireObject(input, 'observation set', [
    'schema_version', 'date', 'source', 'freshness', 'physical_metrics', 'proprietary_scores'
  ]);
  if (value.schema_version !== WEARABLE_OBSERVATION_SCHEMA_VERSION) {
    throw new Error(`observation set schema_version must be ${WEARABLE_OBSERVATION_SCHEMA_VERSION}`);
  }
  const date = validateObservationDate(value.date, 'date');
  const source = normalizeSource(value.source);
  const physicalMetrics = normalizeMetricList(value.physical_metrics, 'physical_metrics', date, source.id);
  const proprietaryScores = normalizeMetricList(value.proprietary_scores, 'proprietary_scores', date, source.id, { score: true });
  const physicalIds = new Set(physicalMetrics.map((metric) => metric.metric));
  const overlap = proprietaryScores.find((score) => physicalIds.has(score.metric));
  if (overlap) throw new Error(`metric ${overlap.metric} cannot appear as both a physical metric and proprietary score`);
  return {
    schema_version: WEARABLE_OBSERVATION_SCHEMA_VERSION,
    date,
    source,
    freshness: normalizeFreshness(value.freshness),
    physical_metrics: physicalMetrics,
    proprietary_scores: proprietaryScores
  };
}
