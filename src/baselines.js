import { readCsv } from './csv.js';

function toDate(dateString) {
  return new Date(`${dateString}T12:00:00`);
}

function average(values) {
  if (values.length === 0) {
    return '';
  }
  return Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(2));
}

function metricValues(rows, metricName, targetDate, windowDays) {
  const target = toDate(targetDate);
  return rows
    .filter((row) => row.metric_name === metricName)
    .filter((row) => row.date < targetDate)
    .filter((row) => {
      const diffMs = target.getTime() - toDate(row.date).getTime();
      const diffDays = diffMs / (1000 * 60 * 60 * 24);
      return diffDays >= 1 && diffDays <= windowDays;
    })
    .map((row) => Number(row.metric_value))
    .filter((value) => Number.isFinite(value));
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
