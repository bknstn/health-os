import fs from 'node:fs';

import {
  validateObservationDate,
  validateObservationTimestamp
} from './wearable-observation-contract.js';

const DAY_NAMES = new Set(['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']);
const EVENT_TYPE = /^[a-z][a-z0-9_.-]{0,63}$/;
const EXERCISE_KEY = /^[a-z][a-z0-9_]{0,63}$/;

function policyError(code, message) {
  return Object.assign(new Error(message), { code });
}

function object(value, label, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw policyError('HEALTH_OS_PREPARATION_POLICY_INVALID', `${label} must be an object`);
  }
  if (keys && Object.keys(value).some((key) => !keys.includes(key))) {
    const key = Object.keys(value).find((candidate) => !keys.includes(candidate));
    throw policyError('HEALTH_OS_PREPARATION_POLICY_INVALID', `${label} contains unsupported field "${key}"`);
  }
  return value;
}

function boundedInteger(value, label, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw policyError('HEALTH_OS_PREPARATION_POLICY_INVALID', `${label} must be an integer from ${minimum} to ${maximum}`);
  }
}

function metricKey(value, label) {
  if (typeof value !== 'string' || !EXERCISE_KEY.test(value)) {
    throw policyError('HEALTH_OS_PREPARATION_POLICY_INVALID', `${label} must be a lowercase identifier`);
  }
  return value;
}

function dayTypeKey(value, label) {
  if (typeof value !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(value)) {
    throw policyError('HEALTH_OS_PREPARATION_POLICY_INVALID', `${label} must be a bounded plan day-type key`);
  }
  return value;
}

export function validatePreparationAsOf(value) {
  if (typeof value !== 'string') {
    throw new Error('--as-of must be YYYY-MM-DD or an RFC3339 timestamp');
  }
  try {
    const date = validateObservationDate(value, '--as-of');
    return { kind: 'date', value: date, date, timestamp: null };
  } catch {
    const timestamp = validateObservationTimestamp(value, '--as-of');
    return {
      kind: 'timestamp',
      value: timestamp,
      date: new Date(Date.parse(timestamp)).toISOString().slice(0, 10),
      timestamp
    };
  }
}

