import fs from 'node:fs';
import path from 'node:path';

import { readCsv } from './csv.js';
import { modeFromMetrics, buildWorkoutCard, CSV_HEADERS } from './engine.js';
import { assertEventMemoryReviewMatchesStore, queryEvents } from './event-store.js';
import { assertMemoryEventProvenanceCurrent } from './event-memory-review.js';
import { parseFrontmatter } from './memory.js';
import { loadPreparationPolicy } from './preparation-policy.js';
import { readSelectedProfile } from './workspace-contract.js';
import { readWearableObservationStore } from './wearable-observation-store.js';

const MAX_CONFIG_BYTES = 512 * 1024;
const MAX_CSV_BYTES = 8 * 1024 * 1024;
const MAX_MEMORY_FILES = 200;
const MAX_MEMORY_PAGE_BYTES = 128 * 1024;
const MAX_PROFILE_CHARS = 6_000;
const MAX_MEMORY_PAGES = 5;
const MAX_MEMORY_PAGE_CHARS = 1_000;

function preparationError(message, code = 'HEALTH_OS_PREPARATION_INVALID') {
  return Object.assign(new Error(message), { code });
}

function readRegularFile(filePath, maxBytes, label) {
  let stat;
  try { stat = fs.lstatSync(filePath); }
  catch (error) {
    if (error.code === 'ENOENT') return null;
    throw preparationError(`Cannot inspect ${label}: ${error.message}`);
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw preparationError(`${label} must be a regular, non-symlink file`);
  }
  if (stat.size > maxBytes) throw preparationError(`${label} exceeds the ${maxBytes}-byte preparation limit`);
  try { return fs.readFileSync(filePath); }
  catch (error) { throw preparationError(`Cannot read ${label}: ${error.message}`); }
}

function readJsonFile(filePath, label, maxBytes = MAX_CONFIG_BYTES) {
  const bytes = readRegularFile(filePath, maxBytes, label);
  if (!bytes) throw preparationError(`${label} is missing`);
  try { return JSON.parse(bytes.toString('utf8')); }
  catch (error) { throw preparationError(`${label} is invalid JSON: ${error.message}`); }
}

function readCsvFile(filePath, headers, label) {
  const bytes = readRegularFile(filePath, MAX_CSV_BYTES, label);
  if (!bytes) return { rows: [], missing: true };
  try { return { rows: readCsv(filePath, headers), missing: false }; }
  catch (error) { throw preparationError(`${label} is malformed: ${error.message}`); }
}

function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function parsedInstant(value) {
  if (typeof value !== 'string' || !value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function dayDistance(older, newer) {
  if (!validDate(older) || !validDate(newer)) return null;
  return (Date.parse(`${newer}T00:00:00.000Z`) - Date.parse(`${older}T00:00:00.000Z`)) / 86_400_000;
}

function cutoffContainsInstant(asOf, timestamp) {
  const instant = parsedInstant(timestamp);
  if (instant === null) return false;
  return asOf.kind === 'date'
    ? instant <= Date.parse(`${asOf.date}T23:59:59.999Z`)
    : instant <= Date.parse(asOf.timestamp);
}

function dateIsBeforeOrAt(value, asOf) {
  if (!validDate(value)) return false;
  return asOf.kind === 'date' ? value <= asOf.date : value < asOf.date;
}

function rowAllowedByAsOf(row, dateKey, timestampKey, asOf) {
  const day = row[dateKey];
  if (!validDate(day)) return false;
  const timestamp = row[timestampKey];
  if (day > asOf.date) return false;
  if (!timestamp) return asOf.kind === 'date' ? day <= asOf.date : day < asOf.date;
  if (validDate(timestamp)) {
    return asOf.kind === 'date'
      ? timestamp <= asOf.date
      : timestamp < asOf.date;
  }
  return cutoffContainsInstant(asOf, timestamp);
}

function strictNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || !value.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function addUtcDays(date, days) {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function validateTrainingPlan(plan) {
  if (!plan || typeof plan !== 'object' || Array.isArray(plan) || plan.version !== 1 ||
      !plan.days || typeof plan.days !== 'object' || Array.isArray(plan.days)) {
    throw preparationError('training-plan.json must contain version 1 and a days object');
  }
  const dayKeys = Object.keys(plan.days);
  if (dayKeys.length < 1 || dayKeys.length > 20 || dayKeys.some((key) => !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(key))) {
    throw preparationError('training-plan.json must contain 1-20 bounded plan day keys');
  }
  const catalog = new Map();
  for (const dayKey of dayKeys) {
    const entries = plan.days[dayKey];
    if (!Array.isArray(entries) || entries.length > 50) throw preparationError(`training-plan day ${dayKey} must be an array of at most 50 exercises`);
    const seen = new Set();
    for (const entry of entries) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry) ||
          typeof entry.exercise_key !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(entry.exercise_key) ||
          typeof entry.exercise_name !== 'string' || !entry.exercise_name.trim() ||
          !Number.isSafeInteger(entry.sets) || entry.sets < 1 || entry.sets > 20 ||
          !Number.isSafeInteger(entry.reps_min) || entry.reps_min < 1 || entry.reps_min > 100 ||
          !Number.isSafeInteger(entry.reps_max) || entry.reps_max < entry.reps_min || entry.reps_max > 100 ||
          typeof entry.progression_type !== 'string' || !['upper_lower_load', 'reps_first', 'quality_first'].includes(entry.progression_type) ||
          typeof entry.load_tier !== 'string') {
        throw preparationError(`training-plan day ${dayKey} contains an invalid exercise entry`);
      }
      if (seen.has(entry.exercise_key)) throw preparationError(`training-plan day ${dayKey} contains duplicate exercise ${entry.exercise_key}`);
      seen.add(entry.exercise_key);
      if (!catalog.has(entry.exercise_key)) catalog.set(entry.exercise_key, entry);
    }
  }
  return { days: plan.days, dayKeys, catalog };
}

function validateRules(rules) {
  if (!rules || typeof rules !== 'object' || Array.isArray(rules) || rules.version !== 1 ||
      !rules.thresholds || !rules.weights || !rules.cutoffs || !rules.light_mode) {
    throw preparationError('rules.json is missing required version 1 decision fields');
  }
  const required = {
    thresholds: ['readiness_high', 'readiness_mid', 'sleep_high', 'sleep_mid', 'hrv_delta_ok', 'resting_hr_delta_ok', 'rpe_heavy', 'soreness_heavy'],
    weights: ['readiness_high', 'readiness_mid', 'readiness_low', 'sleep_high', 'sleep_mid', 'sleep_low', 'hrv_ok', 'hrv_bad', 'rhr_ok', 'rhr_bad', 'rpe_penalty', 'soreness_penalty'],
    cutoffs: ['full_min_score', 'base_min_score'],
    light_mode: ['load_multiplier', 'set_reduction']
  };
  for (const [section, keys] of Object.entries(required)) {
    for (const key of keys) {
      if (typeof rules[section][key] !== 'number' || !Number.isFinite(rules[section][key])) {
        throw preparationError(`rules.json is missing a finite ${section}.${key}`);
      }
    }
  }
  return rules;
}

