#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

import {
  acquirePathLock,
  acquireWorkspaceLock,
  atomicWriteFileSync,
  withTokenFileLock
} from './coordination.js';
import {
  beginIdempotentRequest,
  capabilitiesInfo,
  CLI_COMMANDS,
  digestBytes,
  makeErrorEnvelope,
  makeSuccessEnvelope,
  versionInfo
} from './cli-contract.js';
import { computeWorkspaceBaselines } from './baselines.js';
import { buildPaths, ensureWorkspace, repoRoot } from './layout.js';
import { parseWorkoutLog, validateWorkoutLogPayload } from './log-parser.js';
import {
  buildOuraAuthorizeUrl,
  exchangeOuraCode,
  fetchOuraDay,
  readOuraTokenFile,
  refreshOuraAccessToken,
  writeOuraDayBundle,
  writeOuraTokenFile
} from './oura-api.js';
import { callbackPathFromRedirectUri, startOuraCallbackServer } from './oura-callback-server.js';
import {
  listHealthDataConnectors,
  syncDailyStateFromConnector
} from './health-data-connectors.js';
import { validateRecoveryPayload } from './recovery-contract.js';
import { validateWearableObservationSet } from './wearable-observation-contract.js';
import { listWearableObservationSets, writeWearableObservationSet } from './wearable-observation-store.js';
import {
  createHealthEvent,
  HEALTH_EVENT_SCHEMA_VERSION,
  MAX_EVENT_INPUT_BYTES,
  validateEventId,
  validateEventRequestKey,
  isValidOccurrenceBound
} from './event-contract.js';
import { assertMemoryEventProvenanceCurrent } from './event-memory-review.js';
import { normalizeOuraPayloadFromFiles } from './oura-adapter.js';
import { lintMemory, memoryContext, updateMemory } from './memory.js';
import {
  DEFAULT_PROFILE_MAX_CHARS,
  inspectWorkspace,
  initializeVersionedWorkspace,
  migrateWorkspace,
  readSelectedProfile,
  showProfileCommand,
  validateProfileCommand
} from './workspace-contract.js';
import {
  appendWorkoutLog,
  buildNextWorkout,
  ingestDailyState,
  initialiseWorkspace,
  localDateString,
  renderToday,
  setWorkingWeight,
  renderWeeklySummary,
  renderWhy
} from './engine.js';
import { validatePreparationAsOf } from './preparation-policy.js';

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (token.startsWith('--')) {
      options[token.slice(2)] = rest[index + 1] && !rest[index + 1].startsWith('--') ? rest[++index] : 'true';
    }
  }
  return { command, options };
}

function readInputBuffer(optionValue) {
  if (!optionValue || optionValue === '-') {
    return fs.readFileSync(0);
  }
  return fs.readFileSync(optionValue);
}

function splitScopes(value) {
  if (!value) {
    return ['daily', 'heartrate'];
  }
  return value
    .split(/[,\s]+/)
    .map((scope) => scope.trim())
    .filter(Boolean);
}

function jsonOutput(payload) {
  return `${JSON.stringify(payload, null, 2)}\n`;
}

let activeCliState;

function safeErrorMessage(error, options = {}) {
  let message = error?.message || 'Health OS command failed';
  const secretOptions = ['access-token', 'refresh-token', 'client-secret', 'code', 'state'];
  const secrets = secretOptions.map((key) => options[key]).filter((value) => typeof value === 'string' && value.length > 2);
  secrets.push(process.env.OURA_CLIENT_SECRET, process.env.OURA_REFRESH_TOKEN, process.env.OURA_CODE);
  for (const secret of secrets.filter(Boolean)) message = message.replaceAll(secret, '[redacted]');
  const characters = [...message];
  return characters.length > 1_000 ? `${characters.slice(0, 1_000).join('')}…` : message;
}

function emitResult(data, humanOutput, options = {}) {
  const exitCode = options.exitCode ?? 0;
  const ok = options.ok ?? exitCode === 0;
  const idempotency = activeCliState?.idempotency;
  if (idempotency?.status === 'new' && !options.replayed) {
    idempotency.complete({ data, humanOutput, exitCode, ok, error: options.error });
  }
  if (activeCliState?.json) {
    const status = activeCliState.idempotencyStatus || (idempotency?.status === 'new' ? 'completed' : undefined);
    process.stdout.write(`${JSON.stringify(makeSuccessEnvelope(activeCliState.command, data, {
      ok,
      error: options.error,
      idempotency: status ? { status } : undefined,
      maxTextChars: options.maxTextChars
    }))}\n`);
  } else {
    process.stdout.write(humanOutput);
  }
  process.exitCode = exitCode;
}

function emitError(error) {
  if (activeCliState?.json) {
    let status = activeCliState.idempotencyStatus;
    if (!status && error?.code?.startsWith('HEALTH_OS_IDEMPOTENCY_')) {
      status = error.code.endsWith('_CONFLICT') ? 'conflict' : error.code.endsWith('_IN_PROGRESS') ? 'in_progress' : 'error';
    }
    const safeError = Object.assign(new Error(safeErrorMessage(error, activeCliState.options)), { code: error?.code });
    process.stdout.write(`${JSON.stringify(makeErrorEnvelope(activeCliState.command, safeError, status ? { status } : undefined))}\n`);
  } else {
    process.stderr.write(`${safeErrorMessage(error, activeCliState?.options)}\n`);
  }
  process.exitCode = 1;
}

