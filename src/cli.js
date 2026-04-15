import fs from 'node:fs';

import { computeWorkspaceBaselines } from './baselines.js';
import { buildPaths, ensureWorkspace, repoRoot } from './layout.js';
import { parseWorkoutLog } from './log-parser.js';
import {
  buildOuraAuthorizeUrl,
  exchangeOuraCode,
  fetchOuraDay,
  readOuraTokenFile,
  refreshOuraAccessToken,
  temporaryOuraOutputDir,
  writeOuraDayBundle,
  writeOuraTokenFile
} from './oura-api.js';
import { callbackPathFromRedirectUri, startOuraCallbackServer } from './oura-callback-server.js';
import { validateRecoveryPayload } from './recovery-contract.js';
import { normalizeOuraPayload, normalizeOuraPayloadFromFiles } from './oura-adapter.js';
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

function readInput(optionValue) {
  if (!optionValue || optionValue === '-') {
    return fs.readFileSync(0, 'utf8');
  }
  return fs.readFileSync(optionValue, 'utf8');
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

function pickTokenPath(options) {
  return options['token-file'] || process.env.OURA_TOKEN_FILE || '';
}

function resolveAccessToken(options) {
  if (options['access-token']) {
    return options['access-token'];
  }
  const tokenPath = pickTokenPath(options);
  if (!tokenPath) {
    return '';
  }
  const tokenPayload = readOuraTokenFile(tokenPath);
  return tokenPayload.access_token || '';
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

async function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
  const paths = buildPaths(options.workspace);
  ensureWorkspace(paths);

  switch (command) {
    case 'init-workspace':
      initialiseWorkspace(paths, repoRoot());
      process.stdout.write(`Initialized workspace at ${paths.trackerRoot}\n`);
      return;
    case 'log-workout': {
      initialiseWorkspace(paths, repoRoot());
      const parsed = parseWorkoutLog(readInput(options.input));
      const sessionId = appendWorkoutLog(paths, parsed, options.date || localDateString());
      process.stdout.write(`Logged workout ${sessionId}\n`);
      return;
    }
    case 'set-working-weight': {
      initialiseWorkspace(paths, repoRoot());
      if (!options.exercise || !options.weight) {
        throw new Error('set-working-weight requires --exercise and --weight');
      }
      const increment = options.increment ? Number(options.increment) : undefined;
      setWorkingWeight(paths, options.exercise, Number(options.weight), increment);
      process.stdout.write(`Updated ${options.exercise} working weight to ${options.weight} kg\n`);
      return;
    }
    case 'next':
      initialiseWorkspace(paths, repoRoot());
      process.stdout.write(printWorkout(buildNextWorkout(paths, options.date || localDateString())));
      return;
    case 'ingest-daily-state': {
      initialiseWorkspace(paths, repoRoot());
      const payload = validateRecoveryPayload(JSON.parse(readInput(options.input)));
      const decision = ingestDailyState(paths, payload);
      process.stdout.write(`mode=${decision.mode}\nscore=${decision.score}\n`);
      return;
    }
    case 'validate-daily-state': {
      const payload = validateRecoveryPayload(JSON.parse(readInput(options.input)));
      process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
      return;
    }
    case 'normalize-oura-json': {
      const date = options.date || localDateString();
      const baselines =
        options['baselines-file']
          ? undefined
          : computeWorkspaceBaselines(paths, date);
      const payload = normalizeOuraPayloadFromFiles({
        date,
        readinessFile: options['readiness-file'],
        sleepFile: options['sleep-file'],
        heartrateFile: options['heartrate-file'],
        baselinesFile: options['baselines-file'],
        baselines
      });
      process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
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
      process.stdout.write(`${url}\n`);
      return;
    }
    case 'oura-exchange-code': {
      const tokenPayload = await exchangeOuraCode({
        code: options.code || process.env.OURA_CODE,
        clientId: options['client-id'] || process.env.OURA_CLIENT_ID,
        clientSecret: options['client-secret'] || process.env.OURA_CLIENT_SECRET,
        redirectUri: options['redirect-uri'] || process.env.OURA_REDIRECT_URI
      });
      const tokenPath = pickTokenPath(options);
      if (tokenPath) {
        writeOuraTokenFile(tokenPath, tokenPayload);
      }
      process.stdout.write(jsonOutput(tokenPayload));
      return;
    }
    case 'oura-refresh-token': {
      const tokenPath = pickTokenPath(options);
      const fileToken = tokenPath ? readOuraTokenFile(tokenPath) : null;
      const tokenPayload = await refreshOuraAccessToken({
        refreshToken: options['refresh-token'] || process.env.OURA_REFRESH_TOKEN || fileToken?.refresh_token,
        clientId: options['client-id'] || process.env.OURA_CLIENT_ID,
        clientSecret: options['client-secret'] || process.env.OURA_CLIENT_SECRET
      });
      if (tokenPath) {
        writeOuraTokenFile(tokenPath, tokenPayload);
      }
      process.stdout.write(jsonOutput(tokenPayload));
      return;
    }
    case 'oura-fetch-day': {
      const bundle = await fetchOuraDay({
        accessToken: resolveAccessToken(options),
        date: options.date || localDateString(),
        apiBaseUrl: options['api-base-url'] || process.env.OURA_API_BASE_URL,
        readinessPath:
          options['readiness-path'] ||
          process.env.OURA_READINESS_PATH ||
          undefined,
        sleepPath:
          options['sleep-path'] ||
          process.env.OURA_SLEEP_PATH ||
          undefined,
        heartratePath:
          options['heartrate-path'] ||
          process.env.OURA_HEARTRATE_PATH ||
          undefined,
        optionalHeartrate:
          options['strict-heartrate'] === 'true' || process.env.OURA_STRICT_HEARTRATE === 'true'
            ? false
            : true
      });
      if (options['output-dir']) {
        writeOuraDayBundle(options['output-dir'], bundle);
      }
      process.stdout.write(jsonOutput(bundle));
      return;
    }
    case 'oura-sync-from-token': {
      initialiseWorkspace(paths, repoRoot());
      const tokenPath = pickTokenPath(options);
      const tokenFilePayload = tokenPath ? readOuraTokenFile(tokenPath) : null;
      let tokenPayload = tokenFilePayload;

      if (!tokenPayload?.access_token && !options['access-token']) {
        throw new Error('oura-sync-from-token requires --token-file or --access-token');
      }

      if (tokenPayload?.refresh_token) {
        tokenPayload = await refreshOuraAccessToken({
          refreshToken: tokenPayload.refresh_token,
          clientId: options['client-id'] || process.env.OURA_CLIENT_ID,
          clientSecret: options['client-secret'] || process.env.OURA_CLIENT_SECRET
        });
        if (tokenPath) {
          writeOuraTokenFile(tokenPath, tokenPayload);
        }
      }

      const bundle = await fetchOuraDay({
        accessToken: options['access-token'] || tokenPayload?.access_token,
        date: options.date || localDateString(),
        apiBaseUrl: options['api-base-url'] || process.env.OURA_API_BASE_URL,
        readinessPath:
          options['readiness-path'] ||
          process.env.OURA_READINESS_PATH ||
          undefined,
        sleepPath:
          options['sleep-path'] ||
          process.env.OURA_SLEEP_PATH ||
          undefined,
        heartratePath:
          options['heartrate-path'] ||
          process.env.OURA_HEARTRATE_PATH ||
          undefined,
        optionalHeartrate:
          options['strict-heartrate'] === 'true' || process.env.OURA_STRICT_HEARTRATE === 'true'
            ? false
            : true
      });

      const outputDir =
        options['output-dir'] === 'temp'
          ? temporaryOuraOutputDir()
          : options['output-dir'];
      if (outputDir) {
        writeOuraDayBundle(outputDir, bundle);
      }

      const baselines =
        options['baselines-file']
          ? undefined
          : computeWorkspaceBaselines(paths, bundle.date);
      const normalized = validateRecoveryPayload(
        normalizeOuraPayload({
          date: bundle.date,
          readinessJson: bundle.readiness,
          sleepJson: bundle.sleep,
          heartrateJson: bundle.heartrate,
          baselines:
            options['baselines-file']
              ? JSON.parse(fs.readFileSync(options['baselines-file'], 'utf8'))
              : baselines || {}
        })
      );
      const decision = ingestDailyState(paths, normalized);

      process.stdout.write(
        jsonOutput({
          date: bundle.date,
          mode: decision.mode,
          score: decision.score,
          token_refreshed: Boolean(tokenFilePayload?.refresh_token),
          output_dir: outputDir || ''
        })
      );
      return;
    }
    case 'oura-listen-callback': {
      const tokenPath = pickTokenPath(options);
      if (!tokenPath) {
        throw new Error('oura-listen-callback requires --token-file or OURA_TOKEN_FILE');
      }
      const redirectUri = options['redirect-uri'] || process.env.OURA_REDIRECT_URI;
      const callbackPath =
        options['callback-path'] ||
        process.env.OURA_CALLBACK_PATH ||
        callbackPathFromRedirectUri(redirectUri);
      const listener = startOuraCallbackServer({
        listenHost: options['listen-host'] || process.env.OURA_CALLBACK_HOST || '127.0.0.1',
        listenPort: Number(options['listen-port'] || process.env.OURA_CALLBACK_PORT || '8787'),
        callbackPath,
        expectedState: options.state || process.env.OURA_STATE || '',
        clientId: options['client-id'] || process.env.OURA_CLIENT_ID,
        clientSecret: options['client-secret'] || process.env.OURA_CLIENT_SECRET,
        redirectUri,
        tokenFile: tokenPath
      });
      await listener.started;
      const result = await listener.done;
      process.stdout.write(
        jsonOutput({
          token_file: result.tokenFile,
          callback_path: callbackPath,
          stored: true
        })
      );
      return;
    }
    case 'today':
      initialiseWorkspace(paths, repoRoot());
      process.stdout.write(renderToday(paths, options.date || localDateString()));
      return;
    case 'why':
      initialiseWorkspace(paths, repoRoot());
      process.stdout.write(renderWhy(paths));
      return;
    case 'weekly-summary':
      initialiseWorkspace(paths, repoRoot());
      process.stdout.write(renderWeeklySummary(paths, options['end-date'] || localDateString()));
      return;
    default:
      process.stderr.write(
        'Usage: node src/cli.js <init-workspace|log-workout|set-working-weight|next|ingest-daily-state|validate-daily-state|normalize-oura-json|oura-auth-url|oura-exchange-code|oura-refresh-token|oura-fetch-day|oura-sync-from-token|oura-listen-callback|today|why|weekly-summary> [--workspace PATH] [--input FILE|-]\n'
      );
      process.exitCode = 1;
  }
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