function validateExerciseSettings(settings) {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings) || settings.version !== 1 ||
      !settings.exercises || typeof settings.exercises !== 'object' || Array.isArray(settings.exercises)) {
    throw preparationError('exercise-settings.json must contain version 1 and an exercises object');
  }
  for (const [key, item] of Object.entries(settings.exercises)) {
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(key) || !item || typeof item !== 'object' || Array.isArray(item)) {
      throw preparationError(`exercise-settings.json contains invalid settings for ${key}`);
    }
    if (item.working_weight_kg !== '' && (strictNumber(item.working_weight_kg) === null || strictNumber(item.working_weight_kg) <= 0 ||
        (typeof item.working_weight_kg === 'string' && !item.working_weight_kg.trim()))) {
      throw preparationError(`exercise-settings.json has an invalid working_weight_kg for ${key}`);
    }
    if (typeof item.increment_kg !== 'number' || !Number.isFinite(item.increment_kg) || item.increment_kg < 0) {
      throw preparationError(`exercise-settings.json has an invalid increment_kg for ${key}`);
    }
  }
  return settings.exercises;
}

function selectDayType({ asOf, plan, policy, sessions, explicitSession }) {
  const weekday = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'][new Date(`${asOf.date}T00:00:00.000Z`).getUTCDay()];
  const selection = policy.session_selection;
  let selected;
  let strategy;
  let reason;
  if (explicitSession !== undefined) {
    if (!selection.allow_explicit_session) throw preparationError('preparation policy does not allow --session');
    if (!plan.dayKeys.includes(explicitSession)) throw preparationError(`--session must match a plan day key (${plan.dayKeys.join(', ')})`);
    selected = explicitSession;
    strategy = 'explicit';
    reason = 'selected by explicit --session';
  } else if (Object.hasOwn(selection.weekday_day_types, weekday)) {
    selected = selection.weekday_day_types[weekday];
    strategy = 'weekday_mapping';
    reason = `configured weekday assignment: ${weekday}`;
  } else {
    const latest = [...sessions]
      .filter((item) => item.completed_flag === 'true' && plan.dayKeys.includes(item.day_type))
      .sort((left, right) => right.date.localeCompare(left.date) || right.session_id.localeCompare(left.session_id))[0];
    if (latest) {
      const index = plan.dayKeys.indexOf(latest.day_type);
      selected = plan.dayKeys[(index + 1) % plan.dayKeys.length];
      strategy = 'alternate_after_latest_completed';
      reason = `next plan day after completed ${latest.day_type} session ${latest.session_id}`;
    } else {
      selected = selection.first_day_type === 'first_plan_key' ? plan.dayKeys[0] : selection.first_day_type;
      strategy = 'first_plan_day';
      reason = 'no completed eligible session exists';
    }
  }
  if (!plan.dayKeys.includes(selected)) throw preparationError(`preparation policy selects unknown plan day ${selected}`);
  return { requested_day_type: explicitSession ?? null, selected_day_type: selected, strategy, reason, explicit: explicitSession !== undefined, weekday };
}

function parseSubstitutions(raw, policy, entries, plan) {
  if (raw === undefined) return { entries, substitutions: [] };
  if (typeof raw !== 'string' || raw.length > 512) throw preparationError('--substitute must be a comma-separated list of approved FROM=TO pairs');
  const pairs = raw.split(',').map((part) => part.trim());
  if (!pairs.length || pairs.length > policy.substitutions.max_per_session || pairs.some((pair) => !pair)) {
    throw preparationError(`--substitute accepts 1-${policy.substitutions.max_per_session} approved pairs`);
  }
  const seenFrom = new Set();
  const substitutions = [];
  const replacements = new Map();
  for (const pair of pairs) {
    const match = /^([a-z][a-z0-9_]{0,63})=([a-z][a-z0-9_]{0,63})$/.exec(pair);
    if (!match) throw preparationError(`Invalid substitution pair ${pair}`);
    const [, from, to] = match;
    if (seenFrom.has(from)) throw preparationError(`--substitute contains duplicate source exercise ${from}`);
    seenFrom.add(from);
    const allowed = policy.substitutions.allowed.some((item) => item.from === from && item.to === to);
    if (!allowed) throw preparationError(`Substitution ${from}=${to} is not approved by preparation policy`);
    if (!plan.catalog.has(to)) throw preparationError(`Substitution target exercise ${to} is not present in the training plan`);
    const sourceIndex = entries.findIndex((entry) => entry.exercise_key === from);
    if (sourceIndex < 0) throw preparationError(`Substitution source exercise ${from} is not in the selected session`);
    if (entries.some((entry) => entry.exercise_key === to && entry.exercise_key !== from)) {
      throw preparationError(`Substitution target ${to} is already in the selected session`);
    }
    replacements.set(from, plan.catalog.get(to));
    substitutions.push({ from, to });
  }
  return {
    entries: entries.map((entry) => replacements.get(entry.exercise_key) || entry),
    substitutions
  };
}

function effectiveWorkoutSessions(rows, asOf, plan, gaps) {
  const eligible = [];
  const seenIds = new Set();
  for (const row of rows) {
    if (!row.session_id || seenIds.has(row.session_id)) {
      gaps.push({ code: 'invalid_workout_session_identity', detail: 'A workout session had a missing or duplicate session_id and was excluded.' });
      continue;
    }
    seenIds.add(row.session_id);
    if (!validDate(row.date) || !plan.dayKeys.includes(row.day_type)) {
      gaps.push({ code: 'invalid_workout_session', detail: 'A workout session had an invalid date or plan day and was excluded.' });
      continue;
    }
    if (!dateIsBeforeOrAt(row.date, asOf)) continue;
    if (row.completed_flag === 'true') eligible.push(row);
  }
  return eligible;
}

function eligibleExerciseLogs(rows, sessions) {
  const sessionById = new Map(sessions.map((session) => [session.session_id, session]));
  return rows.filter((row) => {
    const session = sessionById.get(row.session_id);
    return session && row.session_date === session.date && row.day_type === session.day_type;
  });
}

function baselineFromObservations(observations, sourceId, metricName, targetDate, windowDays, currentUnit) {
  const start = addUtcDays(targetDate, -windowDays);
  const byDay = new Map();
  let unit = null;
  let issue = null;
  for (const set of observations) {
    if (set.source.id !== sourceId || set.date >= targetDate || set.date < start) continue;
    const metric = set.physical_metrics.find((item) => item.metric === metricName);
    if (!metric || metric.status !== 'observed') continue;
    const sampleDay = metric.observed_date || (metric.observed_at ? new Date(Date.parse(metric.observed_at)).toISOString().slice(0, 10) : null);
    const value = strictNumber(metric.value);
    if (!sampleDay || sampleDay >= targetDate || sampleDay < start || value === null) continue;
    if (unit !== null && unit !== metric.unit) issue = 'mixed_units';
    unit = unit ?? metric.unit;
    if (byDay.has(sampleDay) && byDay.get(sampleDay).value !== value) issue = 'conflicting_same_day_values';
    byDay.set(sampleDay, { value, unit: metric.unit });
  }
  if (unit !== null && currentUnit && currentUnit !== unit) issue = 'current_metric_unit_mismatch';
  const values = [...byDay.values()].map((item) => item.value);
  return {
    status: issue ? 'unavailable' : values.length === 0 ? 'unavailable' : 'available',
    value: issue || values.length === 0 ? null : Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(2)),
    observed_days: values.length,
    window_days: windowDays,
    min_observed_days: null,
    unit,
    scope: 'source',
    source_id: sourceId,
    issue
  };
}

