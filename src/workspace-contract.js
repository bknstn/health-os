import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteFileSync } from './coordination.js';
import { ensureWorkspace } from './layout.js';
import { initialiseWorkspace } from './engine.js';

export const WORKSPACE_SCHEMA_VERSION = 1;
export const DEFAULT_PROFILE_PATH = 'personal/files/profile.md';
export const MAX_PROFILE_BYTES = 1024 * 1024;
export const DEFAULT_PROFILE_MAX_CHARS = 12000;
export const MAX_PROFILE_MAX_CHARS = 50000;

const TEMPLATE_PATH = new URL('../templates/personal-profile.md', import.meta.url);
const MANIFEST_NAME = 'manifest.json';

export function profileTemplate() {
  return fs.readFileSync(TEMPLATE_PATH, 'utf8');
}

function existsEntry(filePath) {
  try {
    fs.lstatSync(filePath);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

function isWithin(basePath, targetPath) {
  const relative = path.relative(basePath, targetPath);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function workspaceRealRoot(paths) {
  const trackerRoot = path.resolve(paths.trackerRoot);
  if (existsEntry(trackerRoot)) return fs.realpathSync(trackerRoot);
  let existingAncestor = trackerRoot;
  while (!existsEntry(existingAncestor)) {
    const parent = path.dirname(existingAncestor);
    if (parent === existingAncestor) break;
    existingAncestor = parent;
  }
  const realAncestor = fs.realpathSync(existingAncestor);
  return path.resolve(realAncestor, path.relative(existingAncestor, trackerRoot));
}

export function validateProfilePath(profilePath) {
  if (typeof profilePath !== 'string' || !profilePath.trim()) {
    throw new Error('profile path must be a non-empty workspace-relative path');
  }
  if (profilePath.includes('\\') || profilePath.startsWith('/') || /^[A-Za-z]:/.test(profilePath)) {
    throw new Error('profile path must be a workspace-relative path using forward slashes');
  }
  const parts = profilePath.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) {
    throw new Error('profile path must not contain empty, ".", or ".." path segments');
  }
  if (!profilePath.startsWith('personal/files/')) {
    throw new Error('profile path must be inside personal/files/ to avoid engine-owned workspace paths');
  }
  if (!profilePath.endsWith('.md')) {
    throw new Error('profile path must name a Markdown .md file');
  }
  return profilePath;
}

function profileFilePath(paths, profilePath) {
  const validRelativePath = validateProfilePath(profilePath);
  const candidate = path.resolve(paths.trackerRoot, ...validRelativePath.split('/'));
  const lexicalRoot = path.resolve(paths.trackerRoot);
  if (!isWithin(lexicalRoot, candidate)) {
    throw new Error('profile path must stay inside the selected workspace');
  }

  const realRoot = workspaceRealRoot(paths);
  const profileAreaRelative = path.relative(path.resolve(paths.trackerRoot), path.resolve(paths.personalFilesDir));
  const personalAreaPath = path.resolve(paths.personalDir);
  const filesAreaPath = path.resolve(paths.personalFilesDir);
  const realPersonalArea = existsEntry(personalAreaPath)
    ? fs.realpathSync(personalAreaPath)
    : path.resolve(realRoot, path.relative(path.resolve(paths.trackerRoot), personalAreaPath));
  const realProfileArea = existsEntry(filesAreaPath)
    ? fs.realpathSync(filesAreaPath)
    : path.resolve(realRoot, profileAreaRelative);
  const expectedPersonalArea = path.resolve(realRoot, 'personal');
  const expectedProfileArea = path.resolve(realRoot, 'personal', 'files');
  if (realPersonalArea !== expectedPersonalArea || realProfileArea !== expectedProfileArea) {
    throw new Error('personal/files must resolve to the selected workspace personal area');
  }
  if (existsEntry(paths.trackerRoot)) {
    let existingAncestor = candidate;
    while (!existsEntry(existingAncestor)) {
      const parent = path.dirname(existingAncestor);
      if (parent === existingAncestor) break;
      existingAncestor = parent;
    }
    const realAncestor = fs.realpathSync(existingAncestor);
    if (!isWithin(realRoot, realAncestor)) {
      throw new Error('profile path resolves outside the selected workspace');
    }
    if (existsEntry(filesAreaPath) && !isWithin(realProfileArea, realAncestor)) {
      throw new Error('profile path resolves outside personal/files');
    }
  }
  if (existsEntry(candidate)) {
    const realCandidate = fs.realpathSync(candidate);
    if (!isWithin(realRoot, realCandidate)) {
      throw new Error('profile path resolves outside the selected workspace');
    }
    if (!isWithin(realProfileArea, realCandidate)) {
      throw new Error('profile path resolves outside personal/files');
    }
  }
  return candidate;
}

function manifestFilePath(paths) {
  return path.join(paths.trackerRoot, MANIFEST_NAME);
}

function parseManifest(paths) {
  const filePath = manifestFilePath(paths);
  if (!existsEntry(filePath)) return null;

  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`Invalid workspace manifest ${filePath}: ${error.message}`);
  }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error(`Invalid workspace manifest ${filePath}: expected a JSON object`);
  }
  const keys = Object.keys(manifest).sort();
  if (keys.length !== 2 || keys[0] !== 'profile_path' || keys[1] !== 'schema_version') {
    throw new Error(`Invalid workspace manifest ${filePath}: expected only schema_version and profile_path`);
  }
  if (manifest.schema_version !== WORKSPACE_SCHEMA_VERSION) {
    throw new Error(
      `Unsupported workspace schema version ${String(manifest.schema_version)} in ${filePath}; supported version is ${WORKSPACE_SCHEMA_VERSION}`
    );
  }
  validateProfilePath(manifest.profile_path);
  return manifest;
}

function validCalendarDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function parseProfileMarkdown(markdown, source = 'profile') {
  const normalized = markdown.replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');
  if (lines[0] !== '---') {
    throw new Error(`${source}: expected YAML frontmatter starting with ---`);
  }
  const closingIndex = lines.findIndex((line, index) => index > 0 && line === '---');
  if (closingIndex < 0) {
    throw new Error(`${source}: missing closing --- for profile metadata`);
  }

  const metadata = {};
  for (const line of lines.slice(1, closingIndex)) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const match = /^([a-z][a-z0-9_]*):[ \t]*(.*)$/.exec(line);
    if (!match) {
      throw new Error(`${source}: invalid metadata line ${JSON.stringify(line)}`);
    }
    const [, key, rawValue] = match;
    if (Object.hasOwn(metadata, key)) {
      throw new Error(`${source}: duplicate metadata field "${key}"`);
    }
    if (key !== 'schema_version' && key !== 'updated') {
      throw new Error(`${source}: unsupported metadata field "${key}"`);
    }
    metadata[key] = rawValue.trim();
  }

  if (metadata.schema_version !== '1') {
    throw new Error(`${source}: schema_version must be 1`);
  }
  if (!Object.hasOwn(metadata, 'updated')) {
    throw new Error(`${source}: updated metadata is required (use null when the date is unknown)`);
  }
  if (metadata.updated !== 'null' && !validCalendarDate(metadata.updated)) {
    throw new Error(`${source}: updated must be null or a real YYYY-MM-DD date`);
  }

  return {
    metadata: {
      schema_version: WORKSPACE_SCHEMA_VERSION,
      updated: metadata.updated === 'null' ? null : metadata.updated
    },
    body: lines.slice(closingIndex + 1).join('\n')
  };
}

function readProfile(paths, profilePath) {
  const filePath = profileFilePath(paths, profilePath);
  if (!existsEntry(filePath)) {
    throw new Error(`Selected profile is missing: ${filePath}`);
  }
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) {
    throw new Error(`Selected profile is not a regular file: ${filePath}`);
  }
  if (stat.size > MAX_PROFILE_BYTES) {
    throw new Error(`Selected profile exceeds the ${MAX_PROFILE_BYTES}-byte validation limit: ${filePath}`);
  }
  const markdown = fs.readFileSync(filePath, 'utf8');
  const parsed = parseProfileMarkdown(markdown, filePath);
  return { filePath, markdown, ...parsed };
}