const WORKSPACE_LOCK_COMMANDS = new Set([
  'log-workout', 'set-working-weight', 'next', 'ingest-daily-state', 'ingest-wearable-observations', 'import-personal-file',
  'sync-daily-source', 'oura-sync-from-token', 'today', 'why', 'weekly-summary',
  'memory-update', 'memory-context', 'memory-lint',
  'context-add', 'context-correct', 'context-delete', 'context-revalidate-memory'
]);

const EVENT_WRITE_COMMANDS = new Set(['context-add', 'context-correct', 'context-delete']);
const EVENT_READ_COMMANDS = new Set(['context-query', 'timeline']);
const EVENT_PROTOCOL_COMMANDS = new Set([...EVENT_WRITE_COMMANDS, 'context-revalidate-memory']);
const OBSERVATION_WRITE_COMMANDS = new Set(['ingest-wearable-observations']);

const IDEMPOTENT_COMMANDS = new Set([
  ...[...WORKSPACE_LOCK_COMMANDS].filter((name) => !EVENT_PROTOCOL_COMMANDS.has(name))
]);

function inputCommand(command) {
  return [
    'log-workout', 'ingest-daily-state', 'validate-daily-state',
    'ingest-wearable-observations', 'validate-wearable-observations',
    'context-add', 'context-correct'
  ].includes(command);
}

function idempotencyRequest(command, options, inputBytes, importBytes, baselineBytes, importFileName, derivedMemoryGeneration) {
  const omitted = new Set([
    'idempotency-key', 'json', 'input', 'input-json', 'workspace', 'file', 'token-file',
    'access-token', 'refresh-token', 'client-secret', 'client-id', 'code', 'state'
  ]);
  const normalizedOptions = Object.fromEntries(Object.entries(options)
    .filter(([key]) => !omitted.has(key))
    .sort(([left], [right]) => left.localeCompare(right)));
  const effectiveDate = options.date || options['end-date'] || localDateString();
  return {
    command,
    options: normalizedOptions,
    effective_date: effectiveDate,
    ...(inputBytes ? { input_sha256: digestBytes(inputBytes) } : {}),
    ...(importBytes ? { file_sha256: digestBytes(importBytes) } : {}),
    ...(baselineBytes ? { baselines_sha256: digestBytes(baselineBytes) } : {}),
    ...(importFileName ? { import_file_name: importFileName, import_kind: options.kind || 'raw' } : {}),
    ...(derivedMemoryGeneration !== undefined ? { derived_memory_generation: derivedMemoryGeneration } : {})
  };
}

function safePersonalFileName(filePath, nameOverride) {
  if (nameOverride && (nameOverride.includes('/') || nameOverride.includes('\\'))) {
    throw new Error('import-personal-file --name must be a file name, not a path');
  }
  const fileName = path.basename(nameOverride || filePath);
  if (!fileName || fileName === '.' || fileName === '..' || fileName.includes('/') || fileName.includes('\\')) {
    throw new Error('import-personal-file requires a safe file name');
  }
  return fileName;
}

function personalImportTarget(paths, kind = 'raw') {
  if (kind === 'raw') {
    return paths.personalRawDir;
  }
  if (kind === 'processed') {
    return paths.personalFilesDir;
  }
  throw new Error('import-personal-file --kind must be raw or processed');
}

function pickTokenPath(options) {
  return options['token-file'] || process.env.OURA_TOKEN_FILE || '';
}

async function resolveAccessToken(options) {
  if (options['access-token']) {
    return options['access-token'];
  }
  const tokenPath = pickTokenPath(options);
  if (!tokenPath) {
    return '';
  }
  return withTokenFileLock(tokenPath, async (resolvedTokenPath) => {
    const tokenPayload = readOuraTokenFile(resolvedTokenPath);
    return tokenPayload.access_token || '';
  });
}

function printWorkout(nextWorkout) {
  const lines = [];
  lines.push(`mode=${nextWorkout.mode}`);
  lines.push(`day=${nextWorkout.dayType}`);
  for (const exercise of nextWorkout.exercises) {
    const weight = exercise.target_weight || (exercise.load_tier === 'bodyweight' ? 'bodyweight' : 'unset');
    lines.push(
      `${exercise.exercise_key}=${exercise.target_sets}x${exercise.target_reps}@${weight}`
    );
  }
  return `${lines.join('\n')}\n`;
}

function eventProfileId(paths, explicitProfilePath, { required = false } = {}) {
  const inspected = inspectWorkspace(paths);
  if (inspected.status === 'versioned') {
    return readSelectedProfile(paths, explicitProfilePath).manifest.profile_path;
  }
  if (inspected.status === 'invalid' || inspected.status.startsWith('invalid_profile_')) {
    throw Object.assign(new Error(inspected.error || 'Selected workspace profile is invalid'), { code: 'HEALTH_OS_WORKSPACE_INVALID' });
  }
  if (fs.existsSync(paths.eventsDbFile)) {
    throw Object.assign(new Error('Event store exists but the workspace has no valid versioned selected profile'), { code: 'HEALTH_OS_WORKSPACE_INVALID' });
  }
  if (required || explicitProfilePath !== undefined) {
    return readSelectedProfile(paths, explicitProfilePath).manifest.profile_path;
  }
  return null;
}