function baselineFromLegacy(rows, metricName, targetDate, windowDays) {
  const start = addUtcDays(targetDate, -windowDays);
  const valuesByDate = new Map();
  let unit = null;
  let issue = null;
  for (const row of rows) {
    if (row.metric_name !== metricName || !validDate(row.date) || row.date < start || row.date >= targetDate) continue;
    const value = strictNumber(row.metric_value);
    if (value === null) continue;
    if (unit !== null && unit !== row.unit) issue = 'mixed_units';
    unit = unit ?? row.unit;
    if (valuesByDate.has(row.date) && valuesByDate.get(row.date).value !== value) issue = 'conflicting_same_day_values';
    valuesByDate.set(row.date, { value, unit: row.unit });
  }
  const values = [...valuesByDate.values()].map((item) => item.value);
  return {
    status: issue ? 'unavailable' : values.length === 0 ? 'unavailable' : 'available',
    value: issue || values.length === 0 ? null : Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(2)),
    observed_days: values.length,
    window_days: windowDays,
    min_observed_days: null,
    unit,
    scope: 'legacy_unscoped',
    source_id: null,
    issue
  };
}

function evaluateRecovery({
  asOf, policy, rules, sessions, dailyRows, snapshotRows, observationSets, gaps
}) {
  const policyRecovery = policy.recovery;
  const eligibleSets = observationSets.filter((set) => {
    if (!validDate(set.date)) return false;
    if (asOf.kind === 'date' ? set.date > asOf.date : set.date > asOf.date) return false;
    if (asOf.kind === 'timestamp' && set.date === asOf.date && set.freshness?.observed_at && !cutoffContainsInstant(asOf, set.freshness.observed_at)) return false;
    const syncTime = set.freshness?.observed_at;
    if (syncTime && !cutoffContainsInstant(asOf, syncTime)) return false;
    return true;
  });
  const latestSetDate = eligibleSets.reduce((latest, set) => !latest || set.date > latest ? set.date : latest, null);
  const newestSets = latestSetDate ? eligibleSets.filter((set) => set.date === latestSetDate) : [];
  let selection = null;
  let data = null;
  if (newestSets.length > 1) {
    selection = { status: 'ambiguous_source', source_id: null, date: latestSetDate };
    gaps.push({ code: 'recovery_source_ambiguous', detail: 'Multiple wearable providers have the newest observation day; recovery inputs were not combined.' });
  } else if (newestSets.length === 1) {
    const set = newestSets[0];
    selection = { status: 'selected', source_id: set.source.id, date: set.date };
    const physical = {};
    const scores = {};
    const ambiguities = [];
    const requiredDecisionMetrics = new Set(['hrv', 'resting_hr', 'readiness_score', 'sleep_score']);
    for (const metric of set.physical_metrics) {
      const sampleDate = metric.observed_date || (metric.observed_at ? new Date(Date.parse(metric.observed_at)).toISOString().slice(0, 10) : null);
      const futureTimestamp = metric.observed_at && !cutoffContainsInstant(asOf, metric.observed_at);
      const sameDayUntimed = asOf.kind === 'timestamp' && sampleDate === asOf.date && !metric.observed_at;
      const dateAllowed = sampleDate && (asOf.kind === 'date'
        ? sampleDate <= asOf.date
        : sampleDate < asOf.date || (sampleDate === asOf.date && Boolean(metric.observed_at)));
      const sampleAllowed = metric.status === 'observed' && dateAllowed && !futureTimestamp && !sameDayUntimed;
      if (sameDayUntimed) ambiguities.push(metric.metric);
      physical[metric.metric] = {
        status: metric.status,
        value: sampleAllowed ? metric.value : null,
        unit: metric.unit,
        observed_at: metric.observed_at,
        observed_date: metric.observed_date,
        source_ref: metric.source_ref,
        eligible_for_decision: Boolean(sampleAllowed)
      };
    }
    for (const score of set.proprietary_scores) {
      const sampleDate = score.observed_date || (score.observed_at ? new Date(Date.parse(score.observed_at)).toISOString().slice(0, 10) : null);
      const futureTimestamp = score.observed_at && !cutoffContainsInstant(asOf, score.observed_at);
      const sameDayUntimed = asOf.kind === 'timestamp' && sampleDate === asOf.date && !score.observed_at;
      const dateAllowed = sampleDate && (asOf.kind === 'date'
        ? sampleDate <= asOf.date
        : sampleDate < asOf.date || (sampleDate === asOf.date && Boolean(score.observed_at)));
      const sampleAllowed = score.status === 'observed' && dateAllowed && !futureTimestamp && !sameDayUntimed;
      if (sameDayUntimed) ambiguities.push(score.metric);
      scores[score.metric] = {
        status: score.status,
        value: sampleAllowed ? score.value : null,
        unit: score.unit,
        observed_at: score.observed_at,
        observed_date: score.observed_date,
        source_ref: score.source_ref,
        eligible_for_decision: Boolean(sampleAllowed)
      };
    }
    const currentMetric = (metricName) => physical[metricName]?.eligible_for_decision ? physical[metricName] : null;
    const currentScore = (metricName) => scores[metricName]?.eligible_for_decision ? scores[metricName] : null;
    const hrv = currentMetric('hrv');
    const rhr = currentMetric('resting_hr');
    const readiness = currentScore('readiness_score');
    const sleep = currentScore('sleep_score');
    const hrvBaseline = baselineFromObservations(eligibleSets, set.source.id, 'hrv', set.date, policyRecovery.baseline_window_days, hrv?.unit);
    const rhrBaseline = baselineFromObservations(eligibleSets, set.source.id, 'resting_hr', set.date, policyRecovery.baseline_window_days, rhr?.unit);
    const metricAge = (metric) => metric?.observed_at
      ? Math.floor((Date.parse(asOf.kind === 'timestamp' ? asOf.timestamp : `${asOf.date}T23:59:59.999Z`) - Date.parse(metric.observed_at)) / 86_400_000)
      : metric?.observed_date ? dayDistance(metric.observed_date, asOf.date) : null;
    const hrvAge = metricAge(hrv);
    const rhrAge = metricAge(rhr);
    const readinessAge = metricAge(readiness);
    const sleepAge = metricAge(sleep);
    const freshness = set.freshness.status;
    const baselineMinimum = policyRecovery.baseline_min_observed_days;
    hrvBaseline.min_observed_days = baselineMinimum;
    rhrBaseline.min_observed_days = baselineMinimum;
    const baselineSufficient = [hrvBaseline, rhrBaseline].every((item) =>
      item.value !== null && item.observed_days >= baselineMinimum && !item.issue) && hrvBaseline.value > 0 && rhrBaseline.value > 0;
    const currentFresh = [hrvAge, rhrAge, readinessAge, sleepAge].every((age) => age !== null && age >= 0 && age <= policyRecovery.max_age_days);
    const sameDayAmbiguity = asOf.kind === 'timestamp' && ambiguities.some((metric) => requiredDecisionMetrics.has(metric));
    const requiredPresent = Boolean(hrv && rhr && readiness && sleep);
    const decisionReasons = [];
    if (!requiredPresent) decisionReasons.push('required_metrics_missing');
    if (!baselineSufficient) decisionReasons.push('baseline_coverage_insufficient');
    if (!currentFresh) decisionReasons.push('current_metrics_stale_or_unknown');
    if (sameDayAmbiguity) decisionReasons.push('same_day_measurement_time_unknown');
    if (freshness === 'stale') decisionReasons.push('source_freshness_stale');
    if (selection.status !== 'selected') decisionReasons.push('source_ambiguous');
    if (requiredPresent && (hrv.value <= 0 || rhr.value <= 0)) decisionReasons.push('current_metric_out_of_range');
    if (requiredPresent && (readiness.value < 0 || readiness.value > 100 || sleep.value < 0 || sleep.value > 100)) decisionReasons.push('proprietary_score_out_of_range');
    if (rhr && !['bpm', 'beats/min', 'beats_per_minute'].includes(rhr.unit.toLowerCase())) decisionReasons.push('resting_hr_unit_unknown');
    data = {
      source: set.source,
      date: set.date,
      freshness: set.freshness,
      physical_metrics: physical,
      proprietary_scores: scores,
      baselines: { hrv: hrvBaseline, resting_hr: rhrBaseline },
      decisionReasons,
      scoreInputs: requiredPresent && baselineSufficient ? {
        readiness_score: readiness.value,
        sleep_score: sleep.value,
        hrv_delta_pct: ((hrv.value - hrvBaseline.value) / hrvBaseline.value) * 100,
        resting_hr_delta: rhr.value - rhrBaseline.value
      } : null,
      source_type: 'wearable_observation_set'
    };
    if (ambiguities.length) gaps.push({ code: 'recovery_measurement_time_unknown', detail: `Same-day untimed metrics were excluded from timestamp-as-of preparation: ${[...new Set(ambiguities)].join(', ')}.` });
  } else {
    const candidates = dailyRows.filter((row) => validDate(row.date) && rowAllowedByAsOf(row, 'date', 'source_sync_time', asOf))
      .sort((left, right) => right.date.localeCompare(left.date) || (parsedInstant(right.source_sync_time) || 0) - (parsedInstant(left.source_sync_time) || 0));
    const row = candidates[0];
    if (row) {
      selection = { status: 'selected', source_id: null, date: row.date };
      const hrvValue = strictNumber(row.hrv);
      const rhrValue = strictNumber(row.resting_hr);
      const readinessValue = strictNumber(row.readiness_score);
      const sleepValue = strictNumber(row.sleep_score);
      const hrvBaseline = baselineFromLegacy(snapshotRows.filter((item) => rowAllowedByAsOf(item, 'date', 'source_sync_time', asOf)), 'hrv', row.date, policyRecovery.baseline_window_days);
      const rhrBaseline = baselineFromLegacy(snapshotRows.filter((item) => rowAllowedByAsOf(item, 'date', 'source_sync_time', asOf)), 'resting_hr', row.date, policyRecovery.baseline_window_days);
      const baselineMinimum = policyRecovery.baseline_min_observed_days;
      hrvBaseline.min_observed_days = baselineMinimum;
      rhrBaseline.min_observed_days = baselineMinimum;
      const baselineSufficient = [hrvBaseline, rhrBaseline].every((item) => item.value !== null && item.observed_days >= baselineMinimum && !item.issue) && hrvBaseline.value > 0 && rhrBaseline.value > 0;
      const syncDate = validDate(row.source_sync_time) ? row.source_sync_time : null;
      const syncInstant = row.source_sync_time && !syncDate ? parsedInstant(row.source_sync_time) : null;
      const cutoffInstant = asOf.kind === 'timestamp'
        ? Date.parse(asOf.timestamp)
        : Date.parse(`${asOf.date}T23:59:59.999Z`);
      const age = syncInstant !== null
        ? Math.floor((cutoffInstant - syncInstant) / 86_400_000)
        : dayDistance(syncDate || row.date, asOf.date);
      const fresh = age !== null && age >= 0 && age <= policyRecovery.max_age_days;
      const syncKnown = Boolean(row.source_sync_time);
      const sourceAllowed = policyRecovery.allow_legacy_unscoped_baseline;
      const required = [hrvValue, rhrValue, readinessValue, sleepValue].every((value) => value !== null);
      const decisionReasons = [];
      if (!sourceAllowed) decisionReasons.push('legacy_unscoped_baseline_not_allowed');
      if (!required) decisionReasons.push('required_metrics_missing');
      if (!baselineSufficient) decisionReasons.push('baseline_coverage_insufficient');
      if (!fresh) decisionReasons.push('current_metrics_stale_or_unknown');
      if (required && (hrvValue <= 0 || rhrValue <= 0)) decisionReasons.push('current_metric_out_of_range');
      if (required && (readinessValue < 0 || readinessValue > 100 || sleepValue < 0 || sleepValue > 100)) decisionReasons.push('proprietary_score_out_of_range');
      if (!rhrBaseline.unit || !['bpm', 'beats/min', 'beats_per_minute'].includes(rhrBaseline.unit.toLowerCase())) decisionReasons.push('resting_hr_unit_unknown');
      if (asOf.kind === 'timestamp' && row.date === asOf.date && !syncKnown) decisionReasons.push('same_day_sync_time_unknown');
      if (asOf.kind === 'timestamp' && row.date === asOf.date && syncKnown && !cutoffContainsInstant(asOf, row.source_sync_time)) decisionReasons.push('sync_after_as_of');
      data = {
        date: row.date,
        source: null,
        freshness: { status: syncKnown ? 'timestamped' : 'day_precision', source_sync_time: row.source_sync_time || null },
        physical_metrics: {
          hrv: { status: hrvValue === null ? 'missing' : 'observed', value: hrvValue, unit: hrvBaseline.unit || null, observed_date: row.date, source_ref: 'daily_state' },
          resting_hr: { status: rhrValue === null ? 'missing' : 'observed', value: rhrValue, unit: rhrBaseline.unit || null, observed_date: row.date, source_ref: 'daily_state' }
        },
        proprietary_scores: {
          readiness_score: { status: readinessValue === null ? 'missing' : 'observed', value: readinessValue, unit: 'score', observed_date: row.date, source_ref: 'daily_state' },
          sleep_score: { status: sleepValue === null ? 'missing' : 'observed', value: sleepValue, unit: 'score', observed_date: row.date, source_ref: 'daily_state' }
        },
        baselines: { hrv: hrvBaseline, resting_hr: rhrBaseline },
        decisionReasons,
        scoreInputs: required && baselineSufficient ? {
          readiness_score: readinessValue,
          sleep_score: sleepValue,
          hrv_delta_pct: ((hrvValue - hrvBaseline.value) / hrvBaseline.value) * 100,
          resting_hr_delta: rhrValue - rhrBaseline.value
        } : null,
        source_type: 'legacy_daily_state'
      };
      if (asOf.kind === 'timestamp' && row.date === asOf.date && !syncKnown) {
        gaps.push({ code: 'recovery_sync_time_unknown', detail: 'Same-day legacy recovery has no source sync timestamp and was excluded from timestamp-as-of freshness decisions.' });
      }
    }
  }

  if (!data) {
    selection ||= { status: 'missing', source_id: null, date: null };
    gaps.push({ code: 'recovery_missing', detail: 'No eligible recovery observations or normalized recovery rows were available by the as-of cutoff.' });
    return {
      status: 'unavailable', decision: {
        status: 'unavailable', mode: null, score: null, reasons: ['recovery_missing'], breakdown: [],
        explanation: 'Recovery decision unavailable because no eligible recovery observations or normalized recovery rows were found.'
      },
      source: null, date: null, freshness: { status: 'unknown' }, physical_metrics: {}, proprietary_scores: {},
      baselines: { hrv: null, resting_hr: null }, legacy_recommendation_used: false
    };
  }
  const reasons = [...data.decisionReasons];
  if (data.scoreInputs && !Object.values(data.scoreInputs).every(Number.isFinite)) reasons.push('derived_score_input_non_finite');
  let available = reasons.length === 0 && data.scoreInputs !== null;
  let scored = null;
  if (available) {
    const prior = [...sessions].sort((left, right) => right.date.localeCompare(left.date) || right.session_id.localeCompare(left.session_id))[0];
    scored = modeFromMetrics({
      ...data.scoreInputs,
      prev_session_rpe: strictNumber(prior?.session_rpe) ?? 0,
      soreness_pre: strictNumber(prior?.soreness_pre) ?? 0
    }, rules);
    if (!Number.isFinite(scored.score) || !['FULL', 'BASE', 'LIGHT'].includes(scored.mode)) {
      scored = null;
      reasons.push('scoring_rules_invalid');
      available = false;
    }
  } else {
    if (reasons.includes('baseline_coverage_insufficient')) gaps.push({ code: 'recovery_baseline_insufficient', detail: `Recovery needs at least ${policyRecovery.baseline_min_observed_days} distinct, source-consistent days in each ${policyRecovery.baseline_window_days}-day HRV and resting-heart-rate baseline.` });
    if (reasons.includes('legacy_unscoped_baseline_not_allowed')) gaps.push({ code: 'legacy_baseline_scope_unavailable', detail: 'Legacy recovery baselines are unscoped and the preparation policy does not allow them to drive a new decision.' });
    if (reasons.includes('current_metrics_stale_or_unknown')) gaps.push({ code: 'recovery_stale_or_unknown', detail: 'Current recovery metrics are missing, stale, or lack a known measurement day.' });
    if (reasons.includes('required_metrics_missing')) gaps.push({ code: 'recovery_metrics_missing', detail: 'Readiness, sleep, HRV, and resting heart rate are all required for a recovery decision.' });
    if (reasons.includes('resting_hr_unit_unknown')) gaps.push({ code: 'resting_hr_unit_unknown', detail: 'Resting-heart-rate delta requires a known beats-per-minute unit.' });
    if (reasons.includes('proprietary_score_out_of_range')) gaps.push({ code: 'proprietary_score_out_of_range', detail: 'Readiness and sleep scores must be on the supported 0-100 scale.' });
    if (reasons.includes('scoring_rules_invalid')) gaps.push({ code: 'scoring_rules_invalid', detail: 'The configured recovery score could not be computed as a finite supported decision.' });
  }
  return {
    status: available ? 'available' : 'unavailable',
    decision: {
      status: available ? 'available' : 'unavailable',
      mode: scored?.mode || null,
      score: scored?.score ?? null,
      reasons,
      breakdown: scored?.breakdown || [],
      explanation: scored?.explanation || 'Recovery decision unavailable because required current inputs or baseline coverage are insufficient.'
    },
    source: data.source,
    date: data.date,
    freshness: data.freshness,
    physical_metrics: data.physical_metrics,
    proprietary_scores: data.proprietary_scores,
    baselines: data.baselines,
    legacy_recommendation_used: false,
    source_type: data.source_type,
    ...(data.source_sync_time ? { source_sync_time: data.source_sync_time } : {})
  };
}