export function readSelectedProfile(paths, explicitProfilePath) {
  const manifest = parseManifest(paths);
  if (!manifest) {
    throw new Error('Workspace has no versioned manifest; run workspace-inspect and explicitly migrate it before using profile commands');
  }
  const selected = explicitProfilePath === undefined
    ? manifest.profile_path
    : validateProfilePath(explicitProfilePath);
  if (selected !== manifest.profile_path) {
    throw new Error(
      `Requested profile "${selected}" conflicts with manifest profile_path "${manifest.profile_path}"; update the manifest selection deliberately`
    );
  }
  return { manifest, ...readProfile(paths, selected) };
}

function hasWorkspaceEntries(paths) {
  return fs.existsSync(paths.trackerRoot) && fs.readdirSync(paths.trackerRoot).length > 0;
}

export function inspectWorkspace(paths) {
  if (!existsEntry(paths.trackerRoot)) {
    return { status: 'uninitialized', workspace: paths.groupRoot, schema_version: null };
  }
  if (!fs.statSync(paths.trackerRoot).isDirectory()) {
    return { status: 'invalid', workspace: paths.groupRoot, schema_version: null, error: '.health-os path is not a directory' };
  }
  if (!existsEntry(manifestFilePath(paths))) {
    return {
      status: hasWorkspaceEntries(paths) ? 'unversioned' : 'uninitialized',
      workspace: paths.groupRoot,
      schema_version: null
    };
  }

  try {
    const manifest = parseManifest(paths);
    let profileStatus = 'valid';
    let profileError;
    try {
      readProfile(paths, manifest.profile_path);
    } catch (error) {
      profileStatus = error.message.startsWith('Selected profile is missing:') ? 'missing' : 'invalid';
      profileError = error.message;
    }
    return {
      status: profileStatus === 'valid' ? 'versioned' : `invalid_profile_${profileStatus}`,
      workspace: paths.groupRoot,
      schema_version: manifest.schema_version,
      profile_path: manifest.profile_path,
      profile_status: profileStatus,
      ...(profileError ? { error: profileError } : {})
    };
  } catch (error) {
    return { status: 'invalid', workspace: paths.groupRoot, schema_version: null, error: error.message };
  }
}

function manifestContents(profilePath) {
  return `${JSON.stringify({ schema_version: WORKSPACE_SCHEMA_VERSION, profile_path: profilePath }, null, 2)}\n`;
}

