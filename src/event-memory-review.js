import fs from 'node:fs';
import path from 'node:path';

function reviewError(code, message) {
  return Object.assign(new Error(message), { code });
}

export function readEventReviewState(paths, { allowPending = false } = {}) {
  if (!fs.existsSync(paths.eventReviewFile)) {
    if (fs.existsSync(paths.eventsDbFile)) {
      throw reviewError('HEALTH_OS_EVENT_REVIEW_STATE_MISSING', 'Event store exists without derived-memory review state; memory stays blocked');
    }
    return null;
  }
  let state;
  try { state = JSON.parse(fs.readFileSync(paths.eventReviewFile, 'utf8')); }
  catch { throw reviewError('HEALTH_OS_EVENT_REVIEW_STATE_INVALID', 'Derived-memory event review state is unreadable; memory stays blocked'); }
  if (!state || state.schema_version !== 1 || typeof state.store_id !== 'string' ||
      !Number.isSafeInteger(state.reviewed_generation) || !Number.isSafeInteger(state.required_generation) ||
      state.reviewed_generation < 0 || state.required_generation < state.reviewed_generation ||
      typeof state.pending !== 'boolean' || !Array.isArray(state.changed_events) || state.changed_events.some((item) =>
        !item || typeof item.event_id !== 'string' || typeof item.profile_id !== 'string' || !Number.isSafeInteger(item.revision) ||
        item.revision < 1 || !['active', 'superseded', 'deleted'].includes(item.status) || !Number.isSafeInteger(item.generation) ||
        item.generation < 1 || item.generation > state.required_generation
      ) || new Set(state.changed_events.map((item) => item.event_id)).size !== state.changed_events.length) {
    throw reviewError('HEALTH_OS_EVENT_REVIEW_STATE_INVALID', 'Derived-memory event review state is malformed; memory stays blocked');
  }
  if (!allowPending && (state.pending || state.reviewed_generation < state.required_generation)) {
    throw reviewError('HEALTH_OS_MEMORY_REVALIDATION_REQUIRED', `Event generation ${state.required_generation} changed derived-memory inputs; review wiki/evidence and run context-revalidate-memory --generation ${state.required_generation}`);
  }
  return state;
}

export function validateEventProvenanceMarkdown(markdown, reviewState) {
  const changed = new Map((reviewState?.changed_events || []).map((item) => [item.event_id, item]));
  const issues = [];
  for (const match of markdown.matchAll(/health-event:([0-9a-f-]{36})@(\d+)/gi)) {
    const [, matchedEventId, revisionText] = match;
    const eventId = matchedEventId.toLowerCase();
    const current = changed.get(eventId);
    const revision = Number(revisionText);
    if (!current) {
      issues.push({ event_id: eventId, reference: match[0], reason: 'unknown_event' });
    } else if (current.status === 'deleted') {
      issues.push({ event_id: eventId, reference: match[0], reason: 'deleted' });
    } else if (current.status === 'superseded') {
      issues.push({ event_id: eventId, reference: match[0], reason: 'superseded', current_revision: current.revision });
    } else if (revision !== current.revision) {
      issues.push({ event_id: eventId, reference: match[0], reason: 'stale_revision', current_revision: current.revision });
    }
  }
  return issues;
}

export function findStaleEventProvenance(paths, reviewState) {
  const stale = [];
  const walk = (directory) => {
    if (!fs.existsSync(directory)) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const filePath = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(filePath);
      else if (entry.isFile() && entry.name.endsWith('.md')) {
        const markdown = fs.readFileSync(filePath, 'utf8');
        for (const issue of validateEventProvenanceMarkdown(markdown, reviewState)) {
          stale.push({ file: path.relative(paths.memoryDir, filePath).split(path.sep).join('/'), ...issue });
        }
      }
    }
  };
  walk(paths.memoryEvidenceDir);
  walk(paths.memoryWikiDir);
  return stale;
}

export function assertMemoryEventProvenanceCurrent(paths, { allowPending = false } = {}) {
  const state = readEventReviewState(paths, { allowPending });
  const stale = findStaleEventProvenance(paths, state);
  if (stale.length) {
    throw reviewError('HEALTH_OS_MEMORY_EVENT_PROVENANCE_STALE', `Derived pages contain ${stale.length} deleted or stale event reference(s); update the Markdown provenance before reading memory context`);
  }
  return state;
}