function eventOccurrenceDay(event) {
  const start = event.occurred?.start;
  if (validDate(start)) return start;
  const instant = parsedInstant(start);
  return instant === null ? null : new Date(instant).toISOString().slice(0, 10);
}

function compareEventRecency(left, right) {
  const leftAt = parsedInstant(left.occurred?.start) ?? (validDate(left.occurred?.start) ? Date.parse(`${left.occurred.start}T00:00:00Z`) : -Infinity);
  const rightAt = parsedInstant(right.occurred?.start) ?? (validDate(right.occurred?.start) ? Date.parse(`${right.occurred.start}T00:00:00Z`) : -Infinity);
  return rightAt - leftAt || left.event_id.localeCompare(right.event_id);
}

function eventAllowedAsOf(event, asOf) {
  const occurred = event.occurred;
  if (!occurred || !occurred.start) return false;
  if (asOf.kind === 'date') {
    const end = occurred.end || occurred.start;
    const cutoff = Date.parse(`${asOf.date}T23:59:59.999Z`);
    if (validDate(end)) return end <= asOf.date;
    const endInstant = parsedInstant(end);
    return endInstant !== null && endInstant <= cutoff;
  }
  if (occurred.precision === 'day') return occurred.start < asOf.date;
  if (occurred.precision === 'interval') {
    const end = occurred.end;
    return Boolean(end && (validDate(end) ? end < asOf.date : parsedInstant(end) !== null &&
      parsedInstant(occurred.start) !== null && parsedInstant(occurred.start) <= Date.parse(asOf.timestamp) &&
      parsedInstant(end) <= Date.parse(asOf.timestamp)));
  }
  return parsedInstant(occurred.start) !== null && parsedInstant(occurred.start) <= Date.parse(asOf.timestamp);
}

