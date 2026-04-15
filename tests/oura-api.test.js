import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildOuraAuthorizeUrl,
  exchangeOuraCode,
  fetchOuraDay,
  refreshOuraAccessToken
} from '../src/oura-api.js';

function okJson(payload) {
  return {
    ok: true,
    status: 200,
    async text() {
      return JSON.stringify(payload);
    }
  };
}

test('buildOuraAuthorizeUrl encodes redirect, scopes, and state', () => {
  const url = new URL(
    buildOuraAuthorizeUrl({
      clientId: 'client-123',
      redirectUri: 'http://localhost:8787/callback',
      scopes: ['daily', 'heartrate'],
      state: 'state-abc'
    })
  );

  assert.equal(url.origin, 'https://cloud.ouraring.com');
  assert.equal(url.pathname, '/oauth/authorize');
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('client_id'), 'client-123');
  assert.equal(url.searchParams.get('redirect_uri'), 'http://localhost:8787/callback');
  assert.equal(url.searchParams.get('scope'), 'daily heartrate');
  assert.equal(url.searchParams.get('state'), 'state-abc');
});

test('exchangeOuraCode posts form-encoded body with basic auth', async () => {
  const calls = [];
  const token = await exchangeOuraCode({
    code: 'code-123',
    clientId: 'client-123',
    clientSecret: 'secret-456',
    redirectUri: 'http://localhost:8787/callback',
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return okJson({
        access_token: 'access-1',
        refresh_token: 'refresh-1',
        token_type: 'bearer',
        expires_in: 3600
      });
    }
  });

  assert.equal(token.access_token, 'access-1');
  assert.equal(typeof token.created_at, 'string');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.ouraring.com/oauth/token');
  assert.equal(calls[0].init.method, 'POST');
  assert.match(calls[0].init.headers.Authorization, /^Basic /);
  assert.equal(calls[0].init.headers['Content-Type'], 'application/x-www-form-urlencoded');
  assert.match(calls[0].init.body, /grant_type=authorization_code/);
  assert.match(calls[0].init.body, /code=code-123/);
  assert.match(calls[0].init.body, /redirect_uri=http%3A%2F%2Flocalhost%3A8787%2Fcallback/);
});

test('refreshOuraAccessToken posts refresh_token grant', async () => {
  const calls = [];
  const token = await refreshOuraAccessToken({
    refreshToken: 'refresh-1',
    clientId: 'client-123',
    clientSecret: 'secret-456',
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return okJson({
        access_token: 'access-2',
        refresh_token: 'refresh-2',
        token_type: 'bearer',
        expires_in: 3600
      });
    }
  });

  assert.equal(token.refresh_token, 'refresh-2');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.ouraring.com/oauth/token');
  assert.match(calls[0].init.body, /grant_type=refresh_token/);
  assert.match(calls[0].init.body, /refresh_token=refresh-1/);
});

test('fetchOuraDay requests readiness, sleep, and heartrate collections for one date', async () => {
  const calls = [];
  const bundle = await fetchOuraDay({
    accessToken: 'access-1',
    date: '2026-04-13',
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init });
      return okJson({ data: [{ source: String(url) }] });
    }
  });

  assert.equal(calls.length, 3);
  assert.equal(bundle.date, '2026-04-13');
  assert.equal(bundle.readiness.data.length, 1);
  assert.ok(calls.some((call) => call.url.includes('/v2/usercollection/daily_readiness')));
  assert.ok(calls.some((call) => call.url.includes('/v2/usercollection/daily_sleep')));
  assert.ok(calls.some((call) => call.url.includes('/v2/usercollection/heartrate')));
  assert.ok(calls.some((call) => call.url.includes('start_date=2026-04-13')));
  assert.ok(calls.some((call) => call.url.includes('start_datetime=2026-04-13T00%3A00%3A00%2B00%3A00')));
  for (const call of calls) {
    assert.equal(call.init.headers.Authorization, 'Bearer access-1');
  }
});

test('fetchOuraDay tolerates heartrate failures by default', async () => {
  const bundle = await fetchOuraDay({
    accessToken: 'access-1',
    date: '2026-04-13',
    fetchImpl: async (url) => {
      const text = String(url);
      if (text.includes('/v2/usercollection/heartrate')) {
        return {
          ok: false,
          status: 403,
          statusText: 'Forbidden',
          async text() {
            return JSON.stringify({ detail: 'Missing scopes' });
          }
        };
      }
      return okJson({ data: [{ source: text }] });
    }
  });

  assert.deepEqual(bundle.heartrate, { data: [] });
});
