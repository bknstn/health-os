import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { atomicWriteFileSync } from './coordination.js';

export const CLI_JSON_SCHEMA_VERSION = 1;
export const MAX_JSON_OUTPUT_BYTES = 256 * 1024;
const MAX_JSON_TEXT_CHARS = 12_000;
const MAX_JSON_ARRAY_ITEMS = 100;
const MAX_JSON_OBJECT_KEYS = 100;
const MAX_JSON_NODES = 5_000;

export const CLI_COMMANDS = [
  'init-workspace', 'workspace-inspect', 'workspace-migrate', 'profile-show', 'profile-validate',
  'log-workout', 'set-working-weight', 'next', 'ingest-daily-state', 'validate-daily-state',
  'personal-raw-dir', 'personal-files-dir', 'import-personal-file', 'connectors',
  'ingest-wearable-observations', 'validate-wearable-observations', 'wearable-observations',
  'sync-daily-source', 'normalize-oura-json', 'oura-auth-url', 'oura-exchange-code',
  'oura-refresh-token', 'oura-fetch-day', 'oura-sync-from-token', 'oura-listen-callback',
  'context-add', 'context-query', 'context-correct', 'context-delete', 'timeline', 'context-revalidate-memory',
  'today', 'why', 'weekly-summary', 'memory-update', 'memory-context', 'memory-lint', 'prepare-training',
  'version', 'capabilities'
];

const PACKAGE = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

export function versionInfo() {
  return { name: PACKAGE.name, version: PACKAGE.version };
}