function summarizeEvent(event, definition, reason = undefined) {
  const configuredField = definition?.field;
  const rawValue = configuredField ? event.data?.[configuredField] : undefined;
  const value = typeof rawValue === 'string' ? rawValue.slice(0, 100)
    : typeof rawValue === 'number' || typeof rawValue === 'boolean' ? rawValue : null;
  return {
    event_id: event.event_id,
    revision: event.revision,
    provenance_ref: `health-event:${event.event_id}@${event.revision}`,
    event_type: event.event_type,
    occurred: event.occurred,
    source: {
      kind: String(event.source?.kind || 'unknown').slice(0, 64),
      ref: String(event.source?.ref || '').slice(0, 300),
      fragment_id: event.source?.fragment_id === null ? null : String(event.source?.fragment_id || '').slice(0, 128)
    },
    epistemic_status: event.epistemic_status,
    uncertainty_level: event.uncertainty?.level || 'unknown',
    ...(value === null ? {} : { value }),
    ...(reason ? { reason } : {})
  };
}

function evaluateSubjective(paths, profileId, policy, asOf, gaps) {
  const since = addUtcDays(asOf.date, -policy.subjective.max_age_days);
  const configuredTypes = Object.keys(policy.subjective.events);
  const queried = queryEvents(paths, profileId, {
    since,
    through: asOf.kind === 'date' ? asOf.date : undefined,
    types: configuredTypes,
    typePrefixes: ['subjective.'],
    asOfDate: asOf.kind === 'date' ? asOf.date : undefined,
    asOfTimestamp: asOf.kind === 'timestamp' ? asOf.timestamp : undefined,
    limit: 50
  });
  const events = queried.events.filter((event) => eventAllowedAsOf(event, asOf))
    .filter((event) => {
      const day = eventOccurrenceDay(event);
      const age = dayDistance(day, asOf.date);
      return age !== null && age >= 0 && age <= policy.subjective.max_age_days;
    });
  const latestFacts = new Map();
  const signals = [];
  for (const event of events) {
    const definition = policy.subjective.events[event.event_type];
    if (event.epistemic_status !== 'fact') {
      signals.push(summarizeEvent(event, definition, 'pending event; not applied'));
      continue;
    }
    if (event.uncertainty?.level !== 'low') {
      signals.push(summarizeEvent(event, definition, `uncertainty ${event.uncertainty?.level || 'unknown'}; not applied`));
      continue;
    }
    if (!definition) {
      signals.push(summarizeEvent(event, null, 'no preparation policy is configured for this subjective event type'));
      continue;
    }
    const existing = latestFacts.get(event.event_type);
    if (!existing || compareEventRecency(event, existing) < 0) latestFacts.set(event.event_type, event);
  }
  const selected = [];
  const applied = [];
  for (const [eventType, event] of latestFacts) {
    const definition = policy.subjective.events[eventType];
    const value = strictNumber(event.data?.[definition.field]);
    if (value === null || value < definition.minimum || value > definition.maximum) {
      signals.push(summarizeEvent(event, definition, 'configured value is missing or outside the accepted range; not applied'));
      continue;
    }
    const fact = summarizeEvent(event, definition);
    selected.push(fact);
    const adjustment = definition.adjustment;
    const thresholdHit = adjustment && (adjustment.operator === 'lte'
      ? value <= adjustment.threshold
      : value >= adjustment.threshold);
    if (thresholdHit) {
      applied.push({ ...fact, target_sets_delta: adjustment.target_sets_delta, reason: `${eventType} value ${value} ${adjustment.operator === 'lte' ? '≤' : '≥'} ${adjustment.threshold}` });
    }
  }
  signals.sort((left, right) => compareEventRecency(left, right));
  selected.sort((left, right) => compareEventRecency(left, right));
  applied.sort((left, right) => compareEventRecency(left, right));
  if (queried.truncated) gaps.push({ code: 'subjective_query_truncated', detail: 'The subjective event query matched more than 50 rows; only the newest 50 as-of events were considered.' });
  return {
    as_of_window_days: policy.subjective.max_age_days,
    applied: applied.slice(0, 25),
    selected_facts: selected.slice(0, 25),
    conversation_signals: signals.slice(0, 25),
    signals: signals.slice(0, 25),
    truncated: queried.truncated,
    matched_count: queried.matched_count
  };
}

