import fs from 'node:fs';

import { readCsv, writeCsv } from './csv.js';
import { readJson } from './config.js';
import { estimateE1rm } from './log-parser.js';

export const CSV_HEADERS = {
  workoutSessions: [
    'session_id',
    'date',
    'day_type',
    'recommended_mode',
    'actual_mode',
    'duration_minutes',
    'session_rpe',
    'energy_pre',
    'soreness_pre',
    'completed_flag',
    'notes'
  ],
  exerciseLogs: [
    'session_id',
    'session_date',
    'day_type',
    'exercise_key',
    'exercise_name',
    'set_count',
    'reps',
    'weight',
    'top_set_weight',
    'top_set_reps',
    'estimated_1rm',
    'completed_as_planned',
    'actual_mode',
    'session_rpe',
    'notes'
  ],
  recoverySnapshots: ['date', 'metric_name', 'metric_value', 'unit', 'source_sync_time'],
  dailyState: [
    'date',
    'readiness_score',
    'sleep_score',
    'hrv',
    'hrv_baseline_28d',
    'hrv_delta_pct',
    'resting_hr',
    'resting_hr_baseline_28d',
    'resting_hr_delta',
    'sleep_efficiency',
    'total_sleep_minutes',
    'temperature_deviation',
    'recommended_mode',
    'recommendation_reason',
    'source_sync_time'
  ],
  decisionLog: ['date', 'recommended_mode', 'score', 'inputs_json', 'breakdown_json', 'explanation_text'],
  rulesHistory: ['date', 'version', 'rules_json', 'calibration_score', 'adherence_rate', 'reasoning']
};

