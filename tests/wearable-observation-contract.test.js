import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { buildPaths } from '../src/layout.js';
import { validateWearableObservationSet } from '../src/wearable-observation-contract.js';
import {
  computeSourceBaselineCoverage,
  listWearableObservationSets,
  writeWearableObservationSet
} from '../src/wearable-observation-store.js';

function observation({ date = '2026-10-23', observedDate = date, value = 48, unit = 'ms', score = false } = {}) {
  return {
    schema_version: 1,
    date,
    source: { id: 'synthetic-ring', label: 'Synthetic Ring', reference: `day:${date}` },
    freshness: { status: 'unknown', observed_at: null, evaluated_at: null, max_age_seconds: null },
    physical_metrics: [{
      metric: 'hrv', status: value === null ? 'missing' : 'observed', value, unit,
      observed_at: null, observed_date: value === null ? null : observedDate,
      source_ref: 'daily-sleep',
      baseline: {
        status: 'unavailable', value: null, observed_days: 0, window_days: 28,
        scope: 'source', source_id: 'synthetic-ring'
      }
    }],
    proprietary_scores: score ? [{
      metric: 'sleep_score', status: 'observed', value: 80, unit: 'score',
      observed_at: null, observed_date: date, source_ref: 'daily-sleep'
    }] : []
  };
}

function scratch(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'health-os-wearable-observations-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('HealthObservationSet v1 keeps physical metrics separate from optional proprietary scores', () => {
  const valid = validateWearableObservationSet(observation({ score: true }));
  assert.equal(valid.physical_metrics[0].metric, 'hrv');
  assert.equal(valid.proprietary_scores[0].metric, 'sleep_score');
  assert.equal(validateWearableObservationSet(observation()).proprietary_scores.length, 0);
});

test('HealthObservationSet v1 rejects invalid dates, timestamps, freshness, and baseline coverage', () => {
  const badDate = observation();
  badDate.physical_metrics[0].observed_at = '2026-02-30T06:00:00Z';
  badDate.physical_metrics[0].observed_date = null;
  assert.throws(() => validateWearableObservationSet(badDate), /real YYYY-MM-DD date/);

  const tooPrecise = observation();
  tooPrecise.physical_metrics[0].observed_at = '2026-10-23T06:00:00.1234Z';
  tooPrecise.physical_metrics[0].observed_date = null;
  assert.throws(() => validateWearableObservationSet(tooPrecise), /invalid format/);

  const falseFreshness = observation();
  falseFreshness.freshness = {
    status: 'fresh', observed_at: '2026-10-23T06:00:00Z',
    evaluated_at: '2026-10-23T07:00:00Z', max_age_seconds: 30
  };
  assert.throws(() => validateWearableObservationSet(falseFreshness), /does not match/);

  const fakeCompleteBaseline = observation();
  fakeCompleteBaseline.physical_metrics[0].baseline = {
    status: 'complete', value: 48, observed_days: 0, window_days: 0,
    scope: 'source', source_id: 'synthetic-ring'
  };
  assert.throws(() => validateWearableObservationSet(fakeCompleteBaseline), /window_days must be from 1 to 365/);
});

test('same source/date replacement removes stale metrics instead of merging old values', (t) => {
  const paths = buildPaths(scratch(t));
  writeWearableObservationSet(paths, observation());
  writeWearableObservationSet(paths, observation({ value: null }));
  const listed = listWearableObservationSets(paths, { source: 'synthetic-ring', date: '2026-10-23' });
  assert.equal(listed.matched_count, 1);
  assert.equal(listed.observations[0].physical_metrics[0].status, 'missing');
  assert.equal(listed.observations[0].physical_metrics[0].value, null);
});

test('same-source baseline counts distinct actual observation days in a UTC window', (t) => {
  const paths = buildPaths(scratch(t));
  writeWearableObservationSet(paths, observation({ date: '2026-10-01', observedDate: '2026-10-01', value: 40 }));
  writeWearableObservationSet(paths, observation({ date: '2026-10-02', observedDate: '2026-10-01', value: 40 }));
  writeWearableObservationSet(paths, observation({ date: '2026-10-03', observedDate: '2026-10-01', value: 40 }));
  const repeatedOldReading = computeSourceBaselineCoverage(paths, 'synthetic-ring', '2026-10-04', 'hrv', 3);
  assert.deepEqual(repeatedOldReading, {
    status: 'partial', value: 40, observed_days: 1, window_days: 3,
    scope: 'source', source_id: 'synthetic-ring'
  });
});

test('same-source baselines refuse mixed units and never include unknown sample dates', (t) => {
  const paths = buildPaths(scratch(t));
  writeWearableObservationSet(paths, observation({ date: '2026-10-01', observedDate: '2026-10-01', value: 48, unit: 'ms' }));
  writeWearableObservationSet(paths, observation({ date: '2026-10-02', observedDate: '2026-10-02', value: 0.048, unit: 's' }));
  assert.throws(() => computeSourceBaselineCoverage(paths, 'synthetic-ring', '2026-10-03', 'hrv', 2), /mixed units/);

  const unknownPaths = buildPaths(scratch(t));
  const unknown = observation({ date: '2026-10-01', observedDate: '2026-10-01' });
  unknown.physical_metrics[0].observed_date = null;
  writeWearableObservationSet(unknownPaths, unknown);
  const coverage = computeSourceBaselineCoverage(unknownPaths, 'synthetic-ring', '2026-10-03', 'hrv', 2);
  assert.equal(coverage.status, 'unavailable');
  assert.equal(coverage.observed_days, 0);
});