export function loadPreparationPolicy(paths) {
  if (!fs.existsSync(paths.preparationPolicyFile)) {
    throw policyError('HEALTH_OS_PREPARATION_POLICY_MISSING', `Preparation policy is missing: ${paths.preparationPolicyFile}; initialize the workspace to create the default policy`);
  }
  let policy;
  try {
    const stat = fs.statSync(paths.preparationPolicyFile);
    if (!stat.isFile() || stat.size > 64 * 1024) {
      throw new Error('preparation policy must be a regular file no larger than 65536 bytes');
    }
    policy = JSON.parse(fs.readFileSync(paths.preparationPolicyFile, 'utf8'));
  } catch (error) {
    throw policyError('HEALTH_OS_PREPARATION_POLICY_INVALID', `Cannot read preparation policy: ${error.message}`);
  }
  object(policy, 'preparation policy', ['version', 'session_selection', 'substitutions', 'recovery', 'subjective']);
  if (policy.version !== 1) throw policyError('HEALTH_OS_PREPARATION_POLICY_INVALID', 'preparation policy version must be 1');

  const selection = object(policy.session_selection, 'session_selection', [
    'strategy', 'first_day_type', 'weekday_day_types', 'allow_explicit_session'
  ]);
  if (selection.strategy !== 'weekday_then_alternate') {
    throw policyError('HEALTH_OS_PREPARATION_POLICY_INVALID', 'session_selection.strategy must be weekday_then_alternate');
  }
  if (selection.first_day_type !== 'first_plan_key') dayTypeKey(selection.first_day_type, 'session_selection.first_day_type');
  const weekdayMap = object(selection.weekday_day_types, 'session_selection.weekday_day_types');
  for (const [weekday, dayType] of Object.entries(weekdayMap)) {
    if (!DAY_NAMES.has(weekday)) throw policyError('HEALTH_OS_PREPARATION_POLICY_INVALID', `Unsupported weekday "${weekday}"`);
    dayTypeKey(dayType, `session_selection.weekday_day_types.${weekday}`);
  }
  if (typeof selection.allow_explicit_session !== 'boolean') {
    throw policyError('HEALTH_OS_PREPARATION_POLICY_INVALID', 'session_selection.allow_explicit_session must be a boolean');
  }

  const substitutions = object(policy.substitutions, 'substitutions', ['max_per_session', 'allowed']);
  boundedInteger(substitutions.max_per_session, 'substitutions.max_per_session', 0, 10);
  if (!Array.isArray(substitutions.allowed) || substitutions.allowed.length > 100) {
    throw policyError('HEALTH_OS_PREPARATION_POLICY_INVALID', 'substitutions.allowed must be an array of at most 100 entries');
  }
  const substitutionPairs = new Set();
  substitutions.allowed.forEach((entry, index) => {
    object(entry, `substitutions.allowed[${index}]`, ['from', 'to']);
    const from = metricKey(entry.from, `substitutions.allowed[${index}].from`);
    const to = metricKey(entry.to, `substitutions.allowed[${index}].to`);
    const pair = `${from}\u0000${to}`;
    if (from === to || substitutionPairs.has(pair)) {
      throw policyError('HEALTH_OS_PREPARATION_POLICY_INVALID', `substitutions.allowed[${index}] is duplicate or self-referential`);
    }
    substitutionPairs.add(pair);
  });

  const recovery = object(policy.recovery, 'recovery', [
    'max_age_days', 'baseline_window_days', 'baseline_min_observed_days', 'allow_legacy_unscoped_baseline'
  ]);
  boundedInteger(recovery.max_age_days, 'recovery.max_age_days', 0, 30);
  boundedInteger(recovery.baseline_window_days, 'recovery.baseline_window_days', 1, 365);
  boundedInteger(recovery.baseline_min_observed_days, 'recovery.baseline_min_observed_days', 1, recovery.baseline_window_days);
  if (typeof recovery.allow_legacy_unscoped_baseline !== 'boolean') {
    throw policyError('HEALTH_OS_PREPARATION_POLICY_INVALID', 'recovery.allow_legacy_unscoped_baseline must be a boolean');
  }

  const subjective = object(policy.subjective, 'subjective', ['max_age_days', 'events']);
  boundedInteger(subjective.max_age_days, 'subjective.max_age_days', 0, 365);
  const eventDefinitions = object(subjective.events, 'subjective.events');
  if (Object.keys(eventDefinitions).length > 25) {
    throw policyError('HEALTH_OS_PREPARATION_POLICY_INVALID', 'subjective.events supports at most 25 event types');
  }
  for (const [eventType, rawDefinition] of Object.entries(eventDefinitions)) {
    if (!EVENT_TYPE.test(eventType)) throw policyError('HEALTH_OS_PREPARATION_POLICY_INVALID', `Invalid subjective event type "${eventType}"`);
    const definition = object(rawDefinition, `subjective.events.${eventType}`, ['field', 'minimum', 'maximum', 'adjustment']);
    metricKey(definition.field, `subjective.events.${eventType}.field`);
    if (typeof definition.minimum !== 'number' || !Number.isFinite(definition.minimum) ||
        typeof definition.maximum !== 'number' || !Number.isFinite(definition.maximum) || definition.minimum > definition.maximum) {
      throw policyError('HEALTH_OS_PREPARATION_POLICY_INVALID', `subjective.events.${eventType} requires finite minimum and maximum values`);
    }
    if (definition.adjustment !== null) {
      const adjustment = object(definition.adjustment, `subjective.events.${eventType}.adjustment`, [
        'operator', 'threshold', 'target_sets_delta'
      ]);
      if (!['lte', 'gte'].includes(adjustment.operator) || typeof adjustment.threshold !== 'number' ||
          !Number.isFinite(adjustment.threshold) || adjustment.threshold < definition.minimum || adjustment.threshold > definition.maximum) {
        throw policyError('HEALTH_OS_PREPARATION_POLICY_INVALID', `subjective.events.${eventType}.adjustment has an invalid operator or threshold`);
      }
      if (!Number.isSafeInteger(adjustment.target_sets_delta) || adjustment.target_sets_delta > 0 || adjustment.target_sets_delta < -5) {
        throw policyError('HEALTH_OS_PREPARATION_POLICY_INVALID', `subjective.events.${eventType}.adjustment.target_sets_delta must be an integer from -5 to 0`);
      }
    }
  }

  return policy;
}