export function localDateString(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function initialiseWorkspace(paths, repoRoot) {
  const defaults = [
    ['training-plan.json', paths.trainingPlanFile],
    ['rules.json', paths.rulesFile]
  ];

  for (const [fileName, targetPath] of defaults) {
    const sourcePath = `${repoRoot}/config/${fileName}`;
    if (!fs.existsSync(targetPath)) {
      fs.copyFileSync(sourcePath, targetPath);
    }
  }

  const filesToSeed = [
    [paths.workoutSessionsFile, CSV_HEADERS.workoutSessions],
    [paths.exerciseLogsFile, CSV_HEADERS.exerciseLogs],
    [paths.recoverySnapshotsFile, CSV_HEADERS.recoverySnapshots],
    [paths.dailyStateFile, CSV_HEADERS.dailyState],
    [paths.decisionLogFile, CSV_HEADERS.decisionLog],
    [paths.rulesHistoryFile, CSV_HEADERS.rulesHistory]
  ];

  for (const [filePath, headers] of filesToSeed) {
    if (!fs.existsSync(filePath)) {
      writeCsv(filePath, headers, []);
    }
  }
}

export function loadTrainingPlan(paths) {
  const config = readJson(paths.trainingPlanFile);
  return config.days;
}

export function loadRules(paths) {
  return readJson(paths.rulesFile);
}

function parseNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function roundToNearest(value, increment) {
  if (!Number.isFinite(value) || !increment) {
    return value;
  }
  return Math.round(value / increment) * increment;
}

export function modeFromMetrics(metrics, rules) {
  const scoreParts = [];
  let score = 0;
  const thresholds = rules.thresholds;
  const weights = rules.weights;

  if (metrics.readiness_score >= thresholds.readiness_high) {
    score += weights.readiness_high;
    scoreParts.push(`readiness +${weights.readiness_high}`);
  } else if (metrics.readiness_score >= thresholds.readiness_mid) {
    score += weights.readiness_mid;
    scoreParts.push(`readiness +${weights.readiness_mid}`);
  } else {
    score += weights.readiness_low;
    scoreParts.push(`readiness ${weights.readiness_low}`);
  }

  if (metrics.sleep_score >= thresholds.sleep_high) {
    score += weights.sleep_high;
    scoreParts.push(`sleep +${weights.sleep_high}`);
  } else if (metrics.sleep_score >= thresholds.sleep_mid) {
    score += weights.sleep_mid;
    scoreParts.push(`sleep +${weights.sleep_mid}`);
  } else {
    score += weights.sleep_low;
    scoreParts.push(`sleep ${weights.sleep_low}`);
  }

  if (metrics.hrv_delta_pct >= thresholds.hrv_delta_ok) {
    score += weights.hrv_ok;
    scoreParts.push(`hrv +${weights.hrv_ok}`);
  } else {
    score += weights.hrv_bad;
    scoreParts.push(`hrv ${weights.hrv_bad}`);
  }

  if (metrics.resting_hr_delta <= thresholds.resting_hr_delta_ok) {
    score += weights.rhr_ok;
    scoreParts.push(`resting_hr +${weights.rhr_ok}`);
  } else {
    score += weights.rhr_bad;
    scoreParts.push(`resting_hr ${weights.rhr_bad}`);
  }

  if (metrics.prev_session_rpe >= thresholds.rpe_heavy) {
    score += weights.rpe_penalty;
    scoreParts.push(`prev_rpe ${weights.rpe_penalty}`);
  }

  if (metrics.soreness_pre >= thresholds.soreness_heavy) {
    score += weights.soreness_penalty;
    scoreParts.push(`soreness ${weights.soreness_penalty}`);
  }

  let mode = 'LIGHT';
  if (score >= rules.cutoffs.full_min_score) {
    mode = 'FULL';
  } else if (score >= rules.cutoffs.base_min_score) {
    mode = 'BASE';
  }

  return {
    mode,
    score,
    breakdown: scoreParts,
    explanation: `Mode ${mode} from score ${score}: ${scoreParts.join(', ')}.`
  };
}

export function determineNextDayType(workoutSessions) {
  const completed = workoutSessions
    .filter((session) => session.completed_flag === 'true')
    .sort((left, right) => right.date.localeCompare(left.date) || right.session_id.localeCompare(left.session_id));
  if (completed.length === 0) {
    return 'A';
  }
  return completed[0].day_type === 'A' ? 'B' : 'A';
}

function allowedSetsForMode(planEntry, mode, rules) {
  if (mode !== 'LIGHT') {
    return planEntry.sets;
  }
  return Math.max(1, planEntry.sets - rules.light_mode.set_reduction);
}

function findExerciseHistory(exerciseLogs, exerciseKey) {
  return exerciseLogs
    .filter((row) => row.exercise_key === exerciseKey)
    .sort((left, right) => right.session_date.localeCompare(left.session_date));
}

function computeBaseTarget(planEntry, exerciseLogs) {
  const history = findExerciseHistory(exerciseLogs, planEntry.exercise_key);
  const last = history[0];
  const previous = history[1];
  if (!last) {
    return '';
  }

  const lastWeight = parseNumber(last.top_set_weight || last.weight, NaN);
  if (!Number.isFinite(lastWeight)) {
    return '';
  }

  const twoFailures =
    last.completed_as_planned === 'false' &&
    previous &&
    previous.completed_as_planned === 'false';
  if (twoFailures) {
    return String(roundToNearest(lastWeight * 0.925, 2.5));
  }

  if (
    planEntry.progression_type === 'upper_lower_load' &&
    last.completed_as_planned === 'true' &&
    parseNumber(last.session_rpe, 10) <= 8 &&
    last.actual_mode !== 'LIGHT'
  ) {
    return String(roundToNearest(lastWeight + planEntry.increment_kg, 2.5));
  }

  return String(lastWeight);
}

export function buildNextWorkout(paths, dateString = localDateString()) {
  const trainingPlan = loadTrainingPlan(paths);
  const rules = loadRules(paths);
  const workoutSessions = readCsv(paths.workoutSessionsFile);
  const exerciseLogs = readCsv(paths.exerciseLogsFile);
  const dailyState = readCsv(paths.dailyStateFile);
  const currentState = dailyState.find((row) => row.date === dateString);

  const mode = currentState?.recommended_mode || 'BASE';
  const dayType = determineNextDayType(workoutSessions);
  const exercises = trainingPlan[dayType].map((entry) => {
    const baseTarget = computeBaseTarget(entry, exerciseLogs);
    const numericTarget = parseNumber(baseTarget, NaN);
    let adjustedTarget = baseTarget;
    if (mode === 'LIGHT' && Number.isFinite(numericTarget)) {
      adjustedTarget = String(roundToNearest(numericTarget * rules.light_mode.load_multiplier, 2.5));
    }

    return {
      ...entry,
      target_sets: allowedSetsForMode(entry, mode, rules),
      target_reps: `${entry.reps_min}${entry.reps_min === entry.reps_max ? '' : `-${entry.reps_max}`}`,
      target_weight: adjustedTarget,
      strategy:
        entry.progression_type === 'reps_first'
          ? 'Progress by reps first.'
          : entry.progression_type === 'quality_first'
            ? 'Keep quality high before adding load.'
            : 'Progress load when execution stays clean.'
    };
  });

  return {
    date: dateString,
    mode,
    dayType,
    exercises
  };
}

function completedAsPlanned(planEntry, sets, actualMode) {
  const minSets = actualMode === 'LIGHT' ? Math.max(1, planEntry.sets - 1) : planEntry.sets;
  if (sets.length < minSets) {
    return false;
  }
  return sets.every((set) => set.reps >= planEntry.reps_min && set.reps <= planEntry.reps_max);
}

export function appendWorkoutLog(paths, parsedLog, dateString = localDateString()) {
  const trainingPlan = loadTrainingPlan(paths);
  const sessions = readCsv(paths.workoutSessionsFile);
  const exerciseLogs = readCsv(paths.exerciseLogsFile);
  const dailyState = readCsv(paths.dailyStateFile);
  const recommendedMode = dailyState.find((row) => row.date === dateString)?.recommended_mode || 'BASE';
  const sessionId = `session-${dateString}-${sessions.length + 1}`;

  sessions.push({
    session_id: sessionId,
    date: dateString,
    day_type: parsedLog.session.day,
    recommended_mode: recommendedMode,
    actual_mode: parsedLog.session.actual_mode,
    duration_minutes: String(parsedLog.session.duration_minutes),
    session_rpe: String(parsedLog.session.session_rpe),
    energy_pre: String(parsedLog.session.energy_pre),
    soreness_pre: String(parsedLog.session.soreness_pre),
    completed_flag: 'true',
    notes: parsedLog.session.notes
  });

  for (const exercise of parsedLog.exercises) {
    const planEntry = trainingPlan[parsedLog.session.day].find((entry) => entry.exercise_key === exercise.exercise_key);
    if (!planEntry) {
      throw new Error(`Exercise not found in plan for day ${parsedLog.session.day}: ${exercise.exercise_key}`);
    }

    const weightedSets = exercise.sets.filter((set) => set.weight !== 'bw');
    const topSet = weightedSets.sort((left, right) => Number(right.weight) - Number(left.weight) || right.reps - left.reps)[0];
    const firstWeight = weightedSets[0]?.weight ?? exercise.sets[0]?.weight ?? '';
    const repsText = exercise.sets.map((set) => `${set.weight}x${set.reps}`).join('|');
    const completed = completedAsPlanned(planEntry, exercise.sets, parsedLog.session.actual_mode);

    exerciseLogs.push({
      session_id: sessionId,
      session_date: dateString,
      day_type: parsedLog.session.day,
      exercise_key: exercise.exercise_key,
      exercise_name: planEntry.exercise_name,
      set_count: String(exercise.sets.length),
      reps: repsText,
      weight: String(firstWeight),
      top_set_weight: topSet ? String(topSet.weight) : '',
      top_set_reps: topSet ? String(topSet.reps) : '',
      estimated_1rm: topSet ? estimateE1rm(Number(topSet.weight), Number(topSet.reps)) : '',
      completed_as_planned: completed ? 'true' : 'false',
      actual_mode: parsedLog.session.actual_mode,
      session_rpe: String(parsedLog.session.session_rpe),
      notes: parsedLog.session.notes
    });
  }

  writeCsv(paths.workoutSessionsFile, CSV_HEADERS.workoutSessions, sessions);
  writeCsv(paths.exerciseLogsFile, CSV_HEADERS.exerciseLogs, exerciseLogs);
  return sessionId;
}

export function ingestDailyState(paths, payload) {
  const rules = loadRules(paths);
  const workoutSessions = readCsv(paths.workoutSessionsFile);
  const dailyStateRows = readCsv(paths.dailyStateFile).filter((row) => row.date !== payload.date);
  const decisionRows = readCsv(paths.decisionLogFile).filter((row) => row.date !== payload.date);
  const snapshotRows = readCsv(paths.recoverySnapshotsFile).filter((row) => row.date !== payload.date);

  const previousSession = workoutSessions
    .filter((session) => session.completed_flag === 'true')
    .sort((left, right) => right.date.localeCompare(left.date))[0];

  const restingHrDelta =
    parseNumber(payload.resting_hr, 0) - parseNumber(payload.resting_hr_baseline_28d, 0);
  const hrvBaseline = parseNumber(payload.hrv_baseline_28d, 0);
  const hrvDeltaPct =
    hrvBaseline === 0 ? 0 : ((parseNumber(payload.hrv, 0) - hrvBaseline) / hrvBaseline) * 100;

  const decision = modeFromMetrics(
    {
      readiness_score: parseNumber(payload.readiness_score, 0),
      sleep_score: parseNumber(payload.sleep_score, 0),
      hrv_delta_pct: hrvDeltaPct,
      resting_hr_delta: restingHrDelta,
      prev_session_rpe: parseNumber(previousSession?.session_rpe, 0),
      soreness_pre: parseNumber(previousSession?.soreness_pre, 0)
    },
    rules
  );

  dailyStateRows.push({
    date: payload.date,
    readiness_score: String(payload.readiness_score ?? ''),
    sleep_score: String(payload.sleep_score ?? ''),
    hrv: String(payload.hrv ?? ''),
    hrv_baseline_28d: String(payload.hrv_baseline_28d ?? ''),
    hrv_delta_pct: hrvDeltaPct.toFixed(2),
    resting_hr: String(payload.resting_hr ?? ''),
    resting_hr_baseline_28d: String(payload.resting_hr_baseline_28d ?? ''),
    resting_hr_delta: restingHrDelta.toFixed(2),
    sleep_efficiency: String(payload.sleep_efficiency ?? ''),
    total_sleep_minutes: String(payload.total_sleep_minutes ?? ''),
    temperature_deviation: String(payload.temperature_deviation ?? ''),
    recommended_mode: decision.mode,
    recommendation_reason: decision.explanation,
    source_sync_time: String(payload.source_sync_time ?? '')
  });

  decisionRows.push({
    date: payload.date,
    recommended_mode: decision.mode,
    score: String(decision.score),
    inputs_json: JSON.stringify(payload),
    breakdown_json: JSON.stringify(decision.breakdown),
    explanation_text: decision.explanation
  });

  for (const [metricName, metricValue] of Object.entries(payload.raw_metrics || {})) {
    snapshotRows.push({
      date: payload.date,
      metric_name: metricName,
      metric_value: String(metricValue),
      unit: '',
      source_sync_time: String(payload.source_sync_time ?? '')
    });
  }

  writeCsv(paths.dailyStateFile, CSV_HEADERS.dailyState, dailyStateRows.sort((left, right) => left.date.localeCompare(right.date)));
  writeCsv(paths.decisionLogFile, CSV_HEADERS.decisionLog, decisionRows.sort((left, right) => left.date.localeCompare(right.date)));
  writeCsv(paths.recoverySnapshotsFile, CSV_HEADERS.recoverySnapshots, snapshotRows.sort((left, right) => left.date.localeCompare(right.date) || left.metric_name.localeCompare(right.metric_name)));

  return decision;
}

export function renderToday(paths, dateString = localDateString()) {
  const nextWorkout = buildNextWorkout(paths, dateString);
  const dailyStateRows = readCsv(paths.dailyStateFile);
  const currentState = dailyStateRows.find((row) => row.date === dateString);

  const lines = [];
  lines.push('*Today*');
  lines.push(`• date: ${dateString}`);
  if (currentState) {
    lines.push(`• mode: ${currentState.recommended_mode}`);
    lines.push(`• readiness: ${currentState.readiness_score}`);
    lines.push(`• sleep: ${currentState.sleep_score}`);
    lines.push(`• hrv delta: ${currentState.hrv_delta_pct}%`);
    lines.push(`• resting HR delta: ${currentState.resting_hr_delta}`);
    lines.push(`• why: ${currentState.recommendation_reason}`);
  } else {
    lines.push('• mode: BASE');
    lines.push('• why: no daily recovery state logged for today');
  }
  lines.push(`• next workout: Day ${nextWorkout.dayType}`);
  lines.push('');
  lines.push('*Workout Card*');
  for (const exercise of nextWorkout.exercises) {
    const weightText = exercise.target_weight
      ? `${exercise.target_weight} kg`
      : exercise.load_tier === 'bodyweight'
        ? 'bodyweight'
        : 'set manually';
    lines.push(`• ${exercise.exercise_name}: ${exercise.target_sets}x${exercise.target_reps} @ ${weightText}`);
  }

  const output = `${lines.join('\n')}\n`;
  fs.writeFileSync(paths.todayArtifactFile, output, 'utf8');
  return output;
}

export function renderWhy(paths) {
  const rows = readCsv(paths.decisionLogFile).sort((left, right) => right.date.localeCompare(left.date));
  if (rows.length === 0) {
    return 'No decision log entries yet.\n';
  }
  const latest = rows[0];
  return [
    '*Why*',
    `• date: ${latest.date}`,
    `• recommended mode: ${latest.recommended_mode}`,
    `• score: ${latest.score}`,
    `• explanation: ${latest.explanation_text}`,
    `• breakdown: ${JSON.parse(latest.breakdown_json).join(', ')}`
  ].join('\n') + '\n';
}

export function renderWeeklySummary(paths, endDate = localDateString()) {
  const workoutSessions = readCsv(paths.workoutSessionsFile);
  const dailyStateRows = readCsv(paths.dailyStateFile);
  const exerciseLogs = readCsv(paths.exerciseLogsFile);
  const end = new Date(`${endDate}T12:00:00`);
  const start = new Date(end);
  start.setDate(end.getDate() - 6);
  const startDate = localDateString(start);

  const weekSessions = workoutSessions.filter((session) => session.date >= startDate && session.date <= endDate);
  const weekStates = dailyStateRows.filter((row) => row.date >= startDate && row.date <= endDate);
  const latestByExercise = new Map();
  for (const row of exerciseLogs.sort((left, right) => right.session_date.localeCompare(left.session_date))) {
    if (!latestByExercise.has(row.exercise_key)) {
      latestByExercise.set(row.exercise_key, row);
    }
  }

  const avg = (items, key) => {
    if (items.length === 0) {
      return '';
    }
    const total = items.reduce((sum, item) => sum + parseNumber(item[key], 0), 0);
    return (total / items.length).toFixed(1);
  };

  let lightStreak = 0;
  const sortedStates = [...weekStates].sort((left, right) => left.date.localeCompare(right.date));
  for (let i = sortedStates.length - 1; i >= 0; i -= 1) {
    if (sortedStates[i].recommended_mode === 'LIGHT') {
      lightStreak += 1;
    } else {
      break;
    }
  }

  const lines = [];
  lines.push('*Weekly Summary*');
  lines.push(`• window: ${startDate} to ${endDate}`);
  lines.push(`• strength sessions: ${weekSessions.length}`);
  lines.push(`• avg readiness: ${avg(weekStates, 'readiness_score') || 'n/a'}`);
  lines.push(`• avg sleep: ${avg(weekStates, 'sleep_score') || 'n/a'}`);
  lines.push(`• avg hrv delta: ${avg(weekStates, 'hrv_delta_pct') || 'n/a'}%`);
  if (lightStreak >= 3) {
    lines.push('• warning: 3 or more consecutive LIGHT days, consider a deload');
  }
  lines.push('');
  lines.push('*Progress Snapshot*');
  for (const exerciseKey of ['squat', 'bench_press', 'deadlift', 'standing_press']) {
    const row = latestByExercise.get(exerciseKey);
    if (!row) {
      continue;
    }
    lines.push(`• ${row.exercise_name}: e1RM ${row.estimated_1rm || 'n/a'}, last top set ${row.top_set_weight || 'n/a'}x${row.top_set_reps || 'n/a'}`);
  }

  const output = `${lines.join('\n')}\n`;
  fs.writeFileSync(paths.weeklyArtifactFile, output, 'utf8');
  return output;
}
