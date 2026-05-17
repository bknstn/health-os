import {
  fetchOuraDay,
  readOuraTokenFile,
  refreshOuraAccessToken,
  temporaryOuraOutputDir,
  writeOuraDayBundle,
  writeOuraTokenFile
} from './oura-api.js';
import { normalizeOuraPayload } from './oura-adapter.js';

function pickTokenPath(options, env) {
  return options['token-file'] || env.OURA_TOKEN_FILE || '';
}

function strictHeartrate(options, env) {
  return options['strict-heartrate'] === 'true' || env.OURA_STRICT_HEARTRATE === 'true';
}

function providerPath(options, env, optionName, envName) {
  return options[optionName] || env[envName] || undefined;
}

export const ouraConnector = {
  id: 'oura',
  label: 'Oura Ring',
  capabilities: ['oauth2', 'daily-recovery', 'raw-bundle'],
  requiredMetrics: ['readiness_score', 'sleep_score', 'hrv', 'resting_hr'],

  async resolveAuth({ options, env }) {
    const tokenPath = pickTokenPath(options, env);
    const fileToken = tokenPath ? readOuraTokenFile(tokenPath) : null;
    let tokenPayload = fileToken;

    if (!tokenPayload?.access_token && !options['access-token']) {
      throw new Error('oura connector requires --token-file or --access-token');
    }

    if (tokenPayload?.refresh_token) {
      tokenPayload = await refreshOuraAccessToken({
        refreshToken: tokenPayload.refresh_token,
        clientId: options['client-id'] || env.OURA_CLIENT_ID,
        clientSecret: options['client-secret'] || env.OURA_CLIENT_SECRET
      });
      if (tokenPath) {
        writeOuraTokenFile(tokenPath, tokenPayload);
      }
    }

    return {
      accessToken: options['access-token'] || tokenPayload?.access_token,
      tokenRefreshed: Boolean(fileToken?.refresh_token)
    };
  },

  async fetchDaily({ date, options, env, auth }) {
    return fetchOuraDay({
      accessToken: auth.accessToken,
      date,
      apiBaseUrl: options['api-base-url'] || env.OURA_API_BASE_URL,
      readinessPath: providerPath(options, env, 'readiness-path', 'OURA_READINESS_PATH'),
      sleepPath: providerPath(options, env, 'sleep-path', 'OURA_SLEEP_PATH'),
      heartratePath: providerPath(options, env, 'heartrate-path', 'OURA_HEARTRATE_PATH'),
      optionalHeartrate: !strictHeartrate(options, env),
      fetchImpl: options.fetchImpl
    });
  },

  normalizeDaily({ date, rawBundle, baselines }) {
    return normalizeOuraPayload({
      date,
      readinessJson: rawBundle.readiness,
      sleepJson: rawBundle.sleep,
      heartrateJson: rawBundle.heartrate,
      baselines
    });
  },

  writeRawBundle({ outputDir, rawBundle }) {
    writeOuraDayBundle(outputDir, rawBundle);
  },

  resolveOutputDir({ options }) {
    if (options['output-dir'] === 'temp') {
      return temporaryOuraOutputDir();
    }
    return options['output-dir'];
  }
};
