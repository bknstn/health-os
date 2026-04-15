import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { writeCsv } from '../src/csv.js';
import { computeWorkspaceBaselines } from '../src/baselines.js';
import { buildPaths, ensureWorkspace, repoRoot } from '../src/layout.js';
import { initialiseWorkspace, CSV_HEADERS } from '../src/engine.js';

function makeWorkspace() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'health-os-baselines-'));
  const paths = buildPaths(tempDir);
  ensureWorkspace(paths);
  initialiseWorkspace(paths, repoRoot());
  return paths;
}

test('computeWorkspaceBaselines averages recent hrv and resting_hr snapshots', () => {
  const paths = makeWorkspace();
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
