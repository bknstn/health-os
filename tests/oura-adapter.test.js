import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { normalizeOuraPayload } from '../src/oura-adapter.js';
import { appendWorkoutLog, initialiseWorkspace } from '../src/engine.js';
import { buildPaths, ensureWorkspace, repoRoot } from '../src/layout.js';
import { writeCsv } from '../src/csv.js';
import { CSV_HEADERS } from '../src/engine.js';
import { computeWorkspaceBaselines } from '../src/baselines.js';

function makeWorkspace() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'health-os-oura-adapter-'));
  const paths = buildPaths(tempDir);
  ensureWorkspace(paths);
  initialiseWorkspace(paths, repoRoot());
  return paths;
}

test('normalizeOuraPayload maps raw Oura-like records into the tracker contract', () => {
  const payload = normalizeOuraPayload({
    date: '2026-04-13',
    readinessJson: {
      data: [
        {
          day: '2026-04-13',
          score: 84,
          temperature_deviation: 0.1,
          timestamp: '2026-04-13T06:45:00+02:00'
        }
      ]
    },
    sleepJson: {
      data: [
        {
          day: '2026-04-13',
          score: 79,
          average_hrv: 49,
          lowest_heart_rate: 54,
          efficiency: 88,
          total_sleep_duration: 25800,
          timestamp: '2026-04-13T06:45:00+02:00'
        }
      ]
    },
    heartrateJson: {
      data: [
        {
          timestamp: '2026-04-13T03:00:00+02:00',
          bpm: 58
        },
        {
          timestamp: '2026-04-13T04:00:00+02:00',
          bpm: 54
        }
      ]
    },
    baselines: {
      hrv_baseline_28d: 52,
      resting_hr_baseline_28d: 52
    }
  });

  assert.equal(payload.readiness_score, 84);
  assert.equal(payload.sleep_score, 79);
  assert.equal(payload.hrv, 49);
  assert.equal(payload.resting_hr, 54);
  assert.equal(payload.total_sleep_minutes, 430);
  assert.equal(payload.hrv_baseline_28d, 52);
});

test('normalizeOuraPayload fails if a required record is missing', () => {
  assert.throws(() => {
    normalizeOuraPayload({
      date: '2026-04-13',
      readinessJson: { data: [] },
      sleepJson: { data: [] },
      heartrateJson: { data: [] }
    });
  }, /No readiness record found/);
});

test('workspace baselines can be supplied from prior recovery snapshot history', () => {
  const paths = makeWorkspace();
  writeCsv(paths.recoverySnapshotsFile, CSV_HEADERS.recoverySnapshots, [
    { date: '2026-04-10', metric_name: 'hrv', metric_value: '50', unit: '', source_sync_time: '' },
    { date: '2026-04-11', metric_name: 'hrv', metric_value: '54', unit: '', source_sync_time: '' },
    { date: '2026-04-10', metric_name: 'resting_hr', metric_value: '52', unit: '', source_sync_time: '' },
    { date: '2026-04-11', metric_name: 'resting_hr', metric_value: '54', unit: '', source_sync_time: '' }
  ]);

  const baselines = computeWorkspaceBaselines(paths, '2026-04-12');
  const payload = normalizeOuraPayload({
    date: '2026-04-12',
    readinessJson: { data: [{ day: '2026-04-12', score: 82 }] },
    sleepJson: {
      data: [
        {
          day: '2026-04-12',
          score: 78,
          average_hrv: 51,
          lowest_heart_rate: 53,
          total_sleep_duration: 25200
        }
      ]
    },
    heartrateJson: { data: [] },
    baselines
  });

  assert.equal(payload.hrv_baseline_28d, 52);
  assert.equal(payload.resting_hr_baseline_28d, 53);
});
