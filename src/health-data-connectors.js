import fs from 'node:fs';

import { computeWorkspaceBaselines } from './baselines.js';
import { withPathLock } from './coordination.js';
import { ingestDailyState } from './engine.js';
import { validateRecoveryPayload } from './recovery-contract.js';
import { validateWearableObservationSet, WEARABLE_OBSERVATION_SCHEMA_VERSION } from './wearable-observation-contract.js';
import { computeSourceBaselineCoverage, writeWearableObservationSet } from './wearable-observation-store.js';
import { ouraConnector } from './oura-connector.js';

const CONNECTORS = new Map();

function assertConnector(connector) {
  if (!connector || typeof connector !== 'object') throw new Error('Health data connector must be an object');
  if (typeof connector.id !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(connector.id)) {
    throw new Error('Health data connector id must be a lowercase connector ID');
  }
  if (typeof connector.label !== 'string' || connector.label.trim() === '') {
    throw new Error(`Health data connector ${connector.id} must have a label`);
  }
  for (const field of ['capabilities', 'requiredMetrics']) {
    if (!Array.isArray(connector[field]) || connector[field].some((item) => typeof item !== 'string' || item.trim() === '')) {
      throw new Error(`Health data connector ${connector.id} ${field} must be an array of non-empty strings`);
    }
  }
  for (const method of ['resolveAuth', 'fetchDaily']) {
    if (typeof connector[method] !== 'function') {
      throw new Error(`Health data connector ${connector.id} is missing ${method}()`);
    }
  }
  if (connector.normalizeDaily !== undefined && typeof connector.normalizeDaily !== 'function') {
    throw new Error(`Health data connector ${connector.id} normalizeDaily must be a function`);
  }
  if (connector.normalizeObservations !== undefined && typeof connector.normalizeObservations !== 'function') {
    throw new Error(`Health data connector ${connector.id} normalizeObservations must be a function`);
  }
  if (typeof connector.normalizeDaily !== 'function' && typeof connector.normalizeObservations !== 'function') {
    throw new Error(`Health data connector ${connector.id} must implement normalizeDaily() or normalizeObservations()`);
  }
  if (typeof connector.normalizeObservations === 'function') {
    if (!Array.isArray(connector.observationSchemaVersions) ||
        !connector.observationSchemaVersions.includes(WEARABLE_OBSERVATION_SCHEMA_VERSION) ||
        !Array.isArray(connector.physicalMetrics) || !Array.isArray(connector.proprietaryScores)) {
      throw new Error(`Health data connector ${connector.id} must declare observationSchemaVersions, physicalMetrics, and proprietaryScores`);
    }
    if (connector.observationSchemaVersions.some((version) => version !== WEARABLE_OBSERVATION_SCHEMA_VERSION) ||
        new Set(connector.observationSchemaVersions).size !== connector.observationSchemaVersions.length) {
      throw new Error(`Health data connector ${connector.id} declares an unsupported or duplicate observation schema version`);
    }
    for (const metric of [...connector.physicalMetrics, ...connector.proprietaryScores]) {
      if (typeof metric !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(metric)) {
        throw new Error(`Health data connector ${connector.id} declares an invalid observation metric`);
      }
    }
    if (new Set(connector.physicalMetrics).size !== connector.physicalMetrics.length ||
        new Set(connector.proprietaryScores).size !== connector.proprietaryScores.length ||
        connector.physicalMetrics.some((metric) => connector.proprietaryScores.includes(metric))) {
      throw new Error(`Health data connector ${connector.id} declares duplicate observation metrics`);
    }
  }
}

export function registerHealthDataConnector(connector) {
  assertConnector(connector);
  if (CONNECTORS.has(connector.id)) {
    throw new Error(`Health data connector already registered: ${connector.id}`);
  }
  CONNECTORS.set(connector.id, connector);
}

export function listHealthDataConnectors() {
  return [...CONNECTORS.values()].map((connector) => ({
    id: connector.id,
    label: connector.label,
    capabilities: [...connector.capabilities],
    requiredMetrics: [...connector.requiredMetrics],
    ...(connector.normalizeObservations ? {
      observationSchemaVersions: [...connector.observationSchemaVersions],
      physicalMetrics: [...connector.physicalMetrics],
      proprietaryScores: [...connector.proprietaryScores]
    } : {})
  }));
}

export function getHealthDataConnector(id) {
  const connector = CONNECTORS.get(id);
  if (!connector) {
    throw new Error(`Unknown health data connector: ${id}`);
  }
  return connector;
}