function parseDateFilter(value, optionName) {
  if (value === undefined) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`--${optionName} must use YYYY-MM-DD`);
  const date = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new Error(`--${optionName} must be a real calendar date`);
  }
  return value;
}

function parseFilterList(value, optionName) {
  if (value === undefined) return undefined;
  const items = value.split(',').map((item) => item.trim()).filter(Boolean);
  if (items.length === 0 || items.length > 20 || items.some((item) => item.length > 100)) {
    throw new Error(`--${optionName} must be a comma-separated list of 1-20 values, each at most 100 characters`);
  }
  return [...new Set(items)];
}

function parseBoundedLimit(value, defaultValue = 25) {
  const limit = value === undefined ? defaultValue : Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error('--limit must be an integer from 1 to 50');
  return limit;
}

function validateBooleanOption(options, key, defaultValue = false) {
  const value = options[key];
  if (value === undefined) return defaultValue;
  if (!['true', 'false'].includes(value)) throw new Error(`--${key} accepts only true or false`);
  return value === 'true';
}

function commandEventHumanOutput(data, action) {
  const eventId = data.event?.event_id || 'unknown';
  const status = data.status || action;
  return `${action} ${eventId} (${status})\n`;
}

function requireExpectedRevision(value, action) {
  const revision = Number(value);
  if (!Number.isSafeInteger(revision) || revision < 1 || value === undefined) {
    throw new Error(`${action} requires a positive integer --expected-revision from context-query`);
  }
  return revision;
}

