import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { writeCsv } from '../src/csv.js';
import { computeWorkspaceBaselines } from '../src/baselines.js';
import { buildPaths, ensureWorkspace, repoRoot } from '../src/layout.js';
import { initialiseWorkspace, CSV_HEADERS } from '../src/engine.js';

function makeWorkspace(t) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'health-os-baselines-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const paths = buildPaths(tempDir);
  ensureWorkspace(paths);
  initialiseWorkspace(paths, repoRoot());
  return paths;
}

test('computeWorkspaceBaselines averages recent hrv and resting_hr snapshots', (t) => {
  const paths = makeWorkspace(t);
  writeCsv(paths.recoverySnapshotsFile, CSV_HEADERS.recoverySnapshots, [
    { date: '2026-04-10', metric_name: 'hrv', metric_value: '50', unit: '', source_sync_time: '' },
    { date: '2026-04-11', metric_name: 'hrv', metric_value: '54', unit: '', source_sync_time: '' },
    { date: '2026-04-10', metric_name: 'resting_hr', metric_value: '52', unit: '', source_sync_time: '' },
    { date: '2026-04-11', metric_name: 'resting_hr', metric_value: '54', unit: '', source_sync_time: '' }
  ]);

  const baselines = computeWorkspaceBaselines(paths, '2026-04-12');
  assert.equal(baselines.hrv_baseline_28d, 52);
  assert.equal(baselines.resting_hr_baseline_28d, 53);
});

test('legacy CSV baselines ignore blanks, invalid dates, and future rows using UTC day windows', (t) => {
  const paths = makeWorkspace(t);
  writeCsv(paths.recoverySnapshotsFile, CSV_HEADERS.recoverySnapshots, [
    { date: '2026-03-28', metric_name: 'hrv', metric_value: '40', unit: '', source_sync_time: '' },
    { date: '2026-03-29', metric_name: 'hrv', metric_value: '', unit: '', source_sync_time: '' },
    { date: '2026-03-30', metric_name: 'hrv', metric_value: '60', unit: '', source_sync_time: '' },
    { date: '2026-03-30', metric_name: 'hrv', metric_value: '70', unit: '', source_sync_time: '' },
    { date: 'not-a-date', metric_name: 'hrv', metric_value: '1000', unit: '', source_sync_time: '' },
    { date: '2026-04-02', metric_name: 'hrv', metric_value: '1000', unit: '', source_sync_time: '' }
  ]);
  const baselines = computeWorkspaceBaselines(paths, '2026-03-31', 3);
  assert.equal(baselines.hrv_baseline_28d, 55);
});