function collectMemoryPages(paths, asOf, gaps, relevanceTerms) {
  const pages = [];
  let visited = 0;
  const walk = (directory) => {
    let entries;
    try { entries = fs.readdirSync(directory, { withFileTypes: true }); }
    catch (error) {
      if (error.code === 'ENOENT') return;
      gaps.push({ code: 'memory_directory_unreadable', detail: 'A memory directory could not be read and was omitted.' });
      return;
    }
    for (const entry of entries) {
      const filePath = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        gaps.push({ code: 'memory_symlink_omitted', detail: 'A symlinked memory item was omitted.' });
        continue;
      }
      if (entry.isDirectory()) { walk(filePath); continue; }
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
      visited += 1;
      if (visited > MAX_MEMORY_FILES) {
        gaps.push({ code: 'memory_file_limit', detail: `Memory evidence is limited to the first ${MAX_MEMORY_FILES} Markdown pages.` });
        return;
      }
      let bytes;
      try { bytes = readRegularFile(filePath, MAX_MEMORY_PAGE_BYTES, 'memory page'); }
      catch {
        gaps.push({ code: 'memory_page_unreadable', detail: 'An oversized or unreadable memory page was omitted.' });
        continue;
      }
      if (!bytes) continue;
      const content = bytes.toString('utf8');
      const { metadata, body } = parseFrontmatter(content);
      if (!metadata || !validDate(metadata.evidence_end) || !validDate(metadata.last_reviewed)) {
        gaps.push({ code: 'memory_metadata_missing', detail: 'A memory page without valid evidence_end and last_reviewed dates was omitted.' });
        continue;
      }
      const definiteByDate = dateIsBeforeOrAt(metadata.evidence_end, asOf) && dateIsBeforeOrAt(metadata.last_reviewed, asOf);
      if (!definiteByDate) {
        if (asOf.kind === 'timestamp' && (metadata.evidence_end === asOf.date || metadata.last_reviewed === asOf.date)) {
          gaps.push({ code: 'memory_same_day_precision', detail: 'A same-day memory page was omitted from an exact-time cutoff because its date-only review metadata is ambiguous.' });
        }
        continue;
      }
      if (metadata.status === 'accepted_rule' && metadata.human_confirmed !== true) {
        gaps.push({ code: 'memory_rule_unconfirmed', detail: 'An accepted_rule memory page without explicit human confirmation was omitted.' });
        continue;
      }
      const searchable = `${metadata.title || ''}\n${body}`.toLocaleLowerCase();
      const searchableTokens = new Set(searchable.match(/[a-z][a-z0-9_]{2,}/g) || []);
      const relevance = relevanceTerms.reduce((score, term) => score + (term && searchableTokens.has(term) ? 1 : 0), 0);
      if (relevance === 0) continue;
      const reviewAge = dayDistance(metadata.last_reviewed, asOf.date);
      const reviewStatus = reviewAge !== null && reviewAge > 90 ? 'stale' : 'current';
      if (reviewStatus === 'stale') gaps.push({ code: 'memory_review_stale', detail: `Memory page ${path.relative(paths.memoryDir, filePath).split(path.sep).join('/')} was last reviewed more than 90 days before the as-of date.` });
      pages.push({
        file: path.relative(paths.memoryDir, filePath).split(path.sep).join('/'),
        title: typeof metadata.title === 'string' ? metadata.title.slice(0, 200) : path.basename(filePath, '.md'),
        status: typeof metadata.status === 'string' ? metadata.status.slice(0, 40) : 'unknown',
        confidence: typeof metadata.confidence === 'string' ? metadata.confidence.slice(0, 20) : 'unknown',
        evidence_start: validDate(metadata.evidence_start) ? metadata.evidence_start : null,
        evidence_end: metadata.evidence_end,
        last_reviewed: metadata.last_reviewed,
        review_status: reviewStatus,
        provenance: Array.isArray(metadata.provenance)
          ? metadata.provenance.filter((item) => typeof item === 'string').slice(0, 10).map((item) => item.slice(0, 200))
          : [],
        excerpt: body.trim().slice(0, MAX_MEMORY_PAGE_CHARS),
        relevance
      });
    }
  };
  walk(paths.memoryEvidenceDir);
  walk(paths.memoryWikiDir);
  return pages.sort((left, right) => right.relevance - left.relevance || right.evidence_end.localeCompare(left.evidence_end) || left.file.localeCompare(right.file))
    .slice(0, MAX_MEMORY_PAGES)
    .map(({ relevance, ...page }) => page);
}