async function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
  activeCliState = {
    command: command || '',
    options,
    json: options.json === 'true'
  };
  if (options.json !== undefined && !['true', 'false'].includes(options.json)) {
    throw new Error('--json accepts only true or false');
  }
  if (options['input-json'] !== undefined && options['input-json'] !== 'true') {
    throw new Error('--input-json is a flag and does not accept a value');
  }
  if (options['export-token'] !== undefined && !['true', 'false'].includes(options['export-token'])) {
    throw new Error('--export-token accepts only true or false');
  }
  if (!CLI_COMMANDS.includes(command)) {
    const message = `Unknown command: ${command || '(missing)'}\nUsage: node src/cli.js <${CLI_COMMANDS.join('|')}> [--workspace PATH] [--input FILE|-] [--input-json] [--json]`;
    const error = Object.assign(new Error(message), { code: 'HEALTH_OS_UNKNOWN_COMMAND' });
    throw error;
  }

  if (['oura-exchange-code', 'oura-refresh-token'].includes(command) &&
      !pickTokenPath(options) && options['export-token'] !== 'true') {
    throw new Error(`${command} requires --token-file or OURA_TOKEN_FILE; use --export-token true only when deliberately handling token contents`);
  }

  const paths = buildPaths(options.workspace);
  if (command === 'version') {
    emitResult(versionInfo(), `${versionInfo().name} ${versionInfo().version}\n`);
    return;
  }
  if (command === 'capabilities') {
    emitResult(capabilitiesInfo(), jsonOutput(capabilitiesInfo()));
    return;
  }

  let inputBytes;
  let preparedInput;
  if (inputCommand(command)) {
    if (EVENT_WRITE_COMMANDS.has(command) && !options['input-json']) {
      throw new Error(`${command} requires --input-json with a bare HealthEvent object on stdin`);
    }
    if (OBSERVATION_WRITE_COMMANDS.has(command) && !options['input-json']) {
      throw new Error(`${command} requires --input-json with a bare HealthObservationSet v1 object on stdin`);
    }
    if (options['input-json'] !== undefined && options.input !== undefined && options.input !== '-') {
      throw new Error('--input-json cannot be combined with --input');
    }
    if (options['input-json'] !== undefined && !inputCommand(command)) {
      throw new Error('--input-json is not supported for this command');
    }
    inputBytes = readInputBuffer(options['input-json'] ? undefined : options.input);
    const inputText = inputBytes.toString('utf8');
    if (EVENT_WRITE_COMMANDS.has(command) && inputBytes.byteLength > MAX_EVENT_INPUT_BYTES) {
      throw new Error(`HealthEvent input exceeds ${MAX_EVENT_INPUT_BYTES} bytes`);
    }
    if ([...OBSERVATION_WRITE_COMMANDS, 'validate-wearable-observations'].includes(command) && inputBytes.byteLength > 256 * 1024) {
      throw new Error('HealthObservationSet input exceeds 262144 bytes');
    }
    if (command === 'log-workout') {
      preparedInput = options['input-json']
        ? validateWorkoutLogPayload(JSON.parse(inputText))
        : parseWorkoutLog(inputText);
    } else if (EVENT_WRITE_COMMANDS.has(command)) {
      preparedInput = JSON.parse(inputText);
    } else if ([...OBSERVATION_WRITE_COMMANDS, 'validate-wearable-observations'].includes(command)) {
      preparedInput = validateWearableObservationSet(JSON.parse(inputText));
    } else {
      preparedInput = validateRecoveryPayload(JSON.parse(inputText));
    }
  } else if (options['input-json'] !== undefined || options.input !== undefined) {
    throw new Error('--input and --input-json are only valid for workout/recovery/observation payloads, context-add, and context-correct');
  }

  let importBytes;
  let importSourcePath;
  let importFileName;
  if (command === 'import-personal-file') {
    if (!options.file) throw new Error('import-personal-file requires --file');
    if (options.kind !== undefined && !['raw', 'processed'].includes(options.kind)) {
      throw new Error('import-personal-file --kind must be raw or processed');
    }
    if (options.replace !== undefined && !['true', 'false'].includes(options.replace)) {
      throw new Error('import-personal-file --replace accepts only true or false');
    }
    importSourcePath = path.resolve(options.file);
    importFileName = safePersonalFileName(importSourcePath, options.name);
    importBytes = fs.readFileSync(importSourcePath);
  }

  if (command === 'set-working-weight') {
    const weight = Number(options.weight);
    const increment = options.increment === undefined ? undefined : Number(options.increment);
    if (!options.exercise || !options.weight || !Number.isFinite(weight) || weight <= 0 ||
        (increment !== undefined && (!Number.isFinite(increment) || increment < 0))) {
      throw new Error('set-working-weight requires an exercise, a positive finite --weight, and a finite nonnegative --increment when provided');
    }
  }

  let baselineBytes;
  if (options['baselines-file'] && (command === 'sync-daily-source' || command === 'oura-sync-from-token')) {
    baselineBytes = fs.readFileSync(options['baselines-file']);
  }

  if (options['idempotency-key'] && !IDEMPOTENT_COMMANDS.has(command) && !EVENT_WRITE_COMMANDS.has(command)) {
    throw new Error(`--idempotency-key is not supported for ${command}; use it only with advertised idempotent commands`);
  }
  if (EVENT_WRITE_COMMANDS.has(command) && !options['idempotency-key']) {
    throw new Error(`${command} requires --idempotency-key`);
  }
  if (OBSERVATION_WRITE_COMMANDS.has(command) && !options['idempotency-key']) {
    throw new Error(`${command} requires --idempotency-key`);
  }

  if (command === 'workspace-inspect') {
    const result = inspectWorkspace(paths);
    const invalid = result.status === 'invalid' || result.status.startsWith('invalid_profile_');
    emitResult(result, jsonOutput(result), {
      ok: !invalid,
      exitCode: invalid ? 1 : 0,
      error: invalid ? { code: 'HEALTH_OS_WORKSPACE_INVALID', message: result.error || result.status } : undefined
    });
    return;
  }
  if (command === 'workspace-migrate') {
    if (options.to !== '1') throw new Error('workspace-migrate requires --to 1');
    if (options['dry-run'] !== undefined && !['true', 'false'].includes(options['dry-run'])) {
      throw new Error('workspace-migrate --dry-run accepts only true or false');
    }
    const dryRun = options['dry-run'] === 'true';
    const migrate = () => migrateWorkspace(paths, options.profile, dryRun);
    const result = dryRun ? migrate() : await (async () => {
      const release = await acquireWorkspaceLock(paths);
      try { return migrate(); } finally { release(); }
    })();
    emitResult(result, jsonOutput(result));
    return;
  }
  if (command === 'profile-validate') {
    const result = validateProfileCommand(paths, options.profile);
    emitResult(result, jsonOutput(result));
    return;
  }
  if (command === 'profile-show') {
    const maxChars = options['max-chars'] === undefined ? DEFAULT_PROFILE_MAX_CHARS : Number(options['max-chars']);
    const result = showProfileCommand(paths, options.profile, maxChars);
    emitResult(result, jsonOutput(result), { maxTextChars: maxChars });
    return;
  }
  if (command === 'init-workspace') {
    const release = await acquireWorkspaceLock(paths);
    try {
      const result = initializeVersionedWorkspace(paths, repoRoot(), options.profile);
      emitResult(result, `Initialized workspace at ${paths.trackerRoot}\n`);
    } finally { release(); }
    return;
  }

  if (command === 'prepare-training') {
    if (options['as-of'] === undefined) throw new Error('prepare-training requires --as-of YYYY-MM-DD or an RFC3339 timestamp');
    if (options.profile !== undefined) throw new Error('prepare-training uses the profile selected by the workspace manifest; --profile is not supported');
    const asOf = validatePreparationAsOf(options['as-of']);
    const allowedWorkspaceStates = new Set(['versioned', 'invalid_profile_missing']);
    const initialWorkspace = inspectWorkspace(paths);
    if (!allowedWorkspaceStates.has(initialWorkspace.status)) {
      throw Object.assign(new Error(`prepare-training requires an existing versioned workspace; workspace status is ${initialWorkspace.status}`), { code: 'HEALTH_OS_WORKSPACE_INVALID' });
    }
    const release = await acquireWorkspaceLock(paths);
    try {
      const currentWorkspace = inspectWorkspace(paths);
      if (!allowedWorkspaceStates.has(currentWorkspace.status)) {
        throw Object.assign(new Error(`Workspace changed before preparation; current status is ${currentWorkspace.status}`), { code: 'HEALTH_OS_WORKSPACE_INVALID' });
      }
      const { prepareTraining } = await import('./training-preparation.js');
      const prepared = prepareTraining(paths, {
        asOf,
        explicitSession: options.session,
        substitute: options.substitute
      });
      if (makeSuccessEnvelope(command, prepared.data).truncation) {
        throw Object.assign(new Error('Preparation output would exceed a structured JSON envelope bound; narrative context must be reduced before use.'), { code: 'HEALTH_OS_PREPARATION_OUTPUT_LIMIT' });
      }
      emitResult(prepared.data, prepared.humanOutput);
    } finally {
      release();
    }
    return;
  }

  if (EVENT_READ_COMMANDS.has(command)) {
    const since = parseDateFilter(options.since, 'since');
    const through = parseDateFilter(options.through, 'through');
    if (since && through && since > through) throw new Error('--since must not be after --through');
    const types = parseFilterList(options.type, 'type');
    const sources = parseFilterList(options.source, 'source');
    const limit = parseBoundedLimit(options.limit);
    const includeInactive = command === 'context-query' ? validateBooleanOption(options, 'include-inactive') : false;
    const epistemicStatus = options['epistemic-status'];
    if (epistemicStatus !== undefined && !['fact', 'pending'].includes(epistemicStatus)) {
      throw new Error('--epistemic-status must be fact or pending');
    }
    const profileId = eventProfileId(paths, options.profile);
    const { queryEvents } = await import('./event-store.js');
    const eventQuery = queryEvents(paths, profileId, {
      eventId: command === 'context-query' && options['event-id'] ? validateEventId(options['event-id']) : undefined,
      since,
      through,
      types,
      sources,
      limit,
      includeInactive: includeInactive || Boolean(options['event-id']),
      epistemicStatus,
      order: command === 'timeline' ? 'timeline' : undefined
    });
    if (command === 'context-query') {
      const result = { profile_id: profileId, ...eventQuery };
      emitResult(result, jsonOutput(result));
      return;
    }
    const { buildTimeline } = await import('./timeline.js');
    const result = buildTimeline(paths, {
      events: eventQuery.events,
      event_matched_count: eventQuery.matched_count,
      event_truncated: eventQuery.truncated,
      event_source_counts: eventQuery.source_counts,
      since,
      through,
      types,
      sources,
      limit
    });
    emitResult(result, jsonOutput(result));
    return;
  }

  let releaseWorkspace;
  let releaseOutput;
  try {
    if (WORKSPACE_LOCK_COMMANDS.has(command)) {
      releaseWorkspace = await acquireWorkspaceLock(paths);
      if (EVENT_PROTOCOL_COMMANDS.has(command)) {
        eventProfileId(paths, options.profile, { required: true });
      } else {
        ensureWorkspace(paths);
      }
    }
    if (command === 'oura-fetch-day' && options['output-dir']) {
      releaseOutput = await acquirePathLock(options['output-dir']);
    }

    let derivedMemoryGeneration;
    if (command === 'memory-context') {
      assertMemoryEventProvenanceCurrent(paths);
      const reviewFileExists = fs.existsSync(paths.eventReviewFile);
      const eventDbExists = fs.existsSync(paths.eventsDbFile);
      if (reviewFileExists || eventDbExists) {
        const { assertEventMemoryReviewMatchesStore } = await import('./event-store.js');
        const review = assertEventMemoryReviewMatchesStore(paths);
        derivedMemoryGeneration = JSON.stringify({
          store_id: review?.store_id || null,
          reviewed_generation: review?.reviewed_generation ?? 0,
          required_generation: review?.required_generation ?? 0,
          pending: review?.pending ?? false,
          review_digest: reviewFileExists ? digestBytes(fs.readFileSync(paths.eventReviewFile)) : 'missing'
        });
      }
    } else if (command === 'memory-lint') {
      const review = (await import('./event-memory-review.js')).readEventReviewState(paths, { allowPending: true });
      if (review) {
        const { assertEventMemoryReviewMatchesStore } = await import('./event-store.js');
        assertEventMemoryReviewMatchesStore(paths, { allowPending: true });
        derivedMemoryGeneration = JSON.stringify({
          store_id: review.store_id,
          reviewed_generation: review.reviewed_generation,
          required_generation: review.required_generation,
          pending: review.pending,
          review_digest: digestBytes(fs.readFileSync(paths.eventReviewFile))
        });
      }
    }

    if (options['idempotency-key'] && IDEMPOTENT_COMMANDS.has(command)) {
      activeCliState.idempotency = beginIdempotentRequest(
        paths,
        options['idempotency-key'],
        idempotencyRequest(command, options, inputBytes, importBytes, baselineBytes, importFileName, derivedMemoryGeneration)
      );
      if (activeCliState.idempotency.status === 'replayed') {
        const record = activeCliState.idempotency.record;
        activeCliState.idempotencyStatus = 'replayed';
        emitResult(record.data, record.human_output, {
          ok: record.ok,
          exitCode: record.exit_code,
          error: record.error,
          replayed: true
        });
        return;
      }
    }

    switch (command) {
      case 'context-add': {
        const profileId = eventProfileId(paths, options.profile, { required: true });
        const event = createHealthEvent(preparedInput, { profileId });
        const supersedesEventId = options['supersedes-event-id']
          ? validateEventId(options['supersedes-event-id'])
          : undefined;
        const expectedRevision = supersedesEventId
          ? requireExpectedRevision(options['expected-revision'], 'context-add --supersedes-event-id')
          : undefined;
        if (!supersedesEventId && options['expected-revision'] !== undefined) {
          throw new Error('--expected-revision is only valid with --supersedes-event-id');
        }
        const { mutateEvent } = await import('./event-store.js');
        const result = mutateEvent(paths, {
          action: command,
          key: validateEventRequestKey(options['idempotency-key']),
          request: {
            command,
            event: { ...event, event_id: preparedInput?.event_id ?? null },
            supersedes_event_id: supersedesEventId ?? null,
            expected_revision: expectedRevision ?? null
          },
          event,
          profileId,
          supersedesEventId,
          expectedRevision
        });
        activeCliState.idempotencyStatus = ['replayed', 'duplicate', 'tombstone'].includes(result.status) ? 'replayed' : 'completed';
        const output = { status: result.status, event: result.event, generation: result.generation };
        emitResult(output, commandEventHumanOutput(output, 'context-add'));
        return;
      }
      case 'context-correct': {
        const profileId = eventProfileId(paths, options.profile, { required: true });
        const eventId = validateEventId(options['event-id']);
        const expectedRevision = requireExpectedRevision(options['expected-revision'], 'context-correct');
        if (preparedInput?.event_id !== undefined && validateEventId(preparedInput.event_id) !== eventId) {
          throw new Error('context-correct HealthEvent event_id must match --event-id');
        }
        const event = createHealthEvent(preparedInput, { profileId, eventId });
        const { mutateEvent } = await import('./event-store.js');
        const result = mutateEvent(paths, {
          action: command,
          key: validateEventRequestKey(options['idempotency-key']),
          request: { command, event_id: eventId, expected_revision: expectedRevision, event: { ...event, event_id: preparedInput?.event_id ?? null } },
          event,
          eventId,
          profileId,
          expectedRevision
        });
        activeCliState.idempotencyStatus = ['replayed', 'duplicate', 'tombstone'].includes(result.status) ? 'replayed' : 'completed';
        const output = { status: result.status, event: result.event, generation: result.generation };
        emitResult(output, commandEventHumanOutput(output, 'context-correct'));
        return;
      }
      case 'context-delete': {
        const profileId = eventProfileId(paths, options.profile, { required: true });
        const eventId = validateEventId(options['event-id']);
        const expectedRevision = requireExpectedRevision(options['expected-revision'], 'context-delete');
        const { mutateEvent } = await import('./event-store.js');
        const result = mutateEvent(paths, {
          action: command,
          key: validateEventRequestKey(options['idempotency-key']),
          request: { command, event_id: eventId, expected_revision: expectedRevision },
          eventId,
          profileId,
          expectedRevision
        });
        activeCliState.idempotencyStatus = ['replayed', 'tombstone'].includes(result.status) ? 'replayed' : 'completed';
        const output = { status: result.status, event: result.event, generation: result.generation };
        emitResult(output, commandEventHumanOutput(output, 'context-delete'));
        return;
      }
      case 'context-revalidate-memory': {
        const profileId = eventProfileId(paths, options.profile, { required: true });
        if (profileId === undefined) throw new Error('A selected versioned profile is required');
        const generation = Number(options.generation);
        if (!Number.isSafeInteger(generation) || generation < 0 || options.generation === undefined) {
          throw new Error('context-revalidate-memory requires a nonnegative integer --generation');
        }
        const { revalidateEventMemory } = await import('./event-store.js');
        const result = revalidateEventMemory(paths, generation);
        emitResult(result, `Reviewed derived memory at event generation ${generation}\n`);
        return;
      }
      case 'log-workout': {
        initialiseWorkspace(paths, repoRoot());
        const date = options.date || localDateString();
        const sessionId = appendWorkoutLog(paths, preparedInput, date);
        emitResult({ session_id: sessionId, date }, `Logged workout ${sessionId}\n`);
        return;
      }
      case 'set-working-weight': {
        initialiseWorkspace(paths, repoRoot());
        if (!options.exercise || !options.weight) throw new Error('set-working-weight requires --exercise and --weight');
        const increment = options.increment !== undefined ? Number(options.increment) : undefined;
        const weight = Number(options.weight);
        if (!Number.isFinite(weight) || weight <= 0 || (increment !== undefined && (!Number.isFinite(increment) || increment < 0))) {
          throw new Error('set-working-weight requires a positive finite --weight and, when provided, a finite nonnegative --increment');
        }
        setWorkingWeight(paths, options.exercise, weight, increment);
        emitResult({ exercise: options.exercise, weight_kg: weight, increment_kg: increment ?? null },
          `Updated ${options.exercise} working weight to ${options.weight} kg\n`);
        return;
      }
      case 'next': {
        initialiseWorkspace(paths, repoRoot());
        const result = buildNextWorkout(paths, options.date || localDateString());
        emitResult(result, printWorkout(result));
        return;
      }
      case 'ingest-daily-state': {
        initialiseWorkspace(paths, repoRoot());
        const decision = ingestDailyState(paths, preparedInput);
        emitResult({ date: preparedInput.date, mode: decision.mode, score: decision.score }, `mode=${decision.mode}\nscore=${decision.score}\n`);
        return;
      }
      case 'validate-daily-state':
        emitResult(preparedInput, jsonOutput(preparedInput));
        return;
      case 'validate-wearable-observations':
        emitResult(preparedInput, jsonOutput(preparedInput));
        return;
      case 'ingest-wearable-observations': {
        initialiseWorkspace(paths, repoRoot());
        const observation = writeWearableObservationSet(paths, preparedInput);
        const result = { status: 'stored', observation };
        emitResult(result, `Stored ${observation.source.id} observations for ${observation.date}\n`);
        return;
      }
      case 'wearable-observations': {
        const source = options.source;
        const date = options.date === undefined ? undefined : parseDateFilter(options.date, 'date');
        const limit = parseBoundedLimit(options.limit, 50);
        const result = listWearableObservationSets(paths, { source, date, limit });
        emitResult(result, jsonOutput(result));
        return;
      }
      case 'personal-files-dir':
        emitResult({ path: paths.personalFilesDir }, `${paths.personalFilesDir}\n`);
        return;
      case 'personal-raw-dir':
        emitResult({ path: paths.personalRawDir }, `${paths.personalRawDir}\n`);
        return;
      case 'import-personal-file': {
        initialiseWorkspace(paths, repoRoot());
        const fileName = safePersonalFileName(importSourcePath, options.name);
        const kind = options.kind || 'raw';
        const targetPath = path.join(personalImportTarget(paths, kind), fileName);
        if (fs.existsSync(targetPath) && options.replace !== 'true') {
          throw new Error(`Personal file already exists: ${targetPath}. Pass --replace true to overwrite it.`);
        }
        atomicWriteFileSync(targetPath, importBytes, {
          mode: 0o600,
          exclusive: options.replace !== 'true'
        });
        const result = { kind, stored_file: targetPath };
        emitResult(result, jsonOutput(result));
        return;
      }
      case 'connectors': {
        const result = listHealthDataConnectors();
        emitResult(result, jsonOutput(result));
        return;
      }
      case 'sync-daily-source': {
        initialiseWorkspace(paths, repoRoot());
        const syncOptions = baselineBytes ? { ...options, baselinesData: baselineBytes.toString('utf8') } : options;
        const result = await syncDailyStateFromConnector({
          connectorId: options.source || 'oura', paths,
          date: options.date || localDateString(), options: syncOptions
        });
        emitResult(result, jsonOutput(result));
        return;
      }
      case 'normalize-oura-json': {
        const date = options.date || localDateString();
        const baselines = options['baselines-file'] ? undefined : computeWorkspaceBaselines(paths, date);
        const result = normalizeOuraPayloadFromFiles({
          date,
          readinessFile: options['readiness-file'],
          sleepFile: options['sleep-file'],
          heartrateFile: options['heartrate-file'],
          baselinesFile: options['baselines-file'],
          baselines
        });
        emitResult(result, jsonOutput(result));
        return;
      }
      case 'oura-auth-url': {
        const url = buildOuraAuthorizeUrl({
          clientId: options['client-id'] || process.env.OURA_CLIENT_ID,
          redirectUri: options['redirect-uri'] || process.env.OURA_REDIRECT_URI,
          scopes: splitScopes(options.scope || process.env.OURA_SCOPE),
          state: options.state || process.env.OURA_STATE,
          responseType: options['response-type'] || process.env.OURA_RESPONSE_TYPE || 'code'
        });
        emitResult({ url }, `${url}\n`);
        return;
      }
      case 'oura-exchange-code': {
        const tokenPath = pickTokenPath(options);
        let tokenPayload;
        const exchange = async (resolvedPath) => {
          tokenPayload = await exchangeOuraCode({
            code: options.code || process.env.OURA_CODE,
            clientId: options['client-id'] || process.env.OURA_CLIENT_ID,
            clientSecret: options['client-secret'] || process.env.OURA_CLIENT_SECRET,
            redirectUri: options['redirect-uri'] || process.env.OURA_REDIRECT_URI
          });
          if (resolvedPath) writeOuraTokenFile(resolvedPath, tokenPayload);
        };
        if (tokenPath) await withTokenFileLock(tokenPath, exchange);
        else await exchange('');
        const result = { stored: Boolean(tokenPath), token_file: tokenPath || null };
        if (options['export-token'] === 'true') result.token = tokenPayload;
        emitResult(result, options['export-token'] === 'true' ? jsonOutput(tokenPayload) :
          `${tokenPath ? `Token stored at ${tokenPath}` : 'Token received; no token file was configured.'}\n`);
        return;
      }
      case 'oura-refresh-token': {
        const tokenPath = pickTokenPath(options);
        let tokenPayload;
        const refresh = async (resolvedPath) => {
          const fileToken = resolvedPath ? readOuraTokenFile(resolvedPath) : null;
          tokenPayload = await refreshOuraAccessToken({
            refreshToken: options['refresh-token'] || process.env.OURA_REFRESH_TOKEN || fileToken?.refresh_token,
            clientId: options['client-id'] || process.env.OURA_CLIENT_ID,
            clientSecret: options['client-secret'] || process.env.OURA_CLIENT_SECRET
          });
          if (resolvedPath) writeOuraTokenFile(resolvedPath, tokenPayload);
        };
        if (tokenPath) await withTokenFileLock(tokenPath, refresh);
        else await refresh('');
        const result = { stored: Boolean(tokenPath), token_file: tokenPath || null };
        if (options['export-token'] === 'true') result.token = tokenPayload;
        emitResult(result, options['export-token'] === 'true' ? jsonOutput(tokenPayload) :
          `${tokenPath ? `Token refreshed and stored at ${tokenPath}` : 'Token refreshed; no token file was configured.'}\n`);
        return;
      }
      case 'oura-fetch-day': {
        const bundle = await fetchOuraDay({
          accessToken: await resolveAccessToken(options),
          date: options.date || localDateString(),
          apiBaseUrl: options['api-base-url'] || process.env.OURA_API_BASE_URL,
          readinessPath: options['readiness-path'] || process.env.OURA_READINESS_PATH || undefined,
          sleepPath: options['sleep-path'] || process.env.OURA_SLEEP_PATH || undefined,
          heartratePath: options['heartrate-path'] || process.env.OURA_HEARTRATE_PATH || undefined,
          optionalHeartrate: options['strict-heartrate'] === 'true' || process.env.OURA_STRICT_HEARTRATE === 'true' ? false : true
        });
        if (options['output-dir']) writeOuraDayBundle(options['output-dir'], bundle);
        emitResult(bundle, jsonOutput(bundle));
        return;
      }
      case 'oura-sync-from-token': {
        initialiseWorkspace(paths, repoRoot());
        const syncOptions = baselineBytes ? { ...options, baselinesData: baselineBytes.toString('utf8') } : options;
        const result = await syncDailyStateFromConnector({
          connectorId: 'oura', paths, date: options.date || localDateString(), options: syncOptions
        });
        emitResult(result, jsonOutput(result));
        return;
      }
      case 'oura-listen-callback': {
        const tokenPath = pickTokenPath(options);
        if (!tokenPath) throw new Error('oura-listen-callback requires --token-file or OURA_TOKEN_FILE');
        const redirectUri = options['redirect-uri'] || process.env.OURA_REDIRECT_URI;
        const callbackPath = options['callback-path'] || process.env.OURA_CALLBACK_PATH || callbackPathFromRedirectUri(redirectUri);
        const listener = startOuraCallbackServer({
          listenHost: options['listen-host'] || process.env.OURA_CALLBACK_HOST || '127.0.0.1',
          listenPort: Number(options['listen-port'] || process.env.OURA_CALLBACK_PORT || '8787'),
          callbackPath,
          expectedState: options.state || process.env.OURA_STATE || '',
          clientId: options['client-id'] || process.env.OURA_CLIENT_ID,
          clientSecret: options['client-secret'] || process.env.OURA_CLIENT_SECRET,
          redirectUri,
          tokenFile: tokenPath,
          logger: activeCliState.json ? { log() {}, error() {} } : console
        });
        await listener.started;
        const callbackResult = await listener.done;
        const result = { token_file: callbackResult.tokenFile, callback_path: callbackPath, stored: true };
        emitResult(result, jsonOutput(result));
        return;
      }
      case 'today': {
        initialiseWorkspace(paths, repoRoot());
        const text = renderToday(paths, options.date || localDateString());
        emitResult({ text, characters: [...text].length }, text);
        return;
      }
      case 'why': {
        initialiseWorkspace(paths, repoRoot());
        const text = renderWhy(paths);
        emitResult({ text, characters: [...text].length }, text);
        return;
      }
      case 'weekly-summary': {
        initialiseWorkspace(paths, repoRoot());
        const text = renderWeeklySummary(paths, options['end-date'] || localDateString());
        emitResult({ text, characters: [...text].length }, text);
        return;
      }
      case 'memory-update': {
        initialiseWorkspace(paths, repoRoot());
        const result = updateMemory(paths, options['end-date'] || localDateString());
        emitResult(result, jsonOutput(result));
        return;
      }
      case 'memory-context': {
        initialiseWorkspace(paths, repoRoot());
        const maxChars = options['max-chars'] ? Number(options['max-chars']) : 12000;
        const maxPages = options['max-pages'] ? Number(options['max-pages']) : 5;
        if (!Number.isInteger(maxChars) || maxChars < 500) throw new Error('memory-context --max-chars must be an integer of at least 500');
        if (!Number.isInteger(maxPages) || maxPages < 1) throw new Error('memory-context --max-pages must be a positive integer');
        const text = memoryContext(paths, options.query || '', { maxChars, maxPages });
        emitResult({ text, characters: [...text].length }, text);
        return;
      }
      case 'memory-lint': {
        initialiseWorkspace(paths, repoRoot());
        const staleDays = options['stale-days'] ? Number(options['stale-days']) : 90;
        if (!Number.isInteger(staleDays) || staleDays < 1) throw new Error('memory-lint --stale-days must be a positive integer');
        const result = lintMemory(paths, { nowDate: options.date, staleDays });
        emitResult(result, jsonOutput(result), {
          ok: result.ok,
          exitCode: result.ok ? 0 : 1,
          error: result.ok ? undefined : { code: 'HEALTH_OS_VALIDATION_FAILED', message: 'memory-lint reported findings' }
        });
        return;
      }
      default:
        throw new Error(`Command dispatch is missing for ${command}`);
    }
  } finally {
    releaseOutput?.();
    releaseWorkspace?.();
  }
}

main().catch(emitError);
