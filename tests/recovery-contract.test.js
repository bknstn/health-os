import test from 'node:test';
import assert from 'node:assert/strict';

import { validateRecoveryPayload } from '../src/recovery-contract.js';

test('validateRecoveryPayload accepts a valid normalized payload', () => {
  const payload = validateRecoveryPayload({
    date: '2026-04-13',
    readiness_score: 84,
    sleep_score: '79',
    hrv: 49,
    hrv_baseline_28d: 52,
    resting_hr: 54,
    resting_hr_baseline_28d: 52,
    sleep_efficiency: 88,
    total_sleep_minutes: 430,
    temperature_deviation: 0.1,
    source_sync_time: '2026-04-13T06:45:00+02:00',
    raw_metrics: {
      readiness_score: 84,
      sleep_score: 79,
      hrv: 49,
      resting_hr: 54
    }
  });

  assert.equal(payload.sleep_score, 79);
  assert.equal(payload.raw_metrics.hrv, 49);
});

test('validateRecoveryPayload rejects a payload with missing raw metrics', () => {
  assert.throws(() => {
    validateRecoveryPayload({
      date: '2026-04-13',
      readiness_score: 84,
      sleep_score: 79,
      hrv: 49,
      hrv_baseline_28d: 52,
      resting_hr: 54,
      resting_hr_baseline_28d: 52,
      source_sync_time: '2026-04-13T06:45:00+02:00',
      raw_metrics: {
        readiness_score: 84
      }
    });
  }, /raw_metrics\.sleep_score/);
});
