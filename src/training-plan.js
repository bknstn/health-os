import fs from 'node:fs';

import { digestBytes } from './cli-contract.js';
import { atomicWriteFileSync } from './coordination.js';

const MAX_PLAN_BYTES = 512 * 1024;
const DAY_KEY = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const EXERCISE_KEY = /^[a-z][a-z0-9_]{0,63}$/;
const REPLACEMENT_FIELDS = new Set([
  'exercise_key', 'exercise_name', 'movement_pattern', 'sets', 'reps_min', 'reps_max',
  'progression_type', 'load_tier', 'increment_kg', 'optional', 'notes', 'rest_seconds', 'load_mode'
]);

function planError(message, code = 'HEALTH_OS_TRAINING_PLAN_INVALID') {
  return Object.assign(new Error(message), { code });
}

function boundedInteger(value, min, max) {
  return Number.isSafeInteger(value) && value >= min && value <= max;
}

function validateTrainingPlan(plan) {
  if (!plan || typeof plan !== 'object' || Array.isArray(plan) || plan.version !== 1 ||
      !plan.days || typeof plan.days !== 'object' || Array.isArray(plan.days)) {
    throw planError('training-plan.json must contain version 1 and a days object');
  }
  const dayKeys = Object.keys(plan.days);
  if (dayKeys.length < 1 || dayKeys.length > 20 || dayKeys.some((key) => !DAY_KEY.test(key))) {
    throw planError('training-plan.json must contain 1-20 bounded plan day keys');
  }
  const dayLimits = plan.day_limits_minutes === undefined ? {} : plan.day_limits_minutes;
  if (!dayLimits || typeof dayLimits !== 'object' || Array.isArray(dayLimits) ||
      Object.entries(dayLimits).some(([day, limit]) => !Object.hasOwn(plan.days, day) || !boundedInteger(limit, 1, 1440))) {
    throw planError('day_limits_minutes must map existing plan days to integers from 1 to 1440');
  }
  const catalog = new Map();
  for (const dayKey of dayKeys) {
    const entries = plan.days[dayKey];
    if (!Array.isArray(entries) || entries.length > 50) throw planError(`training-plan day ${dayKey} must be an array of at most 50 exercises`);
    const seen = new Set();
    for (const entry of entries) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry) ||
          typeof entry.exercise_key !== 'string' || !EXERCISE_KEY.test(entry.exercise_key) ||
          typeof entry.exercise_name !== 'string' || !entry.exercise_name.trim() ||
          !Number.isSafeInteger(entry.sets) || entry.sets < 1 || entry.sets > 20 ||
          !Number.isSafeInteger(entry.reps_min) || entry.reps_min < 1 || entry.reps_min > 100 ||
          !Number.isSafeInteger(entry.reps_max) || entry.reps_max < entry.reps_min || entry.reps_max > 100 ||
          typeof entry.progression_type !== 'string' || !['upper_lower_load', 'reps_first', 'quality_first'].includes(entry.progression_type) ||
          typeof entry.load_tier !== 'string' ||
          (entry.load_mode !== undefined && entry.load_mode !== 'bodyweight') ||
          (entry.rest_seconds !== undefined && !boundedInteger(entry.rest_seconds, 0, 3600))) {
        throw planError(`training-plan day ${dayKey} contains an invalid exercise entry`);
      }
      if (seen.has(entry.exercise_key)) throw planError(`training-plan day ${dayKey} contains duplicate exercise ${entry.exercise_key}`);
      seen.add(entry.exercise_key);
      if (!catalog.has(entry.exercise_key)) catalog.set(entry.exercise_key, entry);
    }
  }
  return { days: plan.days, dayKeys, catalog, dayLimits: Object.assign(Object.create(null), dayLimits) };
}

export function assertTrainingPlanFile(paths) {
  const stat = fs.lstatSync(paths.trainingPlanFile, { throwIfNoEntry: false });
  if (!stat?.isFile()) throw planError('training plan must be an existing regular, non-symlink file');
  if (stat.size > MAX_PLAN_BYTES) throw planError('training plan exceeds the 524288-byte limit');
}

