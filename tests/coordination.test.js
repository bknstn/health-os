import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';

import {
  acquireWorkspaceLock,
  atomicWriteFileSync,
  tokenLockPath,
  withTokenFileLock,
  withWorkspaceLock,
  workspaceLockPath
} from '../src/coordination.js';
import { buildPaths, repoRoot } from '../src/layout.js';

const CLI = path.join(repoRoot(), 'src/cli.js');

function scratch(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'health-os-coordination-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function runCli(args, options = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: repoRoot(), encoding: 'utf8', ...options
  });
}

function runCliAsync(args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: repoRoot(), stdio: ['pipe', 'pipe', 'pipe'], ...options
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
    if (options.input !== undefined) child.stdin.end(options.input);
    else child.stdin.end();
  });
}

test('workspace writes serialize and release the shared lock', async (t) => {
  const root = scratch(t);
  const paths = buildPaths(path.join(root, 'workspace'));
  const order = [];
  let releaseFirst;
  const gate = new Promise((resolve) => { releaseFirst = resolve; });
  const first = withWorkspaceLock(paths, async () => {
    order.push('first-enter');
    await gate;
    order.push('first-leave');
  });
  while (!order.includes('first-enter')) await new Promise((resolve) => setTimeout(resolve, 5));
  const second = withWorkspaceLock(paths, async () => { order.push('second'); });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(order, ['first-enter']);
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(order, ['first-enter', 'first-leave', 'second']);
  assert.equal(fs.existsSync(workspaceLockPath(paths)), false);
});

test('lock acquisition waits for owner metadata during the mkdir/write race', async (t) => {
  const root = scratch(t);
  const paths = buildPaths(path.join(root, 'workspace'));
  const lockPath = workspaceLockPath(paths);
  fs.mkdirSync(lockPath, { recursive: true });
  const work = withWorkspaceLock(paths, async () => 'acquired', { waitMs: 500 });
  setTimeout(() => {
    fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({
      id: 'synthetic-owner', pid: process.pid, hostname: os.hostname()
    }));
    setTimeout(() => fs.rmSync(lockPath, { recursive: true, force: true }), 40);
  }, 35);
  assert.equal(await work, 'acquired');
  assert.equal(fs.existsSync(lockPath), false);
});

test('a crashed owner lock is reported for manual recovery and is never evicted by age', async (t) => {
  const root = scratch(t);
  const paths = buildPaths(path.join(root, 'workspace'));
  const lockPath = workspaceLockPath(paths);
  fs.mkdirSync(lockPath, { recursive: true });
  fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({
    id: 'synthetic-dead-owner', pid: 2_147_483_647, hostname: os.hostname(), started_at: '2000-01-01T00:00:00Z'
  }));
  await assert.rejects(withWorkspaceLock(paths, async () => 'should not acquire', { waitMs: 100 }), {
    code: 'HEALTH_OS_LOCKED'
  });
  assert.equal(fs.existsSync(lockPath), true);
  assert.match(fs.readFileSync(path.join(lockPath, 'owner.json'), 'utf8'), /synthetic-dead-owner/);
});

test('token lock keys resolve symlink aliases to the same token file', async (t) => {
  const root = scratch(t);
  const tokenFile = path.join(root, 'token.json');
  const alias = path.join(root, 'alias.json');
  fs.writeFileSync(tokenFile, '{}\n');
  fs.symlinkSync(tokenFile, alias);
  assert.equal(tokenLockPath(alias), tokenLockPath(tokenFile));
  const seen = await withTokenFileLock(alias, async (resolved) => resolved);
  assert.equal(seen, fs.realpathSync(tokenFile));
});

test('workspace lock keys resolve distinct .health-os symlinks to one physical workspace', (t) => {
  const root = scratch(t);
  const shared = path.join(root, 'shared-private');
  const firstGroup = path.join(root, 'first-group');
  const secondGroup = path.join(root, 'second-group');
  fs.mkdirSync(shared, { recursive: true });
  fs.mkdirSync(firstGroup);
  fs.mkdirSync(secondGroup);
  fs.symlinkSync(shared, path.join(firstGroup, '.health-os'), 'dir');
  fs.symlinkSync(shared, path.join(secondGroup, '.health-os'), 'dir');
  assert.equal(workspaceLockPath(buildPaths(firstGroup)), workspaceLockPath(buildPaths(secondGroup)));
});

test('atomic writes leave no sibling temporary file and support exclusive creation', (t) => {
  const root = scratch(t);
  const target = path.join(root, 'state.json');
  atomicWriteFileSync(target, '{"generation":1}\n', { encoding: 'utf8', mode: 0o600, exclusive: true });
  atomicWriteFileSync(target, '{"generation":2}\n', { encoding: 'utf8', mode: 0o600 });
  assert.equal(fs.readFileSync(target, 'utf8'), '{"generation":2}\n');
  assert.equal(fs.statSync(target).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(root), ['state.json']);
  assert.throws(() => atomicWriteFileSync(target, 'replace\n', { exclusive: true }), { code: 'EEXIST' });
  assert.equal(fs.readFileSync(target, 'utf8'), '{"generation":2}\n');
});

