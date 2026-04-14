import test from 'node:test';
import assert from 'node:assert/strict';

import { parseWorkoutLog } from '../src/log-parser.js';

test('parseWorkoutLog parses a valid structured log', () => {
  const parsed = parseWorkoutLog(`
/log
day=A
actual_mode=BASE
duration_minutes=58
session_rpe=7
energy_pre=4
soreness_pre=2
squat=80x5,80x5,80x5,80x5
bench_press=60x5,60x5,60x5,60x5
notes=Solid session
  `);

  assert.equal(parsed.session.day, 'A');
  assert.equal(parsed.exercises.length, 2);
  assert.equal(parsed.exercises[0].sets[0].weight, 80);
});

test('parseWorkoutLog rejects malformed logs', () => {
  assert.throws(() => {
    parseWorkoutLog(`
day=A
actual_mode=BASE
    `);
  }, /must start with \/log/);
});
