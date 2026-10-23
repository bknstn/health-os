import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  getHealthDataConnector,
  listHealthDataConnectors,
  registerHealthDataConnector,
  syncDailyStateFromConnector
} from '../src/health-data-connectors.js';
import { initialiseWorkspace } from '../src/engine.js';
import { buildPaths, ensureWorkspace, repoRoot } from '../src/layout.js';
import { writeOuraTokenFile } from '../src/oura-api.js';
import { ouraConnector } from '../src/oura-connector.js';

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

test('syncDailyStateFromConnector fetches Oura, preserves legacy recovery, and stores neutral observations', async (t) => {
  const paths = makeWorkspace();
  t.after(() => fs.rmSync(paths.groupRoot, { recursive: true, force: true }));
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
  assert.equal(result.decision_available, true);
  assert.equal(calls.length, 4);
  assert.match(fs.readFileSync(paths.dailyStateFile, 'utf8'), /2026-04-13,84,79,49/);
  assert.deepEqual(result.observation_set.proprietary_scores.map((score) => score.metric), ['readiness_score', 'sleep_score']);
  assert.equal(result.observation_set.physical_metrics.find((metric) => metric.metric === 'hrv').value, 49);
  assert.equal(result.observation_set.physical_metrics.find((metric) => metric.metric === 'hrv').baseline.status, 'unavailable');
  assert.equal(result.observation_set.freshness.status, 'unknown');
});

test('a scoreless connector stores physical observations without creating a recovery decision', async (t) => {
  const paths = makeWorkspace();
  t.after(() => fs.rmSync(paths.groupRoot, { recursive: true, force: true }));
  registerHealthDataConnector({
    id: 'scoreless-physical',
    label: 'Scoreless Physical Sensor',
    capabilities: ['wearable-observations'],
    requiredMetrics: [],
    observationSchemaVersions: [1],
    physicalMetrics: ['hrv', 'steps'],
    proprietaryScores: [],
    async resolveAuth() { return {}; },
    async fetchDaily({ date }) { return { date }; },
    normalizeObservations({ date }) {
      return {
        schema_version: 1,
        date,
        source: { id: 'scoreless-physical', label: 'Scoreless Physical Sensor', reference: `sample:${date}` },
        freshness: { status: 'unknown', observed_at: null, evaluated_at: null, max_age_seconds: null },
        physical_metrics: [
          {
            metric: 'hrv', status: 'observed', value: 51, unit: 'ms',
            observed_at: `${date}T06:00:00Z`, observed_date: null, source_ref: 'sample:hrv',
            baseline: {
              status: 'unavailable', value: null, observed_days: 0, window_days: 28,
              scope: 'source', source_id: 'scoreless-physical'
            }
          },
          {
            metric: 'steps', status: 'observed', value: 6_200, unit: 'count',
            observed_at: null, observed_date: date, source_ref: 'sample:steps', baseline: null
          }
        ],
        proprietary_scores: []
      };
    }
  });

  const result = await syncDailyStateFromConnector({
    connectorId: 'scoreless-physical', paths, date: '2026-10-23', options: {}, env: {}
  });
  assert.equal(result.mode, 'UNAVAILABLE');
  assert.equal(result.score, null);
  assert.equal(result.decision_available, false);
  assert.equal(result.observation_set.proprietary_scores.length, 0);
  assert.equal(result.observation_set.physical_metrics.find((metric) => metric.metric === 'hrv').value, 51);
  assert.equal(result.observation_set.physical_metrics.find((metric) => metric.metric === 'hrv').baseline.status, 'unavailable');
  assert.equal(fs.readFileSync(paths.dailyStateFile, 'utf8').includes('2026-10-23,'), false);
  assert.equal(JSON.parse(fs.readFileSync(paths.wearableObservationsFile, 'utf8')).observations.length, 1);
});

test('Oura physical observations survive when proprietary scores are absent', async (t) => {
  const paths = makeWorkspace();
  t.after(() => fs.rmSync(paths.groupRoot, { recursive: true, force: true }));
  const result = await syncDailyStateFromConnector({
    connectorId: 'oura', paths, date: '2026-10-23', options: {
      'access-token': 'synthetic-token',
      fetchImpl: async (url) => {
        if (String(url).includes('/daily_readiness')) return okJson({ data: [{ day: '2026-10-23' }] });
        if (String(url).includes('/daily_sleep')) return okJson({ data: [{
          day: '2026-10-23', average_hrv: 47, lowest_heart_rate: 55,
          timestamp: '2026-10-23T06:30:00Z'
        }] });
        return okJson({ data: [] });
      }
    }, env: {}
  });

  assert.equal(result.decision_available, false);
  assert.equal(result.observation_set.physical_metrics.find((metric) => metric.metric === 'hrv').value, 47);
  assert.deepEqual(result.observation_set.proprietary_scores.map((score) => score.status), ['missing', 'missing']);
  assert.equal(fs.readFileSync(paths.dailyStateFile, 'utf8').includes('2026-10-23,'), false);
});