test('an atomic rename failure preserves destination bytes and removes its temporary file', (t) => {
  const root = scratch(t);
  const target = path.join(root, 'state.json');
  fs.writeFileSync(target, 'previous complete state\n');
  const originalRename = fs.renameSync;
  try {
    fs.renameSync = () => {
      const error = new Error('synthetic rename failure');
      error.code = 'EIO';
      throw error;
    };
    assert.throws(() => atomicWriteFileSync(target, 'replacement state\n', { encoding: 'utf8' }), { code: 'EIO' });
  } finally {
    fs.renameSync = originalRename;
  }
  assert.equal(fs.readFileSync(target, 'utf8'), 'previous complete state\n');
  assert.deepEqual(fs.readdirSync(root), ['state.json']);
});

test('concurrent CLI workout appends and working-weight updates preserve every mutation', async (t) => {
  const root = scratch(t);
  const workspace = path.join(root, 'workspace');
  const initialized = runCli(['init-workspace', '--workspace', workspace]);
  assert.equal(initialized.status, 0, initialized.stderr);

  const workouts = Array.from({ length: 6 }, (_, index) => {
    const payload = {
      session: {
        day: 'A', actual_mode: 'BASE', duration_minutes: 30 + index, session_rpe: 6,
        energy_pre: 7, soreness_pre: 1, notes: `concurrent synthetic session ${index}`
      },
      exercises: [{ exercise_key: 'squat', sets: [{ weight: 50 + index, reps: 5 }] }]
    };
    return runCliAsync([
      'log-workout', '--json', '--input-json', '--workspace', workspace,
      '--date', '2026-10-23'
    ], { input: JSON.stringify(payload) });
  });
  const weights = [
    ['squat', '81'], ['bench_press', '62.5'], ['deadlift', '112'], ['standing_press', '37.5']
  ].map(([exercise, weight]) => runCliAsync([
    'set-working-weight', '--workspace', workspace, '--exercise', exercise, '--weight', weight
  ]));
  const results = await Promise.all([...workouts, ...weights]);
  for (const result of results) assert.equal(result.code, 0, `${result.stderr}\n${result.stdout}`);

  const paths = buildPaths(workspace);
  const sessions = fs.readFileSync(paths.workoutSessionsFile, 'utf8').trim().split('\n');
  const exerciseLogs = fs.readFileSync(paths.exerciseLogsFile, 'utf8').trim().split('\n');
  assert.equal(sessions.length, 7, 'header plus all six distinct sessions');
  assert.equal(exerciseLogs.length, 7, 'header plus each session exercise');
  const settings = JSON.parse(fs.readFileSync(paths.exerciseSettingsFile, 'utf8'));
  for (const [exercise, weight] of [['squat', 81], ['bench_press', 62.5], ['deadlift', 112], ['standing_press', 37.5]]) {
    assert.equal(settings.exercises[exercise].working_weight_kg, weight);
  }
});

test('a killed lock-holder process leaves valid old data and causes writes to fail closed', async (t) => {
  const root = scratch(t);
  const workspace = path.join(root, 'workspace');
  const initialized = runCli(['init-workspace', '--workspace', workspace]);
  assert.equal(initialized.status, 0, initialized.stderr);
  const paths = buildPaths(workspace);
  const oldConfig = fs.readFileSync(paths.exerciseSettingsFile);
  const coordinationUrl = new URL('../src/coordination.js', import.meta.url).href;
  const layoutUrl = new URL('../src/layout.js', import.meta.url).href;
  const source = `import { acquireWorkspaceLock } from ${JSON.stringify(coordinationUrl)};\n` +
    `import { buildPaths } from ${JSON.stringify(layoutUrl)};\n` +
    `await acquireWorkspaceLock(buildPaths(process.env.HEALTH_OS_TEST_WORKSPACE));\n` +
    `console.log('LOCK_READY');\nsetInterval(() => {}, 60_000);`;
  const holder = spawn(process.execPath, ['--input-type=module', '-e', source], {
    cwd: repoRoot(), env: { ...process.env, HEALTH_OS_TEST_WORKSPACE: workspace },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  t.after(() => {
    if (holder.exitCode === null && holder.signalCode === null) holder.kill('SIGKILL');
  });
  let stdout = '';
  let stderr = '';
  holder.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
  holder.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
  const ready = new Promise((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error(`lock holder did not become ready: ${stderr}`)), 5_000);
    holder.stdout.on('data', () => {
      if (stdout.includes('LOCK_READY')) {
        clearTimeout(deadline);
        resolve();
      }
    });
    holder.once('error', (error) => { clearTimeout(deadline); reject(error); });
  });
  await ready;
  holder.kill('SIGKILL');
  await once(holder, 'close');

  const rejected = runCli([
    'set-working-weight', '--workspace', workspace, '--exercise', 'squat', '--weight', '999'
  ]);
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /HEALTH_OS_LOCKED|owner process is no longer running/);
  assert.deepEqual(fs.readFileSync(paths.exerciseSettingsFile), oldConfig);
  assert.ok(fs.existsSync(workspaceLockPath(paths)), 'crashed lock remains for explicit manual recovery');
  assert.match(fs.readFileSync(path.join(workspaceLockPath(paths), 'owner.json'), 'utf8'), /"pid"/);
});