function readMemoryContext(paths, asOf, gaps, relevanceTerms) {
  const hasStore = fs.existsSync(paths.eventsDbFile);
  const hasReview = fs.existsSync(paths.eventReviewFile);
  let review = null;
  try {
    assertMemoryEventProvenanceCurrent(paths);
    if (hasStore || hasReview) review = assertEventMemoryReviewMatchesStore(paths);
  } catch (error) {
    gaps.push({ code: 'derived_memory_blocked', detail: 'Derived memory was omitted because its event-review state or provenance is pending, inconsistent, or stale.', cause: error.code || 'HEALTH_OS_MEMORY_REVIEW_REQUIRED' });
    return { status: 'blocked', evidence: [], review: null, reason: error.code || 'review_required' };
  }
  let hasDirectory = false;
  for (const directory of [paths.memoryEvidenceDir, paths.memoryWikiDir]) {
    try { if (fs.statSync(directory).isDirectory()) hasDirectory = true; }
    catch (error) { if (error.code !== 'ENOENT') gaps.push({ code: 'memory_directory_unreadable', detail: 'A memory directory could not be inspected.' }); }
  }
  const reviewSummary = review ? {
    store_id: review.store_id,
    reviewed_generation: review.reviewed_generation,
    required_generation: review.required_generation,
    pending: review.pending
  } : null;
  if (!hasDirectory) return { status: 'missing', evidence: [], review: reviewSummary };
  const evidence = collectMemoryPages(paths, asOf, gaps, relevanceTerms);
  return { status: evidence.length ? 'available' : 'empty', evidence, review: reviewSummary };
}

function boundProfile(profile, gaps) {
  if (!profile) return { status: 'missing', path: null, updated: null, content: null, snapshot: 'current_profile_snapshot' };
  let content = profile.markdown;
  let truncated = false;
  if (content.length > MAX_PROFILE_CHARS) {
    content = `${content.slice(0, MAX_PROFILE_CHARS)}\n[profile content truncated]`;
    truncated = true;
    gaps.push({ code: 'profile_content_truncated', detail: 'Profile Markdown was truncated to the preparation text limit.' });
  }
  return {
    status: 'available',
    path: profile.manifest.profile_path,
    updated: profile.metadata.updated,
    content,
    snapshot: 'current_profile_snapshot',
    truncated
  };
}

function applySubjectiveAdjustments(workout, subjective) {
  const totalDelta = subjective.applied.reduce((sum, item) => sum + item.target_sets_delta, 0);
  const safeExercises = workout.exercises.map((exercise) => ({
    exercise_key: exercise.exercise_key,
    exercise_name: exercise.exercise_name.slice(0, 200),
    movement_pattern: typeof exercise.movement_pattern === 'string' ? exercise.movement_pattern.slice(0, 100) : null,
    sets: exercise.sets,
    reps_min: exercise.reps_min,
    reps_max: exercise.reps_max,
    progression_type: exercise.progression_type,
    load_tier: exercise.load_tier,
    increment_kg: exercise.increment_kg,
    optional: exercise.optional === true,
    notes: typeof exercise.notes === 'string' ? exercise.notes.slice(0, 500) : '',
    target_reps: exercise.target_reps,
    target_weight: typeof exercise.target_weight === 'string' ? exercise.target_weight.slice(0, 40) : '',
    target_sets: exercise.target_sets,
    strategy: typeof exercise.strategy === 'string' ? exercise.strategy.slice(0, 120) : ''
  }));
  return {
    date: workout.date,
    mode: workout.mode,
    dayType: workout.dayType,
    exercises: safeExercises.map((exercise) => ({
      ...exercise,
      scheduled_target_sets: exercise.target_sets,
      target_sets: Math.max(1, exercise.target_sets + totalDelta),
      ...(totalDelta ? { subjective_adjustment: { total_sets_delta: totalDelta, event_ids: subjective.applied.map((item) => item.event_id) } } : {})
    }))
  };
}

function makeHumanOutput(data) {
  const lines = [
    `as_of=${data.as_of.value}`,
    `session=${data.session_selection.selected_day_type} (${data.session_selection.strategy})`,
    `recovery=${data.recovery.decision.status}${data.recovery.decision.mode ? `:${data.recovery.decision.mode}` : ''}`,
    `recovery_explanation=${data.recovery.decision.explanation.slice(0, 400)}`,
    `recovery_reasons=${data.recovery.decision.reasons.join(', ') || 'none'}`,
    `workout_candidate=${data.workout.dayType} mode=${data.workout.mode} scheduled_only=${data.workout.scheduled_only}`
  ];
  for (const exercise of data.workout.exercises) lines.push(`${exercise.exercise_key}=${exercise.target_sets}x${exercise.target_reps}@${exercise.target_weight || (exercise.load_tier === 'bodyweight' ? 'bodyweight' : 'unset')}`);
  for (const item of data.subjective.applied) lines.push(`subjective_adjustment=${item.reason} (${item.event_id})`);
  if (data.gaps.length) lines.push(`gaps=${data.gaps.length}`);
  for (const gap of data.gaps.slice(0, 5)) lines.push(`gap=${gap.code}: ${String(gap.detail).slice(0, 240)}`);
  return `${lines.join('\n')}\n`;
}

