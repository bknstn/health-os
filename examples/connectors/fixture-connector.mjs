#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  registerHealthDataConnector,
  syncDailyStateFromConnector
} from '../../src/health-data-connectors.js';
import { withWorkspaceLock } from '../../src/coordination.js';
import { initializeVersionedWorkspace } from '../../src/workspace-contract.js';
import { buildPaths, repoRoot } from '../../src/layout.js';
import { fixtureConnector } from './synthetic-fixture-connector.mjs';

const SYNTHETIC_DATE = '2026-10-23';

export async function runFixtureConnectorExample() {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'health-os-synthetic-connector-'));
  try {
    registerHealthDataConnector(fixtureConnector);
    const paths = buildPaths(temporaryRoot);
    initializeVersionedWorkspace(paths, repoRoot());
    const result = await withWorkspaceLock(paths, () => syncDailyStateFromConnector({
      connectorId: fixtureConnector.id,
      paths,
      date: SYNTHETIC_DATE,
      options: {},
      env: {}
    }));
    assert.equal(result.connector, fixtureConnector.id);
    assert.equal(result.date, SYNTHETIC_DATE);
    assert.equal(result.decision_available, false, 'physical-only fixture data must not invent a recovery score');
    assert.equal(result.mode, 'UNAVAILABLE');
    assert.deepEqual(result.observation_set.proprietary_scores, []);

    return {
      connector: result.connector,
      date: result.date,
      decision_available: result.decision_available,
      mode: result.mode,
      physical_metrics: result.observation_set.physical_metrics.map(({ metric, status }) => ({ metric, status })),
      proprietary_scores: result.observation_set.proprietary_scores
    };
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(path.resolve(process.argv[1]))).href) {
  runFixtureConnectorExample()
    .then((summary) => process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`))
    .catch((error) => {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    });
}
