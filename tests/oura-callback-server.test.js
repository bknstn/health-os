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

test('handleOuraCallback escapes reflected OAuth errors', async () => {
  const handled = await handleOuraCallback({
    error: '<script>alert(1)</script>',
    logger: { log() {}, error() {} }
  });

  assert.equal(handled.statusCode, 400);
  assert.match(handled.body, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(handled.body, /<script>alert\(1\)<\/script>/);
});

test('callback exchange failures never log or reflect provider details', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'health-os-callback-safe-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const tokenFile = path.join(tempDir, 'token.json');
  const secret = 'synthetic-refresh-secret';
  const messages = [];
  await assert.rejects(handleOuraCallback({
    code: 'synthetic-code',
    tokenFile,
    exchangeCode: async () => { throw new Error(`provider echoed ${secret}`); },
    logger: { log() {}, error(message) { messages.push(message); } }
  }), (error) => {
    assert.equal(error.message, 'Oura callback token exchange failed');
    assert.doesNotMatch(error.message, /synthetic-refresh-secret/);
    return true;
  });
  assert.equal(messages.length, 1);
  assert.doesNotMatch(messages.join('\n'), /synthetic-refresh-secret/);
  assert.equal(fs.existsSync(tokenFile), false);
});
