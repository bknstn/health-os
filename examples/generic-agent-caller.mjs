#!/usr/bin/env node

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

function usage() {
  return 'Usage: node examples/generic-agent-caller.mjs WORKSPACE --as-of YYYY-MM-DD|RFC3339 [--session PLAN_KEY] [--substitute FROM=TO[,FROM=TO]]';
}

function parseArgs(argv) {
  const [workspace, ...rest] = argv;
  if (!workspace) throw new Error(usage());
  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index];
    if (!['--as-of', '--session', '--substitute'].includes(flag) || !rest[index + 1] || rest[index + 1].startsWith('--')) {
      throw new Error(usage());
    }
    options[flag] = rest[++index];
  }
  if (!options['--as-of']) throw new Error(usage());
  return { workspace: path.resolve(workspace), options };
}

function runHealthOs(cliPath, workspace, command, args, expectedSchemaVersion) {
  const childEnv = { PATH: process.env.PATH || '', TZ: process.env.TZ || 'UTC' };
  for (const key of ['TMPDIR', 'TMP', 'TEMP']) {
    if (process.env[key]) childEnv[key] = process.env[key];
  }
  if (process.platform === 'win32' && process.env.SystemRoot) childEnv.SystemRoot = process.env.SystemRoot;
  const child = spawnSync(process.execPath, [cliPath, command, ...args, '--workspace', workspace, '--json'], {
    encoding: 'utf8',
    env: childEnv,
    timeout: 30_000,
    maxBuffer: 256 * 1024
  });
  if (child.error) throw new Error(`Could not start Health OS: ${child.error.message}`);
  let envelope;
  try {
    envelope = JSON.parse(child.stdout.trim());
  } catch {
    throw new Error(`Health OS ${command} did not return one JSON envelope`);
  }
  if (envelope.schema_version !== expectedSchemaVersion || envelope.command !== command || typeof envelope.ok !== 'boolean') {
    throw new Error(`Health OS ${command} returned an unsupported JSON envelope`);
  }
  if (envelope.truncation?.truncated) throw new Error(`Health OS ${command} output was truncated; refusing to use partial context`);
  if (child.status !== 0 || !envelope.ok) {
    throw new Error(`Health OS ${command} failed (${envelope.error?.code || `exit ${child.status}`})`);
  }
  if (!Object.hasOwn(envelope, 'data')) throw new Error(`Health OS ${command} omitted its data object`);
  return envelope.data;
}

function main() {
  const { workspace, options } = parseArgs(process.argv.slice(2));
  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const cliPath = path.join(projectRoot, 'src', 'cli.js');
  const schema = runHealthOs(cliPath, workspace, 'capabilities', [], 1);
  if (!schema.commands?.includes('prepare-training') || schema.cli_json_schema_version !== 1) {
    throw new Error('This Health OS build does not advertise the supported preparation contract');
  }

  const prepareArgs = ['--as-of', options['--as-of']];
  if (options['--session']) prepareArgs.push('--session', options['--session']);
  if (options['--substitute']) prepareArgs.push('--substitute', options['--substitute']);
  const result = runHealthOs(cliPath, workspace, 'prepare-training', prepareArgs, schema.cli_json_schema_version);
  if (result.schema_version !== 1 || !result.as_of || !result.session_selection || !result.recovery?.decision || !result.workout || !Array.isArray(result.gaps)) {
    throw new Error('Health OS preparation result is missing required fields');
  }

  // Keep this example's terminal output small. An agent can pass the validated
  // result object to its own policy-controlled context handling instead.
  process.stdout.write(`${JSON.stringify({
    as_of: result.as_of.value,
    selected_day_type: result.session_selection.selected_day_type,
    recovery_status: result.recovery.decision.status,
    recovery_mode: result.recovery.decision.mode,
    workout_scheduled_only: result.workout.scheduled_only,
    gap_count: result.gaps.length
  }, null, 2)}\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
