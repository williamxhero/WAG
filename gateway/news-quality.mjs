import { publisherPublicationInstant } from './evidence-metadata.mjs';

// Independent news-quality acceptance for WAG search.
//
// This module is deliberately *separate* from the native evidence-availability gate
// (`evidence-live-smoke.mjs`): the native gate proves that retrieval metadata exists, while this gate
// judges the fixed candidate set on two independent axes — manual relevance and verifiable freshness.
// Relevance labels are human annotations used offline only; they are never promoted into an online
// automatic relevance judgment, and the denominator is always every fixed candidate (failures are
// listed, never skipped to make a count look complete).
//
// A candidate with no read record at all is `unread` (for example one the probe left out of a bounded
// `PROBE_MAX_READS` budget), and is reported distinctly from `read_failure` (a read that was actually
// attempted and failed). An unread page is never judged to be date-less: its time stays `unverified`.

const CANDIDATE_CATEGORIES = ['unread', 'read_failure', 'unknown', 'stale', 'both_satisfied', 'irrelevant'];

function windowBounds(window) {
  const start = Date.parse(window?.start);
  const end = Date.parse(window?.end);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  return { start, end };
}

// Freshness verdict for one read record against an explicit window. Only a publisher-sourced instant
// inside [start, end] is `within`; a timestamp after the window end (future / clock skew) is
// `unverified`, never silently fresh; URL-inferred, timezone-less and date-only evidence stays
// `unverified`; anything before the window is `outside`.
export function classifySubmissionTime(record, bounds) {
  const range = bounds && Number.isFinite(bounds.start) && Number.isFinite(bounds.end) ? bounds : null;
  if (!range) return 'unverified';
  const instant = publisherPublicationInstant(record);
  if (instant === null) return 'unverified';
  if (instant > range.end) return 'unverified';
  if (instant < range.start) return 'outside';
  return 'within';
}

function primaryCategory({ readOk, readFailed, timeStatus, relevant }) {
  // No read record at all is `unread` — a bounded read budget is never reported as a page without a
  // date, and never silently counted as a failure that was attempted.
  if (!readOk && !readFailed) return 'unread';
  if (!readOk) return 'read_failure';
  // A manually labelled relevance negative fails on subject matter regardless of any timestamp, so it
  // is reported as irrelevant rather than folded into the time buckets.
  if (!relevant) return 'irrelevant';
  if (timeStatus === 'unverified') return 'unknown';
  if (timeStatus === 'outside') return 'stale';
  return 'both_satisfied';
}

function evaluateGate(report, require) {
  const maxReadFailure = Number.isFinite(require?.maxReadFailure) ? require.maxReadFailure : 0;
  const maxUnknown = Number.isFinite(require?.maxUnknown) ? require.maxUnknown : Infinity;
  const maxUnread = Number.isFinite(require?.maxUnread) ? require.maxUnread : Infinity;
  const minBothSatisfied = Number.isFinite(require?.minBothSatisfied) ? require.minBothSatisfied : 1;
  const reasons = [];
  if (report.denominator === 0) reasons.push('no candidates were evaluated');
  if (report.read_failure > maxReadFailure) reasons.push(`${report.read_failure} read failure(s) exceed the allowed ${maxReadFailure}`);
  if (report.unknown > maxUnknown) reasons.push(`${report.unknown} candidate(s) have unverified time, exceeding the allowed ${maxUnknown}`);
  if (report.unread > maxUnread) reasons.push(`${report.unread} candidate(s) were not read, exceeding the allowed ${maxUnread}`);
  if (report.both_satisfied < minBothSatisfied) reasons.push(`${report.both_satisfied} both-satisfied candidate(s) are below the required ${minBothSatisfied}`);
  return { passed: reasons.length === 0, reasons, thresholds: { maxReadFailure, maxUnknown, maxUnread, minBothSatisfied } };
}

export function evaluateNewsQuality(evaluation = {}) {
  const candidates = Array.isArray(evaluation.candidates) ? evaluation.candidates : [];
  const reads = evaluation.reads && typeof evaluation.reads === 'object' ? evaluation.reads : {};
  const bounds = windowBounds(evaluation.window);
  const entries = candidates.map(candidate => {
    const url = candidate?.url ?? '';
    const label = candidate?.label ?? 'unknown';
    const relevant = label === 'relevant';
    const read = reads[url];
    const hasRead = Boolean(read) && typeof read === 'object';
    const readOk = hasRead && read.ok === true;
    const readFailed = hasRead && read.ok !== true;
    const readStatus = readOk ? 'ok' : readFailed ? 'failed' : 'unread';
    const timeStatus = readOk ? classifySubmissionTime(read, bounds) : 'unverified';
    const category = primaryCategory({ readOk, readFailed, timeStatus, relevant });
    return {
      url,
      label,
      relevant,
      category,
      read_status: readStatus,
      time_status: timeStatus,
      published_at: readOk ? read.published_at ?? null : null,
      published_on: readOk ? read.published_on ?? null : null,
      precision: readOk ? read.precision ?? null : null,
      error: readOk
        ? null
        : readFailed
          ? read?.error ?? 'read unsuccessful'
          : 'not read (bounded PROBE_MAX_READS budget); page date not judged',
    };
  });

  const countCategory = name => entries.filter(entry => entry.category === name).length;
  const countPrecision = name => entries.filter(entry => entry.read_status === 'ok' && (entry.precision ?? null) === name).length;
  const report = {
    query: evaluation.query ?? null,
    language: evaluation.language ?? null,
    time_range: evaluation.time_range ?? null,
    window: bounds ? { start: new Date(bounds.start).toISOString(), end: new Date(bounds.end).toISOString() } : evaluation.window ?? null,
    // The denominator is every fixed candidate, so failures can never be hidden by counting only hits.
    denominator: entries.length,
    relevant: entries.filter(entry => entry.relevant).length,
    read_ok: entries.filter(entry => entry.read_status === 'ok').length,
    time_verified: entries.filter(entry => entry.time_status === 'within').length,
    both_satisfied: countCategory('both_satisfied'),
    irrelevant: countCategory('irrelevant'),
    stale: countCategory('stale'),
    unknown: countCategory('unknown'),
    read_failure: countCategory('read_failure'),
    unread: countCategory('unread'),
    // Publisher-instant precision actually proven by successful reads (instant/day/month/none).
    time_precision: { instant: countPrecision('instant'), day: countPrecision('day'), month: countPrecision('month'), none: countPrecision(null) },
    categories: CANDIDATE_CATEGORIES,
    entries,
  };
  report.failures = entries
    .filter(entry => entry.category === 'read_failure' || entry.category === 'unknown' || entry.category === 'unread')
    .map(entry => ({ url: entry.url, category: entry.category, error: entry.error ?? null }));
  report.gate = evaluateGate(report, evaluation.require ?? {});
  return report;
}