export function prepareTraining(paths, { asOf, explicitSession, substitute } = {}) {
  if (!asOf || !['date', 'timestamp'].includes(asOf.kind) || !validDate(asOf.date)) {
    throw preparationError('prepareTraining requires a validated --as-of date or timestamp');
  }
  const gaps = [];
  let profile;
  try { profile = readSelectedProfile(paths); }
  catch (error) {
    if (error.message.startsWith('Selected profile is missing:')) {
      profile = null;
      gaps.push({ code: 'profile_missing', detail: 'The selected profile is missing; preparation continues without profile Markdown.' });
    } else {
      throw preparationError(`Selected profile is invalid: ${error.message}`, 'HEALTH_OS_WORKSPACE_INVALID');
    }
  }
  const profileId = profile?.manifest.profile_path || JSON.parse(fs.readFileSync(path.join(paths.trackerRoot, 'manifest.json'), 'utf8')).profile_path;
  const policy = loadPreparationPolicy(paths);
  const plan = validateTrainingPlan(readJsonFile(paths.trainingPlanFile, 'training plan'));
  for (const [weekday, dayType] of Object.entries(policy.session_selection.weekday_day_types)) {
    if (!plan.dayKeys.includes(dayType)) throw preparationError(`preparation policy weekday ${weekday} selects unknown plan day ${dayType}`);
  }
  if (policy.session_selection.first_day_type !== 'first_plan_key' && !plan.dayKeys.includes(policy.session_selection.first_day_type)) {
    throw preparationError(`preparation policy first_day_type selects unknown plan day ${policy.session_selection.first_day_type}`);
  }
  const rules = validateRules(readJsonFile(paths.rulesFile, 'training rules'));
  const exerciseSettings = validateExerciseSettings(readJsonFile(paths.exerciseSettingsFile, 'exercise settings'));
  const sessionFile = readCsvFile(paths.workoutSessionsFile, CSV_HEADERS.workoutSessions, 'workout_sessions.csv');
  const logFile = readCsvFile(paths.exerciseLogsFile, CSV_HEADERS.exerciseLogs, 'exercise_logs.csv');
  const dailyFile = readCsvFile(paths.dailyStateFile, CSV_HEADERS.dailyState, 'daily_state.csv');
  const snapshotsFile = readCsvFile(paths.recoverySnapshotsFile, CSV_HEADERS.recoverySnapshots, 'recovery_snapshots.csv');
  for (const [label, missing] of [
    ['workout session history', sessionFile.missing], ['exercise log history', logFile.missing],
    ['normalized recovery rows', dailyFile.missing], ['recovery snapshots', snapshotsFile.missing]
  ]) if (missing) gaps.push({ code: 'source_file_missing', detail: `${label} file is missing.` });

  const eligibleSessions = effectiveWorkoutSessions(sessionFile.rows, asOf, plan, gaps);
  const exerciseLogs = eligibleExerciseLogs(logFile.rows, eligibleSessions);
  const selection = selectDayType({ asOf, plan, policy, sessions: eligibleSessions, explicitSession });
  const selectedEntries = plan.days[selection.selected_day_type];
  const substitutionResult = parseSubstitutions(substitute, policy, selectedEntries, plan);
  selection.substitutions = substitutionResult.substitutions;
  const effectivePlan = { ...plan.days, [selection.selected_day_type]: substitutionResult.entries };
  for (const { from, to } of substitutionResult.substitutions) {
    const setting = exerciseSettings[to];
    const hasHistory = exerciseLogs.some((row) => row.exercise_key === to);
    if (!setting && !hasHistory) gaps.push({ code: 'substitution_target_settings_missing', detail: `Substitution target ${to} has no working-weight setting or eligible exercise history.` });
  }

  const observations = readWearableObservationStore(paths).observations;
  const recovery = evaluateRecovery({
    asOf, policy, rules, sessions: eligibleSessions,
    dailyRows: dailyFile.rows, snapshotRows: snapshotsFile.rows,
    observationSets: observations, gaps
  });
  const subjective = evaluateSubjective(paths, profileId, policy, asOf, gaps);
  const mode = recovery.decision.status === 'available' ? recovery.decision.mode : 'BASE';
  const card = buildWorkoutCard({
    dateString: asOf.date,
    dayType: selection.selected_day_type,
    mode,
    trainingPlan: effectivePlan,
    rules,
    exerciseSettings,
    exerciseLogs
  });
  const adjustedCard = applySubjectiveAdjustments({ ...card, mode: recovery.decision.mode || 'UNAVAILABLE' }, subjective);
  const relevanceTerms = new Set(['preparation', 'training', 'workout', 'recovery', 'sleep', 'readiness']);
  for (const exercise of adjustedCard.exercises) {
    relevanceTerms.add(exercise.exercise_key.toLowerCase());
    for (const term of `${exercise.exercise_name} ${exercise.movement_pattern || ''}`.toLowerCase().match(/[a-z][a-z0-9_]{2,}/g) || []) relevanceTerms.add(term);
  }
  const memory = readMemoryContext(paths, asOf, gaps, [...relevanceTerms]);
  const result = {
    schema_version: 1,
    as_of: {
      kind: asOf.kind,
      value: asOf.value,
      date: asOf.date,
      timestamp: asOf.timestamp || null,
      semantics: asOf.kind === 'date'
        ? 'Inclusive UTC calendar day; source dates through this date may be used.'
        : 'Exact instant cutoff; same-day day-only workout/event/sync data are excluded or marked ambiguous.'
    },
    profile: boundProfile(profile, gaps),
    session_selection: selection,
    workout: {
      ...adjustedCard,
      scheduled_only: recovery.decision.status !== 'available',
      recommendation_status: recovery.decision.status,
      history: eligibleSessions.slice().sort((left, right) => right.date.localeCompare(left.date) || right.session_id.localeCompare(left.session_id))
        .slice(0, 20).map((row) => ({
          session_id: row.session_id, date: row.date, day_type: row.day_type,
          actual_mode: row.actual_mode, session_rpe: strictNumber(row.session_rpe), completed: true
        }))
    },
    recovery,
    subjective,
    memory,
    gaps: gaps.slice(0, 50),
    provenance: {
      profile: profile?.manifest.profile_path || null,
      training_plan: '.health-os/config/training-plan.json',
      preparation_policy: '.health-os/config/preparation-policy.json',
      rules: '.health-os/config/rules.json',
      exercise_settings: '.health-os/config/exercise-settings.json',
      workout_sessions: '.health-os/data/workout_sessions.csv',
      exercise_logs: '.health-os/data/exercise_logs.csv',
      recovery: recovery.source_type === 'wearable_observation_set'
        ? '.health-os/data/wearable-observations.json'
        : '.health-os/data/daily_state.csv',
      recovery_source: recovery.source?.id || 'legacy_unscoped',
      events: '.health-os/data/events.sqlite',
      memory: memory.status === 'available' ? memory.evidence.map((item) => item.file) : [],
      snapshot_semantics: 'Current profile, plan, policy, rules, and exercise settings; historical versions are not reconstructed.'
    }
  };
  // Keep the domain response below the CLI envelope's generic clipping bounds.
  const serialized = JSON.stringify(result);
  if (Buffer.byteLength(serialized) > 64 * 1024) {
    result.profile.content = result.profile.content?.slice(0, 1_500) || null;
    result.memory.evidence = result.memory.evidence.slice(0, 3).map((item) => ({ ...item, excerpt: item.excerpt.slice(0, 400) }));
    result.gaps.push({ code: 'preparation_output_bounded', detail: 'Narrative context was shortened to preserve the decision and missingness fields within the preparation output limit.' });
  }
  if (Buffer.byteLength(JSON.stringify(result)) > 64 * 1024) {
    // The deterministic fields above are bounded; fail rather than letting the
    // generic JSON envelope clip them silently.
    throw preparationError('Preparation output exceeds its 65536-byte domain limit');
  }
  return { data: result, humanOutput: makeHumanOutput(result) };
}
