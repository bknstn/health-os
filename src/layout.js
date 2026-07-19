import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function repoRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
}

export function buildPaths(groupRootArg) {
  const groupRoot = path.resolve(groupRootArg || process.cwd());
  const trackerRoot = path.join(groupRoot, '.health-os');
  return {
    groupRoot,
    trackerRoot,
    configDir: path.join(trackerRoot, 'config'),
    dataDir: path.join(trackerRoot, 'data'),
    artifactsDir: path.join(trackerRoot, 'artifacts'),
    memoryDir: path.join(trackerRoot, 'memory'),
    memoryEvidenceDir: path.join(trackerRoot, 'memory', 'evidence'),
    memoryWikiDir: path.join(trackerRoot, 'memory', 'wiki'),
    personalDir: path.join(trackerRoot, 'personal'),
    personalRawDir: path.join(trackerRoot, 'personal', 'raw'),
    personalFilesDir: path.join(trackerRoot, 'personal', 'files'),
    trainingPlanFile: path.join(trackerRoot, 'config', 'training-plan.json'),
    rulesFile: path.join(trackerRoot, 'config', 'rules.json'),
    exerciseSettingsFile: path.join(trackerRoot, 'config', 'exercise-settings.json'),
    workoutSessionsFile: path.join(trackerRoot, 'data', 'workout_sessions.csv'),
    exerciseLogsFile: path.join(trackerRoot, 'data', 'exercise_logs.csv'),
    recoverySnapshotsFile: path.join(trackerRoot, 'data', 'recovery_snapshots.csv'),
    dailyStateFile: path.join(trackerRoot, 'data', 'daily_state.csv'),
    decisionLogFile: path.join(trackerRoot, 'data', 'decision_log.csv'),
    rulesHistoryFile: path.join(trackerRoot, 'data', 'rules_history.csv'),
    todayArtifactFile: path.join(trackerRoot, 'artifacts', 'today.md'),
    weeklyArtifactFile: path.join(trackerRoot, 'artifacts', 'weekly.md'),
    memorySchemaFile: path.join(trackerRoot, 'memory', 'SCHEMA.md'),
    memoryIndexFile: path.join(trackerRoot, 'memory', 'index.md'),
    memoryLogFile: path.join(trackerRoot, 'memory', 'log.md')
  };
}

export function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

export function ensureWorkspace(paths) {
  ensureDir(paths.trackerRoot);
  ensureDir(paths.configDir);
  ensureDir(paths.dataDir);
  ensureDir(paths.artifactsDir);
  ensureDir(paths.memoryDir);
  ensureDir(paths.memoryEvidenceDir);
  ensureDir(paths.memoryWikiDir);
  ensureDir(paths.personalDir);
  ensureDir(paths.personalRawDir);
  ensureDir(paths.personalFilesDir);
}
