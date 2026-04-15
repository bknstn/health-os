import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import { callbackPathFromRedirectUri, handleOuraCallback } from '../src/oura-callback-server.js';

test('callbackPathFromRedirectUri extracts the path and falls back safely', () => {
  assert.equal(callbackPathFromRedirectUri('https://example.com/oura/callback'), '/oura/callback');
  assert.equal(callbackPathFromRedirectUri('not-a-url'), '/oura/callback');
});

test('handleOuraCallback exchanges the code and writes the token file', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'health-os-callback-'));
  const tokenFile = path.join(tempDir, 'oura-token.json');
  const handled = await handleOuraCallback({
    code: 'code-1',
    state: 'abc123',
    expectedState: 'abc123',
    clientId: 'client-id',
    clientSecret: 'client-secret',
    redirectUri: 'https://example.com/oura/callback',
    tokenFile,
    exchangeCode: async ({ code }) => ({
      access_token: `access-for-${code}`,
      refresh_token: 'refresh-1',
      expires_in: 3600
    }),
    logger: { log() {}, error() {} }
  });
  assert.equal(handled.statusCode, 200);
  assert.match(handled.body, /Oura Connected/);
  assert.equal(handled.result.tokenFile, tokenFile);

  const stored = JSON.parse(fs.readFileSync(tokenFile, 'utf8'));
  assert.equal(stored.access_token, 'access-for-code-1');
  assert.equal(stored.refresh_token, 'refresh-1');
});
