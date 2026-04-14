import fs from 'node:fs';
import path from 'node:path';

export function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

export function copyIfMissing(sourcePath, targetPath) {
  if (!fs.existsSync(targetPath)) {
    fs.copyFileSync(sourcePath, targetPath);
  }
}

export function repoConfigPath(rootDir, fileName) {
  return path.join(rootDir, 'config', fileName);
}
