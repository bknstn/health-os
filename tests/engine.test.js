import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { buildPaths, ensureWorkspace, repoRoot } from '../src/layout.js';
import {
  appendWorkoutLog,
  buildNextWorkout,
  ingestDailyState,
  initialiseWorkspace,
  modeFromMetrics,
  setWorkingWeight
} from '../src/engine.js';

function makeWorkspace() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'health-os-'));
  const paths = buildPaths(tempDir);
  ensureWorkspace(paths);
  initialiseWorkspace(paths, repoRoot());
  return paths;
}

test('modeFromMetrics returns LIGHT when recovery is poor', () => {
  const rules = JSON.parse(fs.readFileSync(path.join(repoRoot(), 'config', 'rules.json'), 'utf8'));
  const result = modeFromMetrics(
    {
      readiness_score: 60,
      sleep_score: 65,
      hrv_delta_pct: -18,
      resting_hr_delta: 6,
      prev_session_rpe: 9,
      soreness_pre: 4
    },
    rules
  );
  assert.equal(result.mode, 'LIGHT');
  assert.ok(result.score <= 0);
});

test('next workout alternates after a logged session', () => {
  const paths = makeWorkspace();
  appendWorkoutLog(
    paths,
    {
      session: {
        day: 'A',
        actual_mode: 'BASE',
        duration_minutes: 55,
        session_rpe: 7,
        energy_pre: 4,
        soreness_pre: 2,
        notes: ''
      },
      exercises: [
        { exercise_key: 'squat', sets: [{ weight: 80, reps: 5 }, { weight: 80, reps: 5 }, { weight: 80, reps: 5 }, { weight: 80, reps: 5 }] }
      ]
    },
    '2026-04-13'
  );

  const nextWorkout = buildNextWorkout(paths, '2026-04-14');
  assert.equal(nextWorkout.dayType, 'B');
});

test('ingestDailyState stores a FULL recommendation for strong recovery', () => {
  const paths = makeWorkspace();
  const decision = ingestDailyState(paths, {
    date: '2026-04-13',
    readiness_score: 90,
    sleep_score: 84,
    hrv: 55,
    hrv_baseline_28d: 50,
    resting_hr: 50,
    resting_hr_baseline_28d: 52,
    sleep_efficiency: 90,
    total_sleep_minutes: 450,
    temperature_deviation: 0,
    source_sync_time: '2026-04-13T06:45:00+02:00',
    raw_metrics: {
      readiness_score: 90,
      sleep_score: 84
    }
  });
  assert.equal(decision.mode, 'FULL');
});

test('next workout uses configured starting weights when there is no history', () => {
  const paths = makeWorkspace();
  setWorkingWeight(paths, 'squat', 80);
  setWorkingWeight(paths, 'bench_press', 60);

  const nextWorkout = buildNextWorkout(paths, '2026-04-13');
  const squat = nextWorkout.exercises.find((exercise) => exercise.exercise_key === 'squat');
  const bench = nextWorkout.exercises.find((exercise) => exercise.exercise_key === 'bench_press');

  assert.equal(squat.target_weight, '80');
  assert.equal(bench.target_weight, '60');
});

test('workspace initialization creates personal raw and processed file areas', () => {
  const paths = makeWorkspace();

  assert.ok(paths.personalRawDir.endsWith(path.join('.health-os', 'personal', 'raw')));
  assert.ok(paths.personalFilesDir.endsWith(path.join('.health-os', 'personal', 'files')));
  assert.equal(fs.existsSync(paths.personalRawDir), true);
  assert.equal(fs.existsSync(paths.personalFilesDir), true);
});
