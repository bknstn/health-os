function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireString(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`Field "${field}" must be a non-empty string`);
  }
  return value.trim();
}

function requireIsoDate(value, field) {
  const text = requireString(value, field);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    throw new Error(`Field "${field}" must use YYYY-MM-DD format`);
  }
  return text;
}

function requireNumber(value, field) {
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Field "${field}" must be a finite number`);
  }
  return value;
}

function optionalNumber(value, field) {
  if (value === undefined || value === null || value === '') {
    return '';
  }
  return requireNumber(value, field);
}

function requireObject(value, field) {
  if (!isPlainObject(value)) {
    throw new Error(`Field "${field}" must be an object`);
  }
  return value;
}

export function validateRecoveryPayload(input) {
  const payload = requireObject(input, 'payload');
  const rawMetrics = requireObject(payload.raw_metrics, 'raw_metrics');

  const normalized = {
    date: requireIsoDate(payload.date, 'date'),
    readiness_score: requireNumber(payload.readiness_score, 'readiness_score'),
    sleep_score: requireNumber(payload.sleep_score, 'sleep_score'),
    hrv: requireNumber(payload.hrv, 'hrv'),
    hrv_baseline_28d: requireNumber(payload.hrv_baseline_28d, 'hrv_baseline_28d'),
    resting_hr: requireNumber(payload.resting_hr, 'resting_hr'),
    resting_hr_baseline_28d: requireNumber(
      payload.resting_hr_baseline_28d,
      'resting_hr_baseline_28d'
    ),
    sleep_efficiency: optionalNumber(payload.sleep_efficiency, 'sleep_efficiency'),
    total_sleep_minutes: optionalNumber(payload.total_sleep_minutes, 'total_sleep_minutes'),
    temperature_deviation: optionalNumber(payload.temperature_deviation, 'temperature_deviation'),
    source_sync_time: requireString(payload.source_sync_time, 'source_sync_time'),
    raw_metrics: {}
  };

  for (const metric of ['readiness_score', 'sleep_score', 'hrv', 'resting_hr']) {
    normalized.raw_metrics[metric] = requireNumber(rawMetrics[metric], `raw_metrics.${metric}`);
  }

  if (rawMetrics.sleep_efficiency !== undefined) {
    normalized.raw_metrics.sleep_efficiency = requireNumber(
      rawMetrics.sleep_efficiency,
      'raw_metrics.sleep_efficiency'
    );
  }

  if (rawMetrics.total_sleep_minutes !== undefined) {
    normalized.raw_metrics.total_sleep_minutes = requireNumber(
      rawMetrics.total_sleep_minutes,
      'raw_metrics.total_sleep_minutes'
    );
  }

  if (rawMetrics.temperature_deviation !== undefined) {
    normalized.raw_metrics.temperature_deviation = requireNumber(
      rawMetrics.temperature_deviation,
      'raw_metrics.temperature_deviation'
    );
  }

  return normalized;
}