export function capabilitiesInfo() {
  return {
    ...versionInfo(),
    cli_json_schema_version: CLI_JSON_SCHEMA_VERSION,
    workspace_schema_versions: [1],
    health_event_schema_versions: [1],
    event_store_schema_versions: [1],
    wearable_observation_schema_versions: [1],
    wearable_observation_store_schema_versions: [1],
    idempotency_schema_version: 1,
    commands: [...CLI_COMMANDS],
    features: {
      json_envelopes: true,
      json_stdin: true,
      workspace_write_lock: true,
      workspace_read_lock: true,
      atomic_file_replacement: true,
      idempotency_keys: true,
      sqlite_event_store: true,
      wearable_observation_store: true
    },
    contracts: {
      json_envelope_commands: [...CLI_COMMANDS],
      json_stdin_commands: [
        'log-workout', 'ingest-daily-state', 'validate-daily-state',
        'ingest-wearable-observations', 'validate-wearable-observations', 'context-add', 'context-correct'
      ],
      event_idempotency_commands: ['context-add', 'context-correct', 'context-delete'],
      event_store_idempotency_commands: ['context-add', 'context-correct', 'context-delete'],
      event_capture_identity: 'selected manifest profile_path + source.kind + source.ref + source.fragment_id',
      event_revision_guard: 'context-correct, context-delete, and supersession require the expected current revision',
      context_query: 'newest known times first; an exact --event-id lookup includes inactive rows and tombstones',
      timeline: 'oldest matching events first; inclusive UTC date filters; unknown-time events are excluded when a date filter is present',
      training_preparation: 'prepare-training accepts --as-of YYYY-MM-DD or RFC3339, optional --session PLAN_KEY and comma-separated approved --substitute FROM=TO pairs; it reads a current workspace snapshot without seeding or domain-data writes, though SQLite may create auxiliary WAL/SHM files',
      idempotency_commands: [
        'log-workout', 'set-working-weight', 'next', 'ingest-daily-state', 'import-personal-file',
        'sync-daily-source', 'ingest-wearable-observations', 'oura-sync-from-token', 'today', 'why', 'weekly-summary',
        'memory-update', 'memory-context', 'memory-lint', 'context-add', 'context-correct', 'context-delete'
      ],
      workspace_lock_commands: [
        'init-workspace', 'workspace-migrate', 'log-workout', 'set-working-weight',
        'next', 'ingest-daily-state', 'ingest-wearable-observations', 'import-personal-file', 'sync-daily-source',
        'oura-sync-from-token', 'today', 'why', 'weekly-summary', 'memory-update',
        'memory-context', 'memory-lint', 'context-add', 'context-correct', 'context-delete', 'context-revalidate-memory'
      ],
      token_lock_commands: ['oura-fetch-day', 'oura-exchange-code', 'oura-refresh-token', 'oura-listen-callback', 'sync-daily-source', 'oura-sync-from-token'],
      external_atomic_write_commands: ['oura-fetch-day', 'sync-daily-source', 'oura-sync-from-token'],
      workspace_write_commands: [
        'init-workspace', 'workspace-migrate', 'log-workout', 'set-working-weight',
        'next', 'ingest-daily-state', 'ingest-wearable-observations', 'import-personal-file', 'sync-daily-source',
        'oura-sync-from-token', 'today', 'why', 'weekly-summary', 'memory-update',
        'memory-context', 'memory-lint', 'context-add', 'context-correct', 'context-delete', 'context-revalidate-memory'
      ],
      conditional_writes: {
        'workspace-migrate': 'writes unless --dry-run true',
        'oura-fetch-day': 'writes files only when --output-dir is set',
        'oura-exchange-code': 'writes the token file only when configured',
        'oura-refresh-token': 'writes the token file only when configured',
        'oura-listen-callback': 'writes the configured token file after successful callback',
        'sync-daily-source': 'stores normalized wearable observations and may refresh and write the configured Oura token file',
        'oura-sync-from-token': 'may refresh and write the configured Oura token file',
        'sync-daily-source --output-dir': 'writes a raw provider bundle outside the workspace',
        'oura-sync-from-token --output-dir': 'writes a raw provider bundle outside the workspace'
      },
      read_only_event_commands: ['context-query', 'timeline'],
      read_only_preparation_commands: ['prepare-training'],
      workspace_read_lock_commands: ['prepare-training'],
      read_only_observation_commands: ['validate-wearable-observations', 'wearable-observations'],
      wearable_observation_commands: {
        validation: 'validate-wearable-observations accepts a HealthObservationSet v1 object and does not initialize a workspace',
        ingestion: 'ingest-wearable-observations atomically replaces the same source/date record and is workspace-locked and idempotent',
        query: 'wearable-observations returns at most 50 stored source/date sets; use --source and/or --date to filter'
      },
      external_or_event_writes: {
        'context-add': 'creates one SQLite event and a derived-memory review marker',
        'context-correct': 'revises one SQLite event and invalidates derived memory',
        'context-delete': 'tombstones one SQLite event and invalidates derived memory',
        'context-revalidate-memory': 'writes the explicit derived-memory review generation'
      },
      token_export: 'oura-exchange-code and oura-refresh-token return token metadata by default; --export-token true is required to print token contents',
      json_io: {
        flag: '--json',
        stdout: 'one schema-versioned JSON envelope per command; errors also use stdout',
        stderr: 'empty for ordinary CLI errors in JSON mode; human-mode errors use stderr; first SQLite event-store import may emit Node ExperimentalWarning on stderr',
        human_default: true,
        stdin_flag: '--input-json',
        stdin_payloads: 'bare validated payload objects, not command-option wrappers',
        exit_status: '0 for success/replay, 1 for command failure; JSON mode preserves this status'
      },
      input_shapes: {
        'log-workout': 'text /log DSL, or JSON {session:{day,actual_mode,duration_minutes,session_rpe,energy_pre,soreness_pre,notes?},exercises:[{exercise_key,sets:[{weight:number|"bw",reps:integer}]}]}',
        'ingest-daily-state': 'normalized recovery payload accepted by validate-daily-state',
        'validate-daily-state': 'normalized recovery payload accepted by validate-daily-state',
        'ingest-wearable-observations': 'HealthObservationSet v1 with separate physical_metrics and proprietary_scores arrays',
        'validate-wearable-observations': 'HealthObservationSet v1 with separate physical_metrics and proprietary_scores arrays',
        'context-add': 'HealthEvent v1 object: event_type, occurred, data, source, extraction_version, epistemic_status, uncertainty; schema_version must be 1',
        'context-correct': 'replacement HealthEvent v1 object; source identity and --event-id must match the active event'
      },
      documentation: 'docs/agent-integration-runbook.md'
    },
    limits: {
      json_output_bytes: MAX_JSON_OUTPUT_BYTES,
      text_chars: MAX_JSON_TEXT_CHARS,
      array_items: MAX_JSON_ARRAY_ITEMS,
      object_keys: MAX_JSON_OBJECT_KEYS,
      event_input_bytes: 64 * 1024,
      wearable_observation_input_bytes: 256 * 1024,
      event_data_bytes: 16 * 1024,
      timeline_rows: 50
    }
  };
}

