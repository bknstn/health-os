import fs from 'node:fs';

import { buildPaths, ensureWorkspace, repoRoot } from './layout.js';
import { parseWorkoutLog } from './log-parser.js';
import { validateRecoveryPayload } from './recovery-contract.js';
import {
  appendWorkoutLog,
  buildNextWorkout,
  ingestDailyState,
  initialiseWorkspace,
  localDateString,
  renderToday,
  renderWeeklySummary,
  renderWhy
} from './engine.js';

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (token.startsWith('--')) {
      options[token.slice(2)] = rest[index + 1] && !rest[index + 1].startsWith('--') ? rest[++index] : 'true';
    }
  }
  return { command, options };
}

function readInput(optionValue) {
  if (!optionValue || optionValue === '-') {
    return fs.readFileSync(0, 'utf8');
  }
  return fs.readFileSync(optionValue, 'utf8');
}

function printWorkout(nextWorkout) {
  const lines = [];
  lines.push(`mode=${nextWorkout.mode}`);
  lines.push(`day=${nextWorkout.dayType}`);
  for (const exercise of nextWorkout.exercises) {
    const weight = exercise.target_weight || (exercise.load_tier === 'bodyweight' ? 'bodyweight' : 'unset');
    lines.push(
      `${exercise.exercise_key}=${exercise.target_sets}x${exercise.target_reps}@${weight}`
    );
  }
  return `${lines.join('\n')}\n`;
}

async function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
  const paths = buildPaths(options.workspace);
  ensureWorkspace(paths);

  switch (command) {
    case 'init-workspace':
      initialiseWorkspace(paths, repoRoot());
      process.stdout.write(`Initialized workspace at ${paths.trackerRoot}\n`);
      return;
    case 'log-workout': {
      initialiseWorkspace(paths, repoRoot());
      const parsed = parseWorkoutLog(readInput(options.input));
      const sessionId = appendWorkoutLog(paths, parsed, options.date || localDateString());
      process.stdout.write(`Logged workout ${sessionId}\n`);
      return;
    }
    case 'next':
      initialiseWorkspace(paths, repoRoot());
      process.stdout.write(printWorkout(buildNextWorkout(paths, options.date || localDateString())));
      return;
    case 'ingest-daily-state': {
      initialiseWorkspace(paths, repoRoot());
      const payload = validateRecoveryPayload(JSON.parse(readInput(options.input)));
      const decision = ingestDailyState(paths, payload);
      process.stdout.write(`mode=${decision.mode}\nscore=${decision.score}\n`);
      return;
    }
    case 'validate-daily-state': {
      const payload = validateRecoveryPayload(JSON.parse(readInput(options.input)));
      process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
      return;
    }
    case 'today':
      initialiseWorkspace(paths, repoRoot());
      process.stdout.write(renderToday(paths, options.date || localDateString()));
      return;
    case 'why':
      initialiseWorkspace(paths, repoRoot());
      process.stdout.write(renderWhy(paths));
      return;
    case 'weekly-summary':
      initialiseWorkspace(paths, repoRoot());
      process.stdout.write(renderWeeklySummary(paths, options['end-date'] || localDateString()));
      return;
    default:
      process.stderr.write(
        'Usage: node src/cli.js <init-workspace|log-workout|next|ingest-daily-state|validate-daily-state|today|why|weekly-summary> [--workspace PATH] [--input FILE|-]\n'
      );
      process.exitCode = 1;
  }
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
