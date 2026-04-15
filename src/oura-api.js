import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const OURA_AUTHORIZE_URL = 'https://cloud.ouraring.com/oauth/authorize';
export const OURA_TOKEN_URL = 'https://api.ouraring.com/oauth/token';
export const OURA_API_BASE_URL = 'https://api.ouraring.com';

const DEFAULT_PATHS = {
  readiness: '/v2/usercollection/daily_readiness',
  sleep: '/v2/usercollection/daily_sleep',
  heartrate: '/v2/usercollection/heartrate'
};

function assertValue(value, label) {
  if (!value) {
    throw new Error(`${label} is required`);
  }
}

function buildBasicAuthorization(clientId, clientSecret) {
  return `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`;
}

function toDateTimeRange(date) {
  return {
    start: `${date}T00:00:00+00:00`,
    end: `${date}T23:59:59+00:00`
  };
}

function collectionUrl(apiBaseUrl, collectionPath, date) {
  const normalizedPath = collectionPath.startsWith('/') ? collectionPath : `/${collectionPath}`;
  const url = new URL(normalizedPath, apiBaseUrl);
  if (normalizedPath.includes('heartrate')) {
    const range = toDateTimeRange(date);
    url.searchParams.set('start_datetime', range.start);
    url.searchParams.set('end_datetime', range.end);
  } else {
    url.searchParams.set('start_date', date);
    url.searchParams.set('end_date', date);
  }
  return url;
}

async function parseJsonResponse(response) {
  const text = await response.text();
  if (!text) {
    return {};
  }
  try {
    return JSON.parse(text);
  } catch {
    return { detail: text };
  }
}

async function requestJson(url, init, fetchImpl = fetch) {
  const response = await fetchImpl(url, init);
  const payload = await parseJsonResponse(response);
  if (!response.ok) {
    const detail = payload.detail || payload.error_description || payload.error || response.statusText;
    throw new Error(`Oura API ${response.status} ${detail}`);
  }
  return payload;
}

function stampTokenPayload(tokenPayload) {
  return {
    ...tokenPayload,
    created_at: new Date().toISOString()
  };
}

export function buildOuraAuthorizeUrl({
  clientId,
  redirectUri,
  scopes = ['daily', 'heartrate'],
  state,
  responseType = 'code',
  authorizeUrl = OURA_AUTHORIZE_URL
}) {
  assertValue(clientId, 'client_id');

  const url = new URL(authorizeUrl);
  url.searchParams.set('response_type', responseType);
  url.searchParams.set('client_id', clientId);
  if (redirectUri) {
    url.searchParams.set('redirect_uri', redirectUri);
  }
  if (scopes.length > 0) {
    url.searchParams.set('scope', scopes.join(' '));
  }
  if (state) {
    url.searchParams.set('state', state);
  }
  return url.toString();
}

export async function exchangeOuraCode({
  code,
  clientId,
  clientSecret,
  redirectUri,
  tokenUrl = OURA_TOKEN_URL,
  fetchImpl = fetch
}) {
  assertValue(code, 'code');
  assertValue(clientId, 'client_id');
  assertValue(clientSecret, 'client_secret');

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code
  });
  if (redirectUri) {
    body.set('redirect_uri', redirectUri);
  }

  const payload = await requestJson(
    tokenUrl,
    {
      method: 'POST',
      headers: {
        Authorization: buildBasicAuthorization(clientId, clientSecret),
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: body.toString()
    },
    fetchImpl
  );

  return stampTokenPayload(payload);
}

export async function refreshOuraAccessToken({
  refreshToken,
  clientId,
  clientSecret,
  tokenUrl = OURA_TOKEN_URL,
  fetchImpl = fetch
}) {
  assertValue(refreshToken, 'refresh_token');
  assertValue(clientId, 'client_id');
  assertValue(clientSecret, 'client_secret');

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken
  });

  const payload = await requestJson(
    tokenUrl,
    {
      method: 'POST',
      headers: {
        Authorization: buildBasicAuthorization(clientId, clientSecret),
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: body.toString()
    },
    fetchImpl
  );

  return stampTokenPayload(payload);
}

export async function fetchOuraCollection({
  accessToken,
  date,
  collectionPath,
  apiBaseUrl = OURA_API_BASE_URL,
  fetchImpl = fetch
}) {
  assertValue(accessToken, 'access_token');
  assertValue(date, 'date');
  assertValue(collectionPath, 'collection_path');

  const url = collectionUrl(apiBaseUrl, collectionPath, date);
  return requestJson(
    url,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`
      }
    },
    fetchImpl
  );
}

export async function fetchOuraDay({
  accessToken,
  date,
  apiBaseUrl = OURA_API_BASE_URL,
  readinessPath = DEFAULT_PATHS.readiness,
  sleepPath = DEFAULT_PATHS.sleep,
  heartratePath = DEFAULT_PATHS.heartrate,
  optionalHeartrate = true,
  fetchImpl = fetch
}) {
  assertValue(date, 'date');

  const [readiness, sleep] = await Promise.all([
    fetchOuraCollection({ accessToken, date, collectionPath: readinessPath, apiBaseUrl, fetchImpl }),
    fetchOuraCollection({ accessToken, date, collectionPath: sleepPath, apiBaseUrl, fetchImpl })
  ]);

  let heartrate = { data: [] };
  try {
    heartrate = await fetchOuraCollection({
      accessToken,
      date,
      collectionPath: heartratePath,
      apiBaseUrl,
      fetchImpl
    });
  } catch (error) {
    if (!optionalHeartrate) {
      throw error;
    }
  }

  return { date, readiness, sleep, heartrate };
}

export function readOuraTokenFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

export function writeOuraTokenFile(filePath, tokenPayload) {
  ensureDirectory(path.dirname(filePath));
  const tempPath = path.join(
    path.dirname(filePath),
    `.tmp-${path.basename(filePath)}-${process.pid}-${Date.now()}`
  );
  fs.writeFileSync(tempPath, `${JSON.stringify(tokenPayload, null, 2)}\n`, 'utf8');
  fs.renameSync(tempPath, filePath);
}

export function ensureDirectory(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

export function writeOuraDayBundle(outputDir, bundle) {
  ensureDirectory(outputDir);
  fs.writeFileSync(path.join(outputDir, 'readiness.json'), `${JSON.stringify(bundle.readiness, null, 2)}\n`, 'utf8');
  fs.writeFileSync(path.join(outputDir, 'sleep.json'), `${JSON.stringify(bundle.sleep, null, 2)}\n`, 'utf8');
  fs.writeFileSync(path.join(outputDir, 'heartrate.json'), `${JSON.stringify(bundle.heartrate, null, 2)}\n`, 'utf8');
}

export function temporaryOuraOutputDir(prefix = 'health-os-oura-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}