function resolveBaselines(paths, date, options) {
  if (options.baselinesData !== undefined) {
    return JSON.parse(options.baselinesData);
  }
  if (options['baselines-file']) {
    return JSON.parse(fs.readFileSync(options['baselines-file'], 'utf8'));
  }
  return computeWorkspaceBaselines(paths, date) || {};
}

function resolveObservationBaselines(paths, sourceId, date, options) {
  const connector = getHealthDataConnector(sourceId);
  const coverage = Object.fromEntries(connector.physicalMetrics.map((metric) => [
    metric,
    computeSourceBaselineCoverage(paths, sourceId, date, metric)
  ]));
  let supplied;
  if (options.baselinesData !== undefined) {
    supplied = JSON.parse(options.baselinesData);
  } else if (options['baselines-file']) {
    supplied = JSON.parse(fs.readFileSync(options['baselines-file'], 'utf8'));
  }
  if (supplied && typeof supplied === 'object' && !Array.isArray(supplied)) {
    for (const [metric, field] of Object.entries({ hrv: 'hrv_baseline_28d', resting_hr: 'resting_hr_baseline_28d' })) {
      if (!Object.hasOwn(coverage, metric)) continue;
      const value = supplied[field];
      if (value === undefined || value === null || value === '') continue;
      if (typeof value !== 'number' && typeof value !== 'string') continue;
      if (typeof value === 'string' && value.trim() === '') continue;
      const number = Number(value);
      if (!Number.isFinite(number)) continue;
      coverage[metric] = {
        status: 'unknown', value: number, observed_days: null, window_days: null,
        scope: 'external', source_id: null
      };
    }
  }
  return coverage;
}

export async function syncDailyStateFromConnector({
  connectorId,
  paths,
  date,
  options = {},
  env = process.env
}) {
  const connector = getHealthDataConnector(connectorId);
  const auth = await connector.resolveAuth({ options, env });
  const rawBundle = await connector.fetchDaily({ date, options, env, auth });
  const outputDir = connector.resolveOutputDir?.({ options }) || options['output-dir'];

  if (outputDir) {
    if (typeof connector.writeRawBundle !== 'function') {
      throw new Error(`Health data connector ${connector.id} cannot write a raw bundle`);
    }
    await withPathLock(outputDir, () => connector.writeRawBundle({ outputDir, rawBundle }));
  }

  const observationDate = rawBundle.date || date;
  const baselines = resolveBaselines(paths, observationDate, options);
  let observationSet = null;
  if (connector.normalizeObservations) {
    observationSet = validateWearableObservationSet(connector.normalizeObservations({
      date: observationDate,
      rawBundle,
      baselines,
      baselineCoverage: resolveObservationBaselines(paths, connector.id, observationDate, options)
    }));
    if (observationSet.source.id !== connector.id || observationSet.date !== observationDate) {
      throw new Error(`Health data connector ${connector.id} returned observations for a different source or date`);
    }
    for (const [field, declared] of [
      ['physical_metrics', connector.physicalMetrics],
      ['proprietary_scores', connector.proprietaryScores]
    ]) {
      const returned = observationSet[field].map((metric) => metric.metric).sort();
      const expected = [...declared].sort();
      if (returned.length !== expected.length || returned.some((metric, index) => metric !== expected[index])) {
        throw new Error(`Health data connector ${connector.id} returned ${field} that do not match its declared capabilities`);
      }
    }
  }

  let normalized = null;
  if (connector.normalizeDaily) {
    normalized = connector.normalizeDaily({ date: observationDate, rawBundle, baselines });
    if (normalized !== null && normalized !== undefined) normalized = validateRecoveryPayload(normalized);
  }
  if (normalized && normalized.date !== observationDate) {
    throw new Error(`Health data connector ${connector.id} returned recovery for a different date`);
  }
  const decision = normalized ? ingestDailyState(paths, normalized) : null;
  if (observationSet) writeWearableObservationSet(paths, observationSet);

  return {
    connector: connector.id,
    date: observationDate,
    mode: decision?.mode || 'UNAVAILABLE',
    score: decision?.score ?? null,
    decision_available: Boolean(decision),
    ...(observationSet ? { observation_set: observationSet } : {}),
    token_refreshed: Boolean(auth.tokenRefreshed),
    output_dir: outputDir || ''
  };
}

registerHealthDataConnector(ouraConnector);
