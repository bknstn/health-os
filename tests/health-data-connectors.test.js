import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  getHealthDataConnector,
  listHealthDataConnectors,
  syncDailyStateFromConnector
} from '../src/health-data-connectors.js';
import { initialiseWorkspace } from '../src/engine.js';
import { buildPaths, ensureWorkspace, repoRoot } from '../src/layout.js';

function okJson(payload) {
  return {
    ok: true,
    status: 200,
    async text() {
      return JSON.stringify(payload);
    }
  };
}

function makeWorkspace() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'health-os-connectors-'));
  const paths = buildPaths(tempDir);
  ensureWorkspace(paths);
  initialiseWorkspace(paths, repoRoot());
  return paths;
}

test('health data connector registry exposes Oura without coupling callers to it', () => {
  const connectors = listHealthDataConnectors();

  assert.deepEqual(connectors.map((connector) => connector.id), ['oura']);
  assert.deepEqual(getHealthDataConnector('oura').requiredMetrics, [
    'readiness_score',
    'sleep_score',
    'hrv',
    'resting_hr'
  ]);
  assert.throws(() => getHealthDataConnector('unknown'), /Unknown health data connector/);
});

test('syncDailyStateFromConnector fetches, normalizes, and ingests a provider day', async () => {
  const paths = makeWorkspace();
  const calls = [];
  const result = await syncDailyStateFromConnector({
    connectorId: 'oura',
    paths,
    date: '2026-04-13',
    options: {
      'access-token': 'access-1',
      fetchImpl: async (url) => {
        const text = String(url);
        calls.push(text);
        if (text.includes('/daily_readiness')) {
          return okJson({ data: [{ day: '2026-04-13', score: 84 }] });
        }
        if (text.includes('/daily_sleep')) {
          return okJson({
            data: [
              {
                day: '2026-04-13',
                score: 79,
                average_hrv: 49,
                lowest_heart_rate: 54,
                total_sleep_duration: 25800
              }
            ]
          });
        }
        return okJson({ data: [{ timestamp: '2026-04-13T03:00:00+00:00', bpm: 54 }] });
      }
    },
    env: {}
  });

  assert.equal(result.connector, 'oura');
  assert.equal(result.date, '2026-04-13');
  assert.equal(result.mode, 'FULL');
  assert.equal(calls.length, 4);
  assert.match(fs.readFileSync(paths.dailyStateFile, 'utf8'), /2026-04-13,84,79,49/);
});
