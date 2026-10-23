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
  if (value === undefined || value === null || (typeof value === 'string' && value.trim() === '')) {
    return '';
  }
  if (typeof value !== 'number' && typeof value !== 'string') return '';
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

function incompleteRecovery(message) {
  return Object.assign(new Error(message), { code: 'HEALTH_OS_RECOVERY_INCOMPLETE' });
}

function recordHasNumber(record, names) {
  return Boolean(record && coalesceNumber(...names.map((name) => record[name])) !== '');
}

function observationMetric({ metric, value, unit, record, date, sourceRef, baseline = null }) {
  const number = numberOrEmpty(value);
  const timestamp = record?.timestamp || record?.observed_at || null;
  const hasExactTimestamp = typeof timestamp === 'string' && timestamp.includes('T');
  const sampleDate = record ? getDateValue(record) : '';
  return {
    metric,
    status: number === '' ? 'missing' : 'observed',
    value: number === '' ? null : number,
    unit,
    observed_at: number !== '' && hasExactTimestamp ? timestamp : null,
    observed_date: number !== '' && !hasExactTimestamp && sampleDate ? sampleDate : null,
    source_ref: sourceRef,
    baseline
  };
}

function scoreObservation({ metric, value, record, date, sourceRef }) {
  const number = numberOrEmpty(value);
  const timestamp = record?.timestamp || record?.observed_at || null;
  const hasExactTimestamp = typeof timestamp === 'string' && timestamp.includes('T');
  const sampleDate = record ? getDateValue(record) : '';
  return {
    metric,
    status: number === '' ? 'missing' : 'observed',
    value: number === '' ? null : number,
    unit: 'score',
    observed_at: number !== '' && hasExactTimestamp ? timestamp : null,
    observed_date: number !== '' && !hasExactTimestamp && sampleDate ? sampleDate : null,
    source_ref: sourceRef
  };
}

function baselineForObservation(baselineCoverage, metric, sourceId) {
  return baselineCoverage?.[metric] || {
    status: 'unavailable',
    value: null,
    observed_days: 0,
    window_days: 28,
    scope: 'source',
    source_id: sourceId
  };
}

export function normalizeOuraObservationSet({ date, readinessJson, sleepJson, heartrateJson, baselineCoverage = {} }) {
  const readinessRecords = asArray(readinessJson);
  const sleepRecords = asArray(sleepJson);
  const heartrateRecords = asArray(heartrateJson).filter((record) => getDateValue(record) === date || !getDateValue(record));
  const readinessRecord = findForDate(readinessRecords, date);
  const sleepRecord = findForDate(sleepRecords, date);

  const hrvRecord = recordHasNumber(readinessRecord, ['hrv', 'average_hrv']) ? readinessRecord
    : recordHasNumber(sleepRecord, ['average_hrv', 'hrv']) ? sleepRecord
      : null;
  const restingSleepValue = sleepRecord ? coalesceNumber(sleepRecord.resting_hr, sleepRecord.lowest_heart_rate, sleepRecord.lowest_hr) : '';
  const restingReadinessValue = readinessRecord ? coalesceNumber(readinessRecord.resting_hr, readinessRecord.resting_heart_rate) : '';
  let restingRecord = restingSleepValue !== '' ? sleepRecord : restingReadinessValue !== '' ? readinessRecord : null;
  let restingValue = detectRestingHr(readinessRecord || {}, sleepRecord || {}, heartrateRecords);
  if (!restingRecord && restingValue !== '') {
    const heartRateRecords = heartrateRecords
      .map((record) => ({ record, value: coalesceNumber(record.bpm, record.heart_rate, record.hr) }))
      .filter((item) => item.value !== '')
      .sort((left, right) => left.value - right.value);
    restingRecord = heartRateRecords[0]?.record || null;
  }

  const hrvValue = detectHrv(readinessRecord || {}, sleepRecord || {});
  const readinessScore = readinessRecord ? detectReadinessScore(readinessRecord) : '';
  const sleepScore = sleepRecord ? detectSleepScore(sleepRecord) : '';
  const temperatureRecord = recordHasNumber(readinessRecord, ['temperature_deviation', 'temperature_trend_deviation'])
    ? readinessRecord
    : sleepRecord;

  return {
    schema_version: 1,
    date,
    source: { id: 'oura', label: 'Oura Ring', reference: date },
    freshness: { status: 'unknown', observed_at: null, evaluated_at: null, max_age_seconds: null },
    physical_metrics: [
      observationMetric({
        metric: 'hrv', value: hrvValue, unit: 'ms', record: hrvRecord, date, sourceRef: hrvRecord === readinessRecord ? 'daily_readiness' : 'daily_sleep',
        baseline: baselineForObservation(baselineCoverage, 'hrv', 'oura')
      }),
      observationMetric({
        metric: 'resting_hr', value: restingValue, unit: 'beats/min', record: restingRecord, date,
        sourceRef: restingRecord === readinessRecord ? 'daily_readiness' : restingRecord === sleepRecord ? 'daily_sleep' : 'heartrate',
        baseline: baselineForObservation(baselineCoverage, 'resting_hr', 'oura')
      }),
      observationMetric({ metric: 'sleep_efficiency', value: sleepRecord ? detectSleepEfficiency(sleepRecord) : '', unit: '%', record: sleepRecord, date, sourceRef: 'daily_sleep' }),
      observationMetric({ metric: 'total_sleep_minutes', value: sleepRecord ? detectTotalSleepMinutes(sleepRecord) : '', unit: 'min', record: sleepRecord, date, sourceRef: 'daily_sleep' }),
      observationMetric({ metric: 'temperature_deviation', value: detectTemperatureDeviation(readinessRecord || {}, sleepRecord || {}), unit: '°C', record: temperatureRecord, date, sourceRef: temperatureRecord === readinessRecord ? 'daily_readiness' : 'daily_sleep' })
    ],
    proprietary_scores: [
      scoreObservation({ metric: 'readiness_score', value: readinessScore, record: readinessRecord, date, sourceRef: 'daily_readiness' }),
      scoreObservation({ metric: 'sleep_score', value: sleepScore, record: sleepRecord, date, sourceRef: 'daily_sleep' })
    ]
  };
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
    throw incompleteRecovery(`No readiness record found for ${date}`);
  }
  if (!sleepRecord) {
    throw incompleteRecovery(`No sleep record found for ${date}`);
  }

  const readinessScore = detectReadinessScore(readinessRecord);
  const sleepScore = detectSleepScore(sleepRecord);
  const hrv = detectHrv(readinessRecord, sleepRecord);
  const restingHr = detectRestingHr(readinessRecord, sleepRecord, heartrateRecords);

  if (readinessScore === '') {
    throw incompleteRecovery(`Unable to detect readiness_score for ${date}`);
  }
  if (sleepScore === '') {
    throw incompleteRecovery(`Unable to detect sleep_score for ${date}`);
  }
  if (hrv === '') {
    throw incompleteRecovery(`Unable to detect hrv for ${date}`);
  }
  if (restingHr === '') {
    throw incompleteRecovery(`Unable to detect resting_hr for ${date}`);
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
