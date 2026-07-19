import fs from 'node:fs';
import path from 'node:path';

import { renderWeeklySummary } from './engine.js';

const ALLOWED_STATUSES = new Set(['observation', 'hypothesis', 'accepted_rule', 'general_claim']);
const ALLOWED_CONFIDENCE = new Set(['low', 'medium', 'high']);
const REQUIRED_FIELDS = [
  'title',
  'status',
  'confidence',
  'evidence_start',
  'evidence_end',
  'last_reviewed',
  'provenance'
];
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function isDateString(value) {
  if (!DATE_PATTERN.test(value || '')) {
    return false;
  }
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function posixRelative(from, target) {
  return path.relative(from, target).split(path.sep).join('/');
}

function markdownFiles(root) {
  if (!fs.existsSync(root)) {
    return [];
  }
  const files = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...markdownFiles(entryPath));
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      files.push(entryPath);
    }
  }
  return files.sort();
}

export function parseFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!match) {
    return { metadata: null, body: content };
  }
  const metadata = {};
  for (const line of match[1].split('\n')) {
    const separator = line.indexOf(':');
    if (separator === -1) {
      continue;
    }
    const key = line.slice(0, separator).trim();
    const rawValue = line.slice(separator + 1).trim();
    if (rawValue.startsWith('[')) {
      try {
        metadata[key] = JSON.parse(rawValue);
      } catch {
        metadata[key] = rawValue;
      }
    } else if (rawValue === 'true' || rawValue === 'false') {
      metadata[key] = rawValue === 'true';
    } else {
      metadata[key] = rawValue.replace(/^(["'])(.*)\1$/, '$2');
    }
  }
  return { metadata, body: content.slice(match[0].length) };
}

function pageTitle(file) {
  const { metadata, body } = parseFrontmatter(fs.readFileSync(file, 'utf8'));
  return metadata?.title || body.match(/^#\s+(.+)$/m)?.[1] || path.basename(file, '.md');
}

export function rebuildMemoryIndex(paths) {
  const sections = [
    ['Evidence bundles', markdownFiles(paths.memoryEvidenceDir)],
    ['Wiki pages', markdownFiles(paths.memoryWikiDir)]
  ];
  const lines = [
    '# Health OS Memory Index',
    '',
    'This index points to derived memory. Authoritative health data remains under `.health-os/data/`.',
    ''
  ];
  for (const [heading, files] of sections) {
    lines.push(`## ${heading}`, '');
    if (files.length === 0) {
      lines.push('_None yet._', '');
      continue;
    }
    for (const file of files) {
      const relative = posixRelative(paths.memoryDir, file);
      lines.push(`- [${pageTitle(file)}](${relative})`);
    }
    lines.push('');
  }
  const output = `${lines.join('\n').trimEnd()}\n`;
  fs.writeFileSync(paths.memoryIndexFile, output, 'utf8');
  return output;
}

function windowStart(endDate) {
  const end = new Date(`${endDate}T12:00:00Z`);
  if (!isDateString(endDate)) {
    throw new Error('memory-update --end-date must use YYYY-MM-DD');
  }
  end.setUTCDate(end.getUTCDate() - 6);
  return end.toISOString().slice(0, 10);
}

export function updateMemory(paths, endDate) {
  const startDate = windowStart(endDate);
  const weeklySummary = renderWeeklySummary(paths, endDate).trimEnd();
  const evidenceFile = path.join(paths.memoryEvidenceDir, `weekly-${endDate}.md`);
  const content = [
    '---',
    `title: Weekly evidence ending ${endDate}`,
    'status: observation',
    'confidence: high',
    `evidence_start: ${startDate}`,
    `evidence_end: ${endDate}`,
    `last_reviewed: ${endDate}`,
    'provenance: ["../../data/workout_sessions.csv", "../../data/exercise_logs.csv", "../../data/daily_state.csv", "../../artifacts/weekly.md"]',
    'human_confirmed: false',
    'generated_by: health-os memory-update',
    '---',
    '',
    `# Weekly evidence ending ${endDate}`,
    '',
    '> Deterministic review seed. This file contains no LLM synthesis or medical inference.',
    '',
    weeklySummary,
    ''
  ].join('\n');
  fs.writeFileSync(evidenceFile, content, 'utf8');

  const logLine = `- ${startDate} to ${endDate}: compiled [weekly evidence](evidence/weekly-${endDate}.md)`;
  const currentLog = fs.readFileSync(paths.memoryLogFile, 'utf8').trimEnd();
  if (!currentLog.split('\n').includes(logLine)) {
    fs.writeFileSync(paths.memoryLogFile, `${currentLog}\n${logLine}\n`, 'utf8');
  }
  rebuildMemoryIndex(paths);
  return {
    evidence_file: evidenceFile,
    evidence_start: startDate,
    evidence_end: endDate,
    source_artifact: paths.weeklyArtifactFile
  };
}

function queryTerms(query) {
  return [...new Set(query.toLowerCase().match(/[\p{L}\p{N}_-]{2,}/gu) || [])];
}

export function memoryContext(paths, query, { maxChars = 12000, maxPages = 5 } = {}) {
  const terms = queryTerms(query);
  if (terms.length === 0) {
    throw new Error('memory-context requires a non-empty --query');
  }
  const candidates = [
    ...markdownFiles(paths.memoryWikiDir),
    ...markdownFiles(paths.memoryEvidenceDir)
  ].map((file) => {
    const content = fs.readFileSync(file, 'utf8');
    const lower = content.toLowerCase();
    const name = path.basename(file).toLowerCase();
    const score = terms.reduce((sum, term) => {
      const bodyMatches = lower.split(term).length - 1;
      return sum + bodyMatches + (name.includes(term) ? 5 : 0);
    }, 0);
    return { file, content, score };
  }).filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || left.file.localeCompare(right.file))
    .slice(0, maxPages);

  const index = fs.readFileSync(paths.memoryIndexFile, 'utf8').trimEnd();
  const chunks = [
    '# Health OS Memory Context',
    '',
    `Query: ${query}`,
    '',
    'Memory is derived context, not authoritative medical evidence.',
    '',
    '## Index',
    '',
    index
  ];
  for (const entry of candidates) {
    chunks.push('', `## Source: ${posixRelative(paths.memoryDir, entry.file)}`, '', entry.content.trimEnd());
  }
  let output = `${chunks.join('\n')}\n`;
  if (output.length > maxChars) {
    const marker = '\n\n[context truncated]\n';
    output = `${output.slice(0, Math.max(0, maxChars - marker.length)).trimEnd()}${marker}`;
  }
  return output;
}

function finding(severity, code, file, message) {
  return { severity, code, file, message };
}

function isStale(dateString, nowDate, staleDays) {
  const reviewed = new Date(`${dateString}T00:00:00Z`);
  const now = new Date(`${nowDate}T00:00:00Z`);
  return Number.isFinite(reviewed.getTime()) && Number.isFinite(now.getTime()) &&
    (now - reviewed) / 86400000 > staleDays;
}

function linkedMarkdownTargets(content) {
  const targets = [];
  for (const match of content.matchAll(/\[[^\]]*\]\(([^)]+\.md(?:#[^)]+)?)\)/g)) {
    targets.push(match[1].split('#')[0]);
  }
  for (const match of content.matchAll(/\[\[([^\]|#]+\.md)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/g)) {
    targets.push(match[1]);
  }
  return targets;
}

export function lintMemory(paths, { nowDate, staleDays = 90 } = {}) {
  const today = nowDate || new Date().toISOString().slice(0, 10);
  const findings = [];
  const files = [...markdownFiles(paths.memoryEvidenceDir), ...markdownFiles(paths.memoryWikiDir)];
  for (const file of files) {
    const relative = posixRelative(paths.memoryDir, file);
    const content = fs.readFileSync(file, 'utf8');
    const { metadata } = parseFrontmatter(content);
    if (!metadata) {
      findings.push(finding('error', 'missing_frontmatter', relative, 'Page must begin with metadata frontmatter.'));
      continue;
    }
    for (const field of REQUIRED_FIELDS) {
      if (metadata[field] === undefined || metadata[field] === '' ||
          (Array.isArray(metadata[field]) && metadata[field].length === 0)) {
        findings.push(finding('error', 'missing_metadata', relative, `Missing required metadata: ${field}.`));
      }
    }
    if (metadata.status && !ALLOWED_STATUSES.has(metadata.status)) {
      findings.push(finding('error', 'invalid_status', relative, `Unsupported status: ${metadata.status}.`));
    }
    if (metadata.confidence && !ALLOWED_CONFIDENCE.has(metadata.confidence)) {
      findings.push(finding('error', 'invalid_confidence', relative, `Unsupported confidence: ${metadata.confidence}.`));
    }
    for (const field of ['evidence_start', 'evidence_end', 'last_reviewed']) {
      if (metadata[field] && !isDateString(metadata[field])) {
        findings.push(finding('error', 'invalid_date', relative, `${field} must use YYYY-MM-DD.`));
      }
    }
    if (isDateString(metadata.evidence_start) && isDateString(metadata.evidence_end) &&
        metadata.evidence_start > metadata.evidence_end) {
      findings.push(finding('error', 'invalid_evidence_window', relative, 'evidence_start is after evidence_end.'));
    }
    if (metadata.provenance !== undefined) {
      if (!Array.isArray(metadata.provenance)) {
        findings.push(finding('error', 'invalid_provenance', relative, 'provenance must be a JSON array.'));
      } else {
        for (const source of metadata.provenance) {
          if (typeof source !== 'string' || source.trim() === '') {
            findings.push(finding('error', 'invalid_provenance', relative, 'provenance entries must be non-empty strings.'));
            continue;
          }
          if (!/^https?:\/\//.test(source)) {
            const resolved = path.resolve(path.dirname(file), source);
            if (!fs.existsSync(resolved)) {
              findings.push(finding('error', 'missing_provenance', relative, `Provenance target does not exist: ${source}.`));
            }
          }
        }
      }
    }
    if (metadata.status === 'accepted_rule' && metadata.human_confirmed !== true) {
      findings.push(finding('error', 'unconfirmed_accepted_rule', relative, 'accepted_rule requires human_confirmed: true.'));
    }
    if (isDateString(metadata.last_reviewed) && isDateString(today) && isStale(metadata.last_reviewed, today, staleDays)) {
      findings.push(finding('warning', 'stale_review', relative, `Last reviewed more than ${staleDays} days ago.`));
    }
    for (const target of linkedMarkdownTargets(content)) {
      if (/^(?:https?:)?\/\//.test(target)) {
        continue;
      }
      if (!fs.existsSync(path.resolve(path.dirname(file), target))) {
        findings.push(finding('error', 'broken_link', relative, `Linked Markdown file does not exist: ${target}.`));
      }
    }
  }
  const errors = findings.filter((item) => item.severity === 'error').length;
  const warnings = findings.filter((item) => item.severity === 'warning').length;
  return { ok: errors === 0, errors, warnings, findings };
}