function ensureProfileParent(paths, profilePath) {
  const filePath = profileFilePath(paths, profilePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  profileFilePath(paths, profilePath);
  return filePath;
}

export function initializeVersionedWorkspace(paths, repoRoot, requestedProfilePath) {
  const manifestPath = manifestFilePath(paths);
  const requested = requestedProfilePath === undefined
    ? DEFAULT_PROFILE_PATH
    : validateProfilePath(requestedProfilePath);
  const manifest = parseManifest(paths);

  if (manifest) {
    if (requestedProfilePath !== undefined && requested !== manifest.profile_path) {
      throw new Error(
        `Requested profile "${requested}" conflicts with manifest profile_path "${manifest.profile_path}"; update the manifest selection deliberately`
      );
    }
    readProfile(paths, manifest.profile_path);
  } else if (hasWorkspaceEntries(paths)) {
    throw new Error('Existing workspace has no versioned manifest; run workspace-inspect, then workspace-migrate deliberately');
  }

  if (!manifest) {
    ensureProfileParent(paths, requested);
    if (existsEntry(profileFilePath(paths, requested))) {
      readProfile(paths, requested);
    } else {
      atomicWriteFileSync(profileFilePath(paths, requested), profileTemplate(), { encoding: 'utf8', mode: 0o600, exclusive: true });
    }
    atomicWriteFileSync(manifestPath, manifestContents(requested), { encoding: 'utf8', mode: 0o600, exclusive: true });
  }

  // Validate all existing profile state before the legacy seeder can create any files.
  readProfile(paths, manifest?.profile_path || requested);
  ensureWorkspace(paths);
  initialiseWorkspace(paths, repoRoot);
  return {
    status: 'initialized',
    workspace: paths.groupRoot,
    schema_version: WORKSPACE_SCHEMA_VERSION,
    profile_path: manifest?.profile_path || requested
  };
}

function migrationPlan(paths, requestedProfilePath) {
  if (!existsEntry(paths.trackerRoot) || !fs.statSync(paths.trackerRoot).isDirectory()) {
    throw new Error('Workspace has no existing .health-os directory to migrate; use init-workspace for a new workspace');
  }
  if (existsEntry(manifestFilePath(paths))) {
    const manifest = parseManifest(paths);
    throw new Error(`Workspace already has schema version ${manifest.schema_version}; no migration is needed`);
  }

  const selected = requestedProfilePath === undefined
    ? DEFAULT_PROFILE_PATH
    : validateProfilePath(requestedProfilePath);
  const filePath = profileFilePath(paths, selected);
  const profileExists = existsEntry(filePath);
  if (profileExists) readProfile(paths, selected);

  const writes = [];
  const directories = [];
  if (!profileExists) {
    writes.push(path.posix.join('.health-os', selected));
    let directory = path.dirname(filePath);
    while (directory !== paths.trackerRoot && !existsEntry(directory)) {
      directories.push(path.relative(paths.groupRoot, directory).split(path.sep).join('/'));
      directory = path.dirname(directory);
    }
  }
  writes.push(path.posix.join('.health-os', MANIFEST_NAME));
  return {
    selected,
    profileExists,
    writes,
    directories: directories.reverse()
  };
}

export function migrateWorkspace(paths, requestedProfilePath, dryRun = false) {
  const plan = migrationPlan(paths, requestedProfilePath);
  if (dryRun) {
    return {
      ok: true,
      dry_run: true,
      workspace: paths.groupRoot,
      from_schema_version: null,
      to_schema_version: WORKSPACE_SCHEMA_VERSION,
      profile_path: plan.selected,
      template_would_be_created: !plan.profileExists,
      directories_to_create: plan.directories,
      writes: plan.writes
    };
  }

  if (!plan.profileExists) {
    const profileFile = ensureProfileParent(paths, plan.selected);
    atomicWriteFileSync(profileFile, profileTemplate(), { encoding: 'utf8', mode: 0o600, exclusive: true });
  }
  atomicWriteFileSync(manifestFilePath(paths), manifestContents(plan.selected), { encoding: 'utf8', mode: 0o600, exclusive: true });
  return {
    ok: true,
    dry_run: false,
    workspace: paths.groupRoot,
    from_schema_version: null,
    to_schema_version: WORKSPACE_SCHEMA_VERSION,
    profile_path: plan.selected,
    template_created: !plan.profileExists,
    writes: plan.writes
  };
}

export function validateProfileCommand(paths, explicitProfilePath) {
  const profile = readSelectedProfile(paths, explicitProfilePath);
  return {
    ok: true,
    profile_path: profile.manifest.profile_path,
    metadata: profile.metadata,
    bytes: Buffer.byteLength(profile.markdown, 'utf8')
  };
}

export function showProfileCommand(paths, explicitProfilePath, maxChars = DEFAULT_PROFILE_MAX_CHARS) {
  if (!Number.isInteger(maxChars) || maxChars < 1 || maxChars > MAX_PROFILE_MAX_CHARS) {
    throw new Error(`profile-show --max-chars must be an integer from 1 to ${MAX_PROFILE_MAX_CHARS}`);
  }
  const profile = readSelectedProfile(paths, explicitProfilePath);
  const totalChars = [...profile.markdown].length;
  const markdown = [...profile.markdown].slice(0, maxChars).join('');
  return {
    ok: true,
    profile_path: profile.manifest.profile_path,
    metadata: profile.metadata,
    markdown,
    truncated: totalChars > maxChars,
    total_chars: totalChars,
    returned_chars: [...markdown].length
  };
}
