import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';

const LOCK_WAIT_MS = 30_000;
const LOCK_POLL_MS = 40;

function exists(filePath) {
  try {
    fs.lstatSync(filePath);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

/** Resolve symlinked existing prefixes while keeping a stable name for missing leaves. */
export function canonicalPath(filePath) {
  const absolutePath = path.resolve(filePath);
  let ancestor = absolutePath;
  const suffix = [];
  while (!exists(ancestor)) {
    const parent = path.dirname(ancestor);
    if (parent === ancestor) break;
    suffix.unshift(path.basename(ancestor));
    ancestor = parent;
  }
  return path.resolve(fs.realpathSync(ancestor), ...suffix);
}

export function workspaceLockPath(paths) {
  const root = canonicalPath(paths.trackerRoot);
  return `${root}.health-os-write.lock`;
}

export function tokenLockPath(tokenFile) {
  return `${canonicalPath(tokenFile)}.health-os-token.lock`;
}

function ownerFile(lockPath) {
  return path.join(lockPath, 'owner.json');
}

function readOwner(lockPath) {
  try {
    const owner = JSON.parse(fs.readFileSync(ownerFile(lockPath), 'utf8'));
    if (!owner || owner.hostname !== os.hostname() || !Number.isInteger(owner.pid) || owner.pid < 1 || typeof owner.id !== 'string') {
      return null;
    }
    return owner;
  } catch {
    return null;
  }
}

function pidIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== 'ESRCH';
  }
}

function lockError(lockPath, owner, reason) {
  const ownerDescription = owner ? `pid ${owner.pid} on ${owner.hostname}` : 'owner metadata missing or invalid';
  const error = new Error(
    `${reason} at ${lockPath} (${ownerDescription}). If the owner process is gone, verify no Health OS process is using the resource, then remove the lock directory manually.`
  );
  error.code = 'HEALTH_OS_LOCKED';
  return error;
}

async function acquireLock(lockPath, waitMs = LOCK_WAIT_MS) {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const id = randomUUID();
  const started = Date.now();

  while (true) {
    let created = false;
    try {
      fs.mkdirSync(lockPath);
      created = true;
      fs.writeFileSync(ownerFile(lockPath), `${JSON.stringify({
        id,
        pid: process.pid,
        hostname: os.hostname(),
        started_at: new Date().toISOString()
      }, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      return () => {
        const owner = readOwner(lockPath);
        if (owner?.id === id && owner.pid === process.pid) {
          fs.rmSync(lockPath, { recursive: true, force: true });
        }
      };
    } catch (error) {
      if (created) {
        fs.rmSync(lockPath, { recursive: true, force: true });
        throw error;
      }
      if (error.code !== 'EEXIST') {
        if (exists(lockPath)) throw lockError(lockPath, readOwner(lockPath), 'Cannot safely acquire lock');
        throw error;
      }

      const owner = readOwner(lockPath);
      if (!owner) {
        if (Date.now() - started >= waitMs) {
          throw lockError(lockPath, null, 'Cannot safely inspect lock');
        }
        await new Promise((resolve) => setTimeout(resolve, LOCK_POLL_MS));
        continue;
      }
      if (!pidIsAlive(owner.pid)) {
        const currentOwner = readOwner(lockPath);
        if (!exists(lockPath) || currentOwner?.id !== owner.id) {
          await new Promise((resolve) => setTimeout(resolve, LOCK_POLL_MS));
          continue;
        }
        throw lockError(lockPath, owner, 'Found a lock whose owner process is no longer running');
      }
      if (Date.now() - started >= waitMs) {
        throw lockError(lockPath, owner, 'Timed out waiting for lock');
      }
      await new Promise((resolve) => setTimeout(resolve, LOCK_POLL_MS));
    }
  }
}

export async function withWorkspaceLock(paths, operation, options = {}) {
  const release = await acquireLock(workspaceLockPath(paths), options.waitMs ?? LOCK_WAIT_MS);
  try {
    return await operation();
  } finally {
    release();
  }
}

export function acquireWorkspaceLock(paths, options = {}) {
  return acquireLock(workspaceLockPath(paths), options.waitMs ?? LOCK_WAIT_MS);
}

export async function withTokenFileLock(tokenFile, operation, options = {}) {
  const canonicalFile = canonicalPath(tokenFile);
  const release = await acquireLock(tokenLockPath(canonicalFile), options.waitMs ?? LOCK_WAIT_MS);
  try {
    return await operation(canonicalFile);
  } finally {
    release();
  }
}

export async function withPathLock(resourcePath, operation, options = {}) {
  const key = createHash('sha256').update(canonicalPath(resourcePath)).digest('hex');
  const parent = path.dirname(canonicalPath(resourcePath));
  const release = await acquireLock(path.join(parent, `.health-os-resource-${key}.lock`), options.waitMs ?? LOCK_WAIT_MS);
  try {
    return await operation();
  } finally {
    release();
  }
}

export function acquirePathLock(resourcePath, options = {}) {
  const canonical = canonicalPath(resourcePath);
  const key = createHash('sha256').update(canonical).digest('hex');
  const parent = path.dirname(canonical);
  return acquireLock(path.join(parent, `.health-os-resource-${key}.lock`), options.waitMs ?? LOCK_WAIT_MS);
}

export function atomicWriteFileSync(filePath, data, options = {}) {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true, mode: options.directoryMode ?? 0o700 });
  const temporaryPath = path.join(directory, `.health-os-${path.basename(filePath)}-${process.pid}-${randomUUID()}.tmp`);
  let descriptor;
  try {
    descriptor = fs.openSync(temporaryPath, 'wx', options.mode ?? 0o600);
    fs.writeFileSync(descriptor, data, options.encoding ? { encoding: options.encoding } : undefined);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    if (options.mode !== undefined) fs.chmodSync(temporaryPath, options.mode);
    if (options.exclusive) {
      fs.linkSync(temporaryPath, filePath);
      fs.unlinkSync(temporaryPath);
    } else {
      fs.renameSync(temporaryPath, filePath);
    }
    if (options.mode !== undefined) fs.chmodSync(filePath, options.mode);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    if (exists(temporaryPath)) fs.rmSync(temporaryPath, { force: true });
  }
}

export function atomicCopyFileSync(sourcePath, targetPath, options = {}) {
  const data = fs.readFileSync(sourcePath);
  atomicWriteFileSync(targetPath, data, options);
}