export function readTrainingPlan(paths) {
  assertTrainingPlanFile(paths);
  const bytes = fs.readFileSync(paths.trainingPlanFile);
  if (bytes.length > MAX_PLAN_BYTES) throw planError('training plan exceeds the 524288-byte limit');
  let config;
  try {
    config = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw planError('training plan is invalid JSON');
  }
  return { config, plan: validateTrainingPlan(config), revision: digestBytes(bytes) };
}

function dayExercises(plan, day) {
  if (typeof day !== 'string' || !DAY_KEY.test(day) || !Object.hasOwn(plan.days, day)) {
    throw planError('Select an existing plan day with --day', 'HEALTH_OS_TRAINING_PLAN_DAY_NOT_FOUND');
  }
  return plan.days[day];
}

export function showTrainingPlan(paths, day) {
  const { plan, revision } = readTrainingPlan(paths);
  const exercises = dayExercises(plan, day);
  return {
    day,
    revision,
    duration_limit_minutes: plan.dayLimits[day] ?? null,
    exercises
  };
}

// The caller holds the workspace lock across the revision check, write and journal update.
export function replacePlanExercise(paths, { day, exercise, replacement, expectedRevision, durationLimit }) {
  if (!/^[a-f0-9]{64}$/.test(expectedRevision ?? '')) {
    throw planError('--expected-revision must be the revision from training-plan-show');
  }
  if (!EXERCISE_KEY.test(exercise ?? '')) throw planError('--exercise must be a valid source exercise key');
  if (durationLimit !== undefined && !boundedInteger(durationLimit, 1, 1440)) {
    throw planError('--duration-limit-minutes must be an integer from 1 to 1440');
  }
  if (!replacement || typeof replacement !== 'object' || Array.isArray(replacement) ||
      Object.keys(replacement).some((key) => !REPLACEMENT_FIELDS.has(key)) ||
      (replacement.increment_kg !== undefined &&
        (!Number.isFinite(replacement.increment_kg) || replacement.increment_kg < 0)) ||
      (replacement.optional !== undefined && typeof replacement.optional !== 'boolean') ||
      (replacement.notes !== undefined && (typeof replacement.notes !== 'string' || replacement.notes.length > 500)) ||
      (replacement.movement_pattern !== undefined &&
        (typeof replacement.movement_pattern !== 'string' || replacement.movement_pattern.length > 100)) ||
      (typeof replacement.load_tier === 'string' && replacement.load_tier.length > 100) ||
      (typeof replacement.exercise_name === 'string' && replacement.exercise_name.length > 200)) {
    throw planError('replacement must be a valid exercise object with supported fields');
  }

  const { config, plan, revision } = readTrainingPlan(paths);
  if (revision !== expectedRevision) {
    throw planError('Training plan changed. Read training-plan-show again before replacing the exercise.',
      'HEALTH_OS_TRAINING_PLAN_REVISION_CONFLICT');
  }
  const entries = dayExercises(plan, day);
  const position = entries.findIndex((entry) => entry.exercise_key === exercise);
  if (position === -1) {
    throw planError('Source exercise is absent from the selected day', 'HEALTH_OS_TRAINING_PLAN_EXERCISE_NOT_FOUND');
  }
  if (entries.some((entry, index) => index !== position && entry.exercise_key === replacement.exercise_key)) {
    throw planError('Replacement exercise already exists on the selected day', 'HEALTH_OS_TRAINING_PLAN_DUPLICATE_EXERCISE');
  }

  const newEntry = { increment_kg: 0, ...replacement };
  entries[position] = newEntry;
  if (durationLimit !== undefined) {
    config.day_limits_minutes = { ...plan.dayLimits, [day]: durationLimit };
  }
  validateTrainingPlan(config);
  const content = Buffer.from(JSON.stringify(config, null, 2) + '\n');
  if (content.length > MAX_PLAN_BYTES) throw planError('Updated training plan exceeds the 524288-byte limit');
  const result = {
    status: 'saved',
    day,
    replaced_exercise_key: exercise,
    position,
    exercise: newEntry,
    duration_limit_minutes: durationLimit ?? plan.dayLimits[day] ?? null,
    revision: digestBytes(content)
  };
  atomicWriteFileSync(paths.trainingPlanFile, content, { mode: 0o600 });
  return result;
}
