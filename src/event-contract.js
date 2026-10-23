import { randomUUID } from 'node:crypto';

export const HEALTH_EVENT_SCHEMA_VERSION = 1;
export const MAX_EVENT_DATA_BYTES = 16 * 1024;
export const MAX_EVENT_INPUT_BYTES = 64 * 1024;
export const MAX_SOURCE_REF_CHARS = 2_000;
export const MAX_SOURCE_FRAGMENT_CHARS = 128;
export const MAX_EVENT_TYPE_CHARS = 64;
export const MAX_EXTRACTION_VERSION_CHARS = 128;

const PRECISIONS = new Set(['instant', 'second', 'minute', 'hour', 'day', 'interval', 'unknown']);
const EPISTEMIC_STATUSES = new Set(['fact', 'pending']);
const UNCERTAINTY_LEVELS = new Set(['low', 'medium', 'high', 'unknown']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertExactKeys(value, allowed, field) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new Error(`${field} contains unsupported field "${key}"`);
  }
}

function validDay(value) {
  if (typeof value !== 'string' || !DAY.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function validTimestamp(value) {
  if (typeof value !== 'string' || !RFC3339.test(value)) return false;
  const fraction = value.match(/\.(\d+)/)?.[1] || '';
  if (fraction.length > 3) return false;
  const [datePart, clockAndZone] = [value.slice(0, 10), value.slice(11)];
  const clock = clockAndZone.replace(/(?:Z|[+-]\d{2}:\d{2})$/, '').split('.')[0];
  const [hour, minute, second] = clock.split(':').map(Number);
  const zone = value.match(/(Z|[+-]\d{2}:\d{2})$/)?.[1];
  if (!validDay(datePart) || hour > 23 || minute > 59 || second > 59) return false;
  if (zone !== 'Z') {
    const [offsetHour, offsetMinute] = zone.slice(1).split(':').map(Number);
    if (offsetHour > 14 || offsetMinute > 59 || (offsetHour === 14 && offsetMinute !== 0)) return false;
  }
  return Number.isFinite(Date.parse(value));
}

function validTimezone(value) {
  if (value === null) return true;
  if (typeof value !== 'string' || !value.trim() || [...value].length > 100) return false;
  if (value === 'Z' || /^[+-](?:0\d|1[0-4]):[0-5]\d$/.test(value)) {
    return !(value.endsWith(':60') || value.startsWith('+14:') && !value.endsWith(':00') || value.startsWith('-14:') && !value.endsWith(':00'));
  }
  try {
    new Intl.DateTimeFormat('en', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

function boundedString(value, field, maxChars, { allowEmpty = false } = {}) {
  if (typeof value !== 'string' || (!allowEmpty && value.trim() === '')) {
    throw new Error(`${field} must be ${allowEmpty ? 'a string' : 'a non-empty string'}`);
  }
  if ([...value].length > maxChars) throw new Error(`${field} exceeds ${maxChars} characters`);
  return value;
}

function validateJsonValue(value, field, depth = 0, state = { nodes: 0 }) {
  state.nodes += 1;
  if (state.nodes > 2_000 || depth > 10) throw new Error(`${field} exceeds the JSON complexity limit`);
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`${field} must contain only finite numbers`);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) validateJsonValue(item, field, depth + 1, state);
    return;
  }
  if (isPlainObject(value)) {
    for (const [key, item] of Object.entries(value)) {
      if ([...key].length > 200) throw new Error(`${field} contains a key longer than 200 characters`);
      validateJsonValue(item, field, depth + 1, state);
    }
    return;
  }
  throw new Error(`${field} must contain only JSON values`);
}

function validateOccurred(value) {
  if (!isPlainObject(value)) throw new Error('event.occurred must be an object');
  assertExactKeys(value, ['start', 'end', 'precision', 'timezone'], 'event.occurred');
  if (!Object.hasOwn(value, 'start') || !Object.hasOwn(value, 'end') ||
      !Object.hasOwn(value, 'precision') || !Object.hasOwn(value, 'timezone')) {
    throw new Error('event.occurred requires start, end, precision, and timezone fields');
  }
  const { start, end, precision, timezone } = value;
  if (!PRECISIONS.has(precision)) throw new Error(`event.occurred.precision must be one of ${[...PRECISIONS].join(', ')}`);
  if (!validTimezone(timezone)) {
    throw new Error('event.occurred.timezone must be null, a valid IANA time zone, Z, or a fixed offset up to ±14:00');
  }
  if (precision === 'unknown') {
    if (start !== null || end !== null) {
      throw new Error('unknown occurrence time requires null start and end; known timezone may be retained');
    }
  } else if (precision === 'day') {
    if (!validDay(start) || end !== null) {
      throw new Error('day precision requires a valid YYYY-MM-DD start and null end');
    }
  } else if (precision === 'interval') {
    const validBound = (bound) => validDay(bound) || validTimestamp(bound);
    if (!validBound(start) || !validBound(end) || (DAY.test(start) !== DAY.test(end))) {
      throw new Error('interval precision requires valid date or RFC3339 start and end bounds (timestamps support up to milliseconds)');
    }
    if ((DAY.test(start) && start > end) || (validTimestamp(start) && Date.parse(start) > Date.parse(end))) {
      throw new Error('interval precision start must not be after end');
    }
  } else if (!validTimestamp(start) || end !== null) {
    throw new Error(`${precision} precision requires an RFC3339 start with an explicit offset, at most millisecond precision, and null end`);
  } else {
    const clock = start.slice(11, 19);
    if (precision === 'hour' && (clock.slice(3) !== '00:00' || start.includes('.'))) throw new Error('hour precision requires minute and second components to be 00 with no fractional seconds');
    if (precision === 'minute' && (clock.slice(6) !== '00' || start.includes('.'))) throw new Error('minute precision requires seconds to be 00 with no fractional seconds');
    if (precision === 'second' && start.includes('.')) throw new Error('second precision must not include fractional seconds; use instant precision');
  }
  return { start, end, precision, timezone };
}

export function createHealthEvent(input, { profileId, eventId } = {}) {
  if (!isPlainObject(input)) throw new Error('HealthEvent must be a JSON object');
  assertExactKeys(input, [
    'schema_version', 'event_id', 'event_type', 'occurred', 'data', 'source',
    'extraction_version', 'epistemic_status', 'uncertainty'
  ], 'HealthEvent');
  if (input.schema_version !== HEALTH_EVENT_SCHEMA_VERSION) {
    throw new Error(`HealthEvent schema_version must be ${HEALTH_EVENT_SCHEMA_VERSION}`);
  }
  const stableEventId = input.event_id ?? eventId ?? randomUUID();
  if (typeof stableEventId !== 'string' || !UUID.test(stableEventId)) {
    throw new Error('HealthEvent event_id must be a UUID');
  }
  const eventType = boundedString(input.event_type, 'HealthEvent event_type', MAX_EVENT_TYPE_CHARS);
  if (!/^[a-z][a-z0-9_.-]*$/.test(eventType)) {
    throw new Error('HealthEvent event_type must be a lower-case slug');
  }
  const occurred = validateOccurred(input.occurred);
  if (!isPlainObject(input.data)) throw new Error('HealthEvent data must be an object; use null for unknown values');
  validateJsonValue(input.data, 'HealthEvent data');
  const dataBytes = Buffer.byteLength(JSON.stringify(input.data));
  if (dataBytes > MAX_EVENT_DATA_BYTES) throw new Error(`HealthEvent data exceeds ${MAX_EVENT_DATA_BYTES} bytes`);

  if (!isPlainObject(input.source)) throw new Error('HealthEvent source must be an object');
  assertExactKeys(input.source, ['kind', 'ref', 'fragment_id'], 'HealthEvent source');
  const source = {
    kind: boundedString(input.source.kind, 'HealthEvent source.kind', 64),
    ref: boundedString(input.source.ref, 'HealthEvent source.ref', MAX_SOURCE_REF_CHARS),
    fragment_id: boundedString(input.source.fragment_id ?? '0', 'HealthEvent source.fragment_id', MAX_SOURCE_FRAGMENT_CHARS)
  };
  if (!/^[a-z][a-z0-9_.-]*$/.test(source.kind)) throw new Error('HealthEvent source.kind must be a lower-case slug');

  const extractionVersion = boundedString(input.extraction_version, 'HealthEvent extraction_version', MAX_EXTRACTION_VERSION_CHARS);
  if (!EPISTEMIC_STATUSES.has(input.epistemic_status)) {
    throw new Error('HealthEvent epistemic_status must be fact or pending');
  }
  if (!isPlainObject(input.uncertainty)) throw new Error('HealthEvent uncertainty must be an object');
  assertExactKeys(input.uncertainty, ['level', 'note'], 'HealthEvent uncertainty');
  if (!UNCERTAINTY_LEVELS.has(input.uncertainty.level)) {
    throw new Error('HealthEvent uncertainty.level must be low, medium, high, or unknown');
  }
  const uncertaintyNote = input.uncertainty.note ?? null;
  if (uncertaintyNote !== null && typeof uncertaintyNote !== 'string') {
    throw new Error('HealthEvent uncertainty.note must be a string or null');
  }
  if (uncertaintyNote !== null && [...uncertaintyNote].length > 1_000) {
    throw new Error('HealthEvent uncertainty.note exceeds 1000 characters');
  }

  return {
    schema_version: HEALTH_EVENT_SCHEMA_VERSION,
    event_id: stableEventId.toLowerCase(),
    profile_id: boundedString(profileId, 'profile_id', 512),
    event_type: eventType,
    occurred,
    data: input.data,
    source,
    extraction_version: extractionVersion,
    epistemic_status: input.epistemic_status,
    uncertainty: { level: input.uncertainty.level, note: uncertaintyNote }
  };
}

export function validateEventId(eventId) {
  if (typeof eventId !== 'string' || !UUID.test(eventId)) throw new Error('event id must be a UUID');
  return eventId.toLowerCase();
}

export function validateEventRequestKey(key) {
  if (typeof key !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(key)) {
    throw new Error('idempotency key must be 1-128 letters, digits, dot, underscore, colon, or hyphen');
  }
  return key;
}

export function eventSourceIdentity(event) {
  return JSON.stringify([event.profile_id, event.source.kind, event.source.ref, event.source.fragment_id]);
}

export function isValidOccurrenceBound(value) {
  return validDay(value) || validTimestamp(value);
}