export function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function digestBytes(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function boundedJsonValue(input, maxBytes = MAX_JSON_OUTPUT_BYTES, maxTextChars = MAX_JSON_TEXT_CHARS) {
  let remaining = maxBytes - 2048;
  let nodes = 0;
  const truncatedPaths = [];
  let truncated = false;

  const mark = (location) => {
    truncated = true;
    if (truncatedPaths.length < 32) {
      const pathText = location || '$';
      truncatedPaths.push([...pathText].slice(0, 240).join(''));
    }
  };

  const visit = (value, location, depth = 0) => {
    nodes += 1;
    if (nodes > MAX_JSON_NODES || depth > 12) {
      mark(location);
      return '[truncated]';
    }
    if (value === null || typeof value === 'boolean') {
      remaining -= 8;
      return value;
    }
    if (typeof value === 'number') {
      remaining -= 24;
      return Number.isFinite(value) ? value : null;
    }
    if (typeof value === 'string') {
      const maxCodePoints = Math.max(0, Math.floor(Number(maxTextChars) || 0));
      const allowedJsonBytes = Math.max(2, remaining - 64);
      let kept = '';
      let codePoints = 0;
      let jsonBytes = 2;
      let wasTruncated = false;
      for (const character of value) {
        const characterBytes = Buffer.byteLength(JSON.stringify(character)) - 2;
        if (codePoints >= maxCodePoints || jsonBytes + characterBytes > allowedJsonBytes) {
          wasTruncated = true;
          break;
        }
        kept += character;
        codePoints += 1;
        jsonBytes += characterBytes;
      }
      if (wasTruncated) {
        mark(location);
        kept += '…';
      }
      remaining -= Buffer.byteLength(JSON.stringify(kept));
      return kept;
    }
    if (Array.isArray(value)) {
      const output = [];
      const count = Math.min(value.length, MAX_JSON_ARRAY_ITEMS);
      if (count < value.length) mark(location);
      for (let index = 0; index < count; index += 1) {
        if (remaining <= 128) {
          mark(location);
          break;
        }
        output.push(visit(value[index], `${location}[${index}]`, depth + 1));
      }
      remaining -= output.length * 2 + 2;
      return output;
    }
    if (typeof value === 'object') {
      const output = {};
      const keys = Object.keys(value);
      const count = Math.min(keys.length, MAX_JSON_OBJECT_KEYS);
      if (count < keys.length) mark(location);
      for (const key of keys.slice(0, count)) {
        const safeKey = [...key].slice(0, 200).join('');
        if (safeKey.length !== key.length) mark(location);
        const keyBytes = Buffer.byteLength(JSON.stringify(safeKey));
        if (remaining <= keyBytes + 128) {
          mark(location);
          break;
        }
        remaining -= keyBytes + 1;
        Object.defineProperty(output, safeKey, {
          value: visit(value[key], location ? `${location}.${safeKey}` : safeKey, depth + 1),
          enumerable: true,
          writable: true,
          configurable: true
        });
      }
      remaining -= 2;
      return output;
    }
    return null;
  };

  return {
    value: visit(input, '$'),
    ...(truncated ? { truncation: { truncated: true, paths: truncatedPaths, max_bytes: maxBytes } } : {})
  };
}

export function makeSuccessEnvelope(command, data, options = {}) {
  const error = options.error ? {
    code: String(options.error.code || 'HEALTH_OS_ERROR').slice(0, 100),
    message: [...String(options.error.message || 'Health OS command failed')].slice(0, 1_000).join('')
  } : undefined;
  let payloadBudget = MAX_JSON_OUTPUT_BYTES;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const bounded = boundedJsonValue(data, payloadBudget, options.maxTextChars ?? MAX_JSON_TEXT_CHARS);
    const envelope = {
      schema_version: CLI_JSON_SCHEMA_VERSION,
      command,
      ok: options.ok ?? true,
      data: bounded.value,
      ...(error ? { error } : {}),
      ...(options.idempotency ? { idempotency: options.idempotency } : {}),
      ...(bounded.truncation ? { truncation: bounded.truncation } : {})
    };
    const actualBytes = Buffer.byteLength(JSON.stringify(envelope));
    if (actualBytes + 1 <= MAX_JSON_OUTPUT_BYTES) return envelope;
    payloadBudget = Math.max(2_500, payloadBudget - Math.max(4_096, actualBytes + 1 - MAX_JSON_OUTPUT_BYTES + 2_048));
  }

  return {
    schema_version: CLI_JSON_SCHEMA_VERSION,
    command,
    ok: options.ok ?? true,
    data: { truncated: true },
    truncation: { truncated: true, paths: ['$'], max_bytes: MAX_JSON_OUTPUT_BYTES }
  };
}

