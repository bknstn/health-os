import { readCsv } from './csv.js';

function strictUtcDate(dateString) {
  if (typeof dateString !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(dateString)) return null;
  const timestamp = Date.parse(`${dateString}T00:00:00.000Z`);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== dateString) return null;
  return timestamp;
}

function average(values) {
  if (values.length === 0) {
    return '';
  }
  return Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(2));
}

function metricValues(rows, metricName, targetDate, windowDays) {
  const target = strictUtcDate(targetDate);
  if (target === null) return [];
  const valuesByDate = new Map();
  for (const row of rows) {
    if (row.metric_name !== metricName) continue;
    const rowDate = strictUtcDate(row.date);
    if (rowDate === null || rowDate >= target) continue;
    const diffDays = (target - rowDate) / 86_400_000;
    if (diffDays < 1 || diffDays > windowDays) continue;
    if (typeof row.metric_value !== 'string' || row.metric_value.trim() === '') continue;
    const value = Number(row.metric_value);
    if (Number.isFinite(value)) valuesByDate.set(row.date, value);
  }
  return [...valuesByDate.values()];
}

export function computeWorkspaceBaselines(paths, targetDate, windowDays = 28) {
  const snapshotRows = readCsv(paths.recoverySnapshotsFile);
  const hrvValues = metricValues(snapshotRows, 'hrv', targetDate, windowDays);
  const restingHrValues = metricValues(snapshotRows, 'resting_hr', targetDate, windowDays);

  return {
    hrv_baseline_28d: average(hrvValues),
    resting_hr_baseline_28d: average(restingHrValues)
  };
}
