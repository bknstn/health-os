const SCALAR_KEYS = new Set([
  'day',
  'actual_mode',
  'duration_minutes',
  'session_rpe',
  'energy_pre',
  'soreness_pre',
  'notes'
]);

function normalizeExerciseValue(value) {
  return value.replaceAll(/\s+/g, '').toLowerCase();
}

function parseSet(token) {
  const cleaned = normalizeExerciseValue(token);
  const match = cleaned.match(/^(bw|[0-9]+(?:\.[0-9]+)?)x([0-9]+)$/);
  if (!match) {
    throw new Error(`Invalid set token: ${token}`);
  }

  return {
    weight: match[1] === 'bw' ? 'bw' : Number(match[1]),
    reps: Number(match[2])
  };
}

export function parseWorkoutLog(inputText) {
  const lines = inputText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines[0] !== '/log') {
    throw new Error('Workout log must start with /log');
  }

  const session = {};
  const exercises = [];

  for (const line of lines.slice(1)) {
    const separatorIndex = line.indexOf('=');
    if (separatorIndex === -1) {
      throw new Error(`Invalid line: ${line}`);
    }

    const key = line.slice(0, separatorIndex).trim();
    const value = line.slice(separatorIndex + 1).trim();
    if (!key || !value) {
      throw new Error(`Invalid key/value pair: ${line}`);
    }

    if (SCALAR_KEYS.has(key)) {
      session[key] = value;
      continue;
    }

    const sets = value.split(',').map((token) => parseSet(token.trim()));
    exercises.push({ exercise_key: key, sets });
  }

  const requiredKeys = [
    'day',
    'actual_mode',
    'duration_minutes',
    'session_rpe',
    'energy_pre',
    'soreness_pre'
  ];

  for (const requiredKey of requiredKeys) {
    if (!session[requiredKey]) {
      throw new Error(`Missing required field: ${requiredKey}`);
    }
  }

  if (!['A', 'B'].includes(session.day)) {
    throw new Error('day must be A or B');
  }

  if (!['FULL', 'BASE', 'LIGHT'].includes(session.actual_mode)) {
    throw new Error('actual_mode must be FULL, BASE, or LIGHT');
  }

  if (exercises.length === 0) {
    throw new Error('Workout log must include at least one exercise');
  }

  return {
    session: {
      day: session.day,
      actual_mode: session.actual_mode,
      duration_minutes: Number(session.duration_minutes),
      session_rpe: Number(session.session_rpe),
      energy_pre: Number(session.energy_pre),
      soreness_pre: Number(session.soreness_pre),
      notes: session.notes || ''
    },
    exercises
  };
}

export function estimateE1rm(weight, reps) {
  if (!Number.isFinite(weight) || !Number.isFinite(reps)) {
    return '';
  }
  return (weight * (1 + reps / 30)).toFixed(2);
}
