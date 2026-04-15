import fs from 'node:fs';

function readJsonIfExists(filePath) {
  if (!filePath) {
    return null;
  }
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function asArray(value) {
  if (!value) {
    return [];
  }
  if (Array.isArray(value)) {
    return value;
  }
  if (Array.isArray(value.data)) {
    return value.data;
  }
  if (Array.isArray(value.records)) {
    return value.records;
  }
  return [value];
}

function getDateValue(record) {
  return record.day || record.date || record.timestamp?.slice(0, 10) || record.created_at?.slice(0, 10) || '';
}

function findForDate(records, date) {
  return records.find((record) => getDateValue(record) === date) || null;
}

function numberOrEmpty(value) {
  if (value === undefined || value === null || value === '') {
    return '';
  }
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : '';
}

function coalesceNumber(...values) {
  for (const value of values) {
    const numeric = numberOrEmpty(value);
    if (numeric !== '') {
      return numeric;
    }
  }
  return '';
}

function secondsToMinutes(value) {
  const numeric = numberOrEmpty(value);
  if (numeric === '') {
    return '';
  }
  return Math.round(numeric / 60);
}

function detectTotalSleepMinutes(sleepRecord) {
  return coalesceNumber(
    sleepRecord.total_sleep_minutes,
    sleepRecord.total_sleep_duration && secondsToMinutes(sleepRecord.total_sleep_duration),
    sleepRecord.total_sleep && secondsToMinutes(sleepRecord.total_sleep),
    sleepRecord.duration && secondsToMinutes(sleepRecord.duration)
  );
}

function detectSleepEfficiency(sleepRecord) {
  return coalesceNumber(
    sleepRecord.sleep_efficiency,
    sleepRecord.efficiency,
    sleepRecord.efficiency_score
  );
}

function detectTemperatureDeviation(readinessRecord, sleepRecord) {
  return coalesceNumber(
    readinessRecord.temperature_deviation,
    readinessRecord.temperature_trend_deviation,
    sleepRecord.temperature_deviation,
    sleepRecord.temperature_trend_deviation
  );
}

function detectReadinessScore(readinessRecord) {
  return coalesceNumber(
    readinessRecord.readiness_score,
    readinessRecord.score,
    readinessRecord.readiness
  );
}

function detectSleepScore(sleepRecord) {
  return coalesceNumber(
    sleepRecord.sleep_score,
    sleepRecord.score,
    sleepRecord.sleep
  );
}

function detectHrv(readinessRecord, sleepRecord) {
  return coalesceNumber(
    readinessRecord.hrv,
    readinessRecord.average_hrv,
    sleepRecord.average_hrv,
    sleepRecord.hrv
  );
}

function detectRestingHr(readinessRecord, sleepRecord, heartrateRecords) {
  const sleepValue = coalesceNumber(
    sleepRecord.resting_hr,
    sleepRecord.lowest_heart_rate,
    sleepRecord.lowest_hr
  );
  if (sleepValue !== '') {
    return sleepValue;
  }

  const readinessValue = coalesceNumber(
    readinessRecord.resting_hr,
    readinessRecord.resting_heart_rate
  );
  if (readinessValue !== '') {
    return readinessValue;
  }

  const heartRates = heartrateRecords
    .map((entry) => coalesceNumber(entry.bpm, entry.heart_rate, entry.hr))
    .filter((entry) => entry !== '');
  if (heartRates.length === 0) {
    return '';
  }
  return Math.min(...heartRates);
}

function latestTimestamp(...records) {
  const values = records
    .flat()
    .filter(Boolean)
    .map((record) => record.timestamp || record.updated_at || record.day || record.date)
    .filter(Boolean)
    .sort();
  return values.at(-1) || new Date().toISOString();
}

export function normalizeOuraPayload({
  date,
  readinessJson,
  sleepJson,
  heartrateJson,
  baselines = {}
}) {
  const readinessRecords = asArray(readinessJson);
  const sleepRecords = asArray(sleepJson);
  const heartrateRecords = asArray(heartrateJson).filter((record) => getDateValue(record) === date || !getDateValue(record));

  const readinessRecord = findForDate(readinessRecords, date);
  const sleepRecord = findForDate(sleepRecords, date);

  if (!readinessRecord) {
    throw new Error(`No readiness record found for ${date}`);
  }
  if (!sleepRecord) {
    throw new Error(`No sleep record found for ${date}`);
  }

  const readinessScore = detectReadinessScore(readinessRecord);
  const sleepScore = detectSleepScore(sleepRecord);
  const hrv = detectHrv(readinessRecord, sleepRecord);
  const restingHr = detectRestingHr(readinessRecord, sleepRecord, heartrateRecords);

  if (readinessScore === '') {
    throw new Error(`Unable to detect readiness_score for ${date}`);
  }
  if (sleepScore === '') {
    throw new Error(`Unable to detect sleep_score for ${date}`);
  }
  if (hrv === '') {
    throw new Error(`Unable to detect hrv for ${date}`);
  }
  if (restingHr === '') {
    throw new Error(`Unable to detect resting_hr for ${date}`);
  }

  const normalized = {
    date,
    readiness_score: readinessScore,
    sleep_score: sleepScore,
    hrv,
    hrv_baseline_28d: coalesceNumber(baselines.hrv_baseline_28d, hrv),
    resting_hr: restingHr,
    resting_hr_baseline_28d: coalesceNumber(baselines.resting_hr_baseline_28d, restingHr),
    sleep_efficiency: detectSleepEfficiency(sleepRecord),
    total_sleep_minutes: detectTotalSleepMinutes(sleepRecord),
    temperature_deviation: detectTemperatureDeviation(readinessRecord, sleepRecord),
    source_sync_time: latestTimestamp(readinessRecord, sleepRecord, heartrateRecords),
    raw_metrics: {
      readiness_score: readinessScore,
      sleep_score: sleepScore,
      hrv,
      resting_hr: restingHr
    }
  };

  if (normalized.sleep_efficiency !== '') {
    normalized.raw_metrics.sleep_efficiency = normalized.sleep_efficiency;
  }
  if (normalized.total_sleep_minutes !== '') {
    normalized.raw_metrics.total_sleep_minutes = normalized.total_sleep_minutes;
  }
  if (normalized.temperature_deviation !== '') {
    normalized.raw_metrics.temperature_deviation = normalized.temperature_deviation;
  }

  return normalized;
}

export function normalizeOuraPayloadFromFiles({
  date,
  readinessFile,
  sleepFile,
  heartrateFile,
  baselinesFile,
  baselines
}) {
  return normalizeOuraPayload({
    date,
    readinessJson: readJsonIfExists(readinessFile),
    sleepJson: readJsonIfExists(sleepFile),
    heartrateJson: readJsonIfExists(heartrateFile),
    baselines: baselinesFile ? readJsonIfExists(baselinesFile) : (baselines || {})
  });
}
