import fs from 'node:fs';

import { computeWorkspaceBaselines } from './baselines.js';
import { ingestDailyState } from './engine.js';
import { validateRecoveryPayload } from './recovery-contract.js';
import { ouraConnector } from './oura-connector.js';

const CONNECTORS = new Map();

function assertConnector(connector) {
  for (const field of ['id', 'label', 'capabilities', 'requiredMetrics']) {
    if (!connector?.[field]) {
      throw new Error(`Health data connector is missing ${field}`);
    }
  }
  for (const method of ['resolveAuth', 'fetchDaily', 'normalizeDaily']) {
    if (typeof connector[method] !== 'function') {
      throw new Error(`Health data connector ${connector.id} is missing ${method}()`);
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
    requiredMetrics: [...connector.requiredMetrics]
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
  if (options['baselines-file']) {
    return JSON.parse(fs.readFileSync(options['baselines-file'], 'utf8'));
  }
  return computeWorkspaceBaselines(paths, date) || {};
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
    connector.writeRawBundle({ outputDir, rawBundle });
  }

  const normalized = validateRecoveryPayload(
    connector.normalizeDaily({
      date: rawBundle.date || date,
      rawBundle,
      baselines: resolveBaselines(paths, rawBundle.date || date, options)
    })
  );
  const decision = ingestDailyState(paths, normalized);

  return {
    connector: connector.id,
    date: normalized.date,
    mode: decision.mode,
    score: decision.score,
    token_refreshed: Boolean(auth.tokenRefreshed),
    output_dir: outputDir || ''
  };
}

registerHealthDataConnector(ouraConnector);