export function makeErrorEnvelope(command, error, idempotency) {
  const messageChars = [...(error?.message || 'Health OS command failed')];
  const message = messageChars.length > 1_000 ? `${messageChars.slice(0, 1_000).join('')}…` : messageChars.join('');
  return {
    schema_version: CLI_JSON_SCHEMA_VERSION,
    command,
    ok: false,
    error: {
      code: error?.code || 'HEALTH_OS_ERROR',
      message
    },
    ...(idempotency ? { idempotency } : {})
  };
}

function idempotencyPath(paths, key) {
  const keyHash = digestBytes(key).slice(0, 32);
  return path.join(paths.trackerRoot, 'operations', `${keyHash}.json`);
}

function idempotencyError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export function beginIdempotentRequest(paths, key, request) {
  if (typeof key !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(key)) {
    throw idempotencyError('HEALTH_OS_IDEMPOTENCY_KEY_INVALID', 'idempotency key must be 1-128 letters, digits, dot, underscore, colon, or hyphen');
  }
  const filePath = idempotencyPath(paths, key);
  const digest = digestBytes(stableJson(request));
  if (fs.existsSync(filePath)) {
    let record;
    try {
      record = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
      throw idempotencyError('HEALTH_OS_IDEMPOTENCY_RECORD_INVALID', 'idempotency record is unreadable; inspect it before retrying');
    }
    if (record.digest !== digest) {
      throw idempotencyError('HEALTH_OS_IDEMPOTENCY_CONFLICT', 'idempotency key was already used for a different request');
    }
    if (record.state === 'complete') return { status: 'replayed', record };
    if (record.state === 'pending') {
      throw idempotencyError('HEALTH_OS_IDEMPOTENCY_IN_PROGRESS', 'request with this idempotency key may have partially completed; inspect workspace state and use a new key only after reconciliation');
    }
    throw idempotencyError('HEALTH_OS_IDEMPOTENCY_RECORD_INVALID', 'idempotency record has an unsupported state');
  }

  atomicWriteFileSync(filePath, `${JSON.stringify({
    schema_version: 1,
    state: 'pending',
    command: request.command,
    digest,
    started_at: new Date().toISOString()
  }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, exclusive: true });

  return {
    status: 'new',
    complete(result) {
      atomicWriteFileSync(filePath, `${JSON.stringify({
        schema_version: 1,
        state: 'complete',
        command: request.command,
        digest,
        completed_at: new Date().toISOString(),
        exit_code: result.exitCode,
        ok: result.ok,
        data: result.data,
        ...(result.error ? { error: result.error } : {}),
        human_output: result.humanOutput
      }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    }
  };
}
