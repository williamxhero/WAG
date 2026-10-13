// Offline bridge only: reuse merged SPEC82 extraction and window policy, never fetch a URL.
import { readFileSync } from 'node:fs';
import { extractPageEvidence, normalizeUrlForDedup } from './evidence-metadata.mjs';
import { evaluateSpec82Evidence } from './spec82-evidence.mjs';
import { resolveNewsWindow } from './news-verified.mjs';

const request = JSON.parse(readFileSync(0, 'utf8'));
const window = resolveNewsWindow({ now: request.now, window: request.window ?? 'rolling_24h' });
function validUrl(value) {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password;
  } catch { return false; }
}

const results = request.records.map(record => {
  if (!validUrl(record.canonical_url)) throw new TypeError('Invalid document URL');
  const page = request.operation === 'extract'
    ? extractPageEvidence(record.html, record.page_url ?? record.canonical_url, {}, request.now, { chinesePublicationDates: true })
    : record.page;
  const evidence = evaluateSpec82Evidence(page, window, {
    auxiliary: record.auxiliary ?? [], checked_at: page.retrieved_at,
  });
  if (!validUrl(evidence.evidence_url) || normalizeUrlForDedup(evidence.evidence_url) !== normalizeUrlForDedup(record.canonical_url)) {
    evidence.status = 'unknown';
    evidence.reason = 'mismatched_evidence_url';
  }
  const retentionEvidence = evaluateSpec82Evidence(page, resolveNewsWindow({ now: request.now, window: 'calendar_today' }), {
    auxiliary: record.auxiliary ?? [], checked_at: page.retrieved_at,
  });
  const usable = !evidence.reason && ['E1', 'E2'].includes(retentionEvidence.evidence_level)
    && ['verified', 'out_of_window'].includes(retentionEvidence.status);
  const publication = usable ? retentionEvidence.published_at
    ?? (retentionEvidence.precision === 'day' ? `${retentionEvidence.published_on}T00:00:00+08:00` : null) : null;
  return { page, evidence, canonical_url: normalizeUrlForDedup(record.canonical_url), publication };
});
process.stdout.write(JSON.stringify(results));
