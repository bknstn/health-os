import fs from 'node:fs';
import path from 'node:path';
import { atomicCopyFileSync } from './coordination.js';

export function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

export function copyIfMissing(sourcePath, targetPath) {
  if (!fs.existsSync(targetPath)) {
    atomicCopyFileSync(sourcePath, targetPath, { mode: 0o600 });
  }
}

export function repoConfigPath(rootDir, fileName) {
  return path.join(rootDir, 'config', fileName);
}