test('concurrent connector refreshes serialize token read-refresh-write and pass the mock provider', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'health-os-token-rotation-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const tokenFile = path.join(tempDir, 'token.json');
  writeOuraTokenFile(tokenFile, { access_token: 'access-0', refresh_token: 'refresh-0' });
  const observedRefreshTokens = [];
  let generation = 0;
  const fetchImpl = async (_url, init) => {
    const body = new URLSearchParams(init.body);
    observedRefreshTokens.push(body.get('refresh_token'));
    await new Promise((resolve) => setTimeout(resolve, 20));
    generation += 1;
    return okJson({ access_token: `access-${generation}`, refresh_token: `refresh-${generation}`, expires_in: 3600 });
  };
  const options = { 'token-file': tokenFile, 'client-id': 'synthetic-client', 'client-secret': 'synthetic-secret', fetchImpl };
  const env = {};
  const [first, second] = await Promise.all([
    ouraConnector.resolveAuth({ options, env }),
    ouraConnector.resolveAuth({ options, env })
  ]);
  assert.deepEqual(observedRefreshTokens, ['refresh-0', 'refresh-1']);
  assert.ok([first.accessToken, second.accessToken].includes('access-1'));
  assert.ok([first.accessToken, second.accessToken].includes('access-2'));
  assert.equal(JSON.parse(fs.readFileSync(tokenFile, 'utf8')).refresh_token, 'refresh-2');
});

test('connector raw bundles sharing an output directory serialize across workspaces', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'health-os-output-lock-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const firstPaths = buildPaths(path.join(tempDir, 'workspace-one'));
  const secondPaths = buildPaths(path.join(tempDir, 'workspace-two'));
  for (const paths of [firstPaths, secondPaths]) {
    ensureWorkspace(paths);
    initialiseWorkspace(paths, repoRoot());
  }

  let enterCount = 0;
  let activeWriters = 0;
  let peakWriters = 0;
  let releaseFirst;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  registerHealthDataConnector({
    id: 'synthetic-output-lock',
    label: 'Synthetic output lock fixture',
    capabilities: ['daily-recovery', 'raw-bundle'],
    requiredMetrics: [],
    async resolveAuth() { return {}; },
    async fetchDaily({ date, options }) { return { date, marker: options.marker }; },
    normalizeDaily({ date }) {
      return {
        date,
        readiness_score: 80,
        sleep_score: 78,
        hrv: 50,
        hrv_baseline_28d: 45,
        resting_hr: 55,
        resting_hr_baseline_28d: 58,
        sleep_efficiency: 0.9,
        total_sleep_minutes: 420,
        temperature_deviation: 0,
        source_sync_time: `${date}T06:00:00Z`,
        raw_metrics: { readiness_score: 80, sleep_score: 78, hrv: 50, resting_hr: 55 }
      };
    },
    resolveOutputDir({ options }) { return options['output-dir']; },
    async writeRawBundle({ outputDir, rawBundle }) {
      enterCount += 1;
      activeWriters += 1;
      peakWriters = Math.max(peakWriters, activeWriters);
      if (enterCount === 1) await firstGate;
      fs.mkdirSync(outputDir, { recursive: true });
      fs.appendFileSync(path.join(outputDir, 'write-order.txt'), `${rawBundle.marker}\n`);
      activeWriters -= 1;
    }
  });

  const outputDir = path.join(tempDir, 'shared-raw-output');
  const options = { 'output-dir': outputDir };
  const first = syncDailyStateFromConnector({
    connectorId: 'synthetic-output-lock', paths: firstPaths, date: '2026-10-23',
    options: { ...options, marker: 'first' }, env: {}
  });
  const readyDeadline = Date.now() + 5_000;
  while (enterCount < 1 && Date.now() < readyDeadline) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(enterCount, 1, 'first raw-bundle writer should enter');
  const second = syncDailyStateFromConnector({
    connectorId: 'synthetic-output-lock', paths: secondPaths, date: '2026-10-23',
    options: { ...options, marker: 'second' }, env: {}
  });
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(enterCount, 1);
  assert.equal(peakWriters, 1);
  releaseFirst();
  await Promise.all([first, second]);
  assert.equal(peakWriters, 1);
  assert.deepEqual(fs.readFileSync(path.join(outputDir, 'write-order.txt'), 'utf8').trim().split('\n').sort(), ['first', 'second']);
});
