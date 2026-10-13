// SPEC82 offline page-only policy. No route integration, I/O, credentials or provider calls.
// SPEC78's separate controlled-feed policy is intentionally unchanged.
import { normalizePagePublicationDate, pagePublicationEvidenceLevel } from './evidence-metadata.mjs';
import { classifyVerifiedWindow } from './news-verified.mjs';

function evidenceLevel(record, allowPage) {
  const page = allowPage && record.kind === 'published_at' ? pagePublicationEvidenceLevel(record.source) : null;
  if (page) return page;
  if (/^(?:url\.|sitemap\.)/i.test(record.source ?? '')) return 'E3';
  if (/^(?:feed\.|searxng\.|api\.|provider\.|gdelt)/i.test(record.source ?? '')) return 'E4';
  return 'E5';
}

export function evaluateSpec82Evidence(pageEvidence = {}, window = {}, { auxiliary = [], checked_at = null } = {}) {
  const temporal = Array.isArray(pageEvidence.temporal_evidence) ? pageEvidence.temporal_evidence : [];
  const declarations = Array.isArray(pageEvidence.publication_candidates) ? pageEvidence.publication_candidates : temporal;
  const pageRecords = [...declarations, ...(declarations === temporal ? [] : temporal.filter(record => record.kind !== 'published_at'))];
  const records = [...pageRecords, ...auxiliary];
  const diagnostics = records.map((record, index) => {
    const parsed = normalizePagePublicationDate(record.raw ?? record.value ?? record.on);
    const valid = parsed && (parsed.precision === record.precision || (record.precision === 'unknown-timezone' && parsed.precision === 'day' && !record.value));
    return { ...record, evidence_level: evidenceLevel(record, index < pageRecords.length), valid_date: Boolean(valid), ...(valid ? { value: parsed.value, on: parsed.on } : {}) };
  });
  const page = diagnostics.find(record => ['E1', 'E2'].includes(record.evidence_level) && record.valid_date);
  const claim = diagnostics.find(record => record.evidence_level === 'E4' && (record.value || record.on));
  const conflicts = [...(Array.isArray(pageEvidence.conflicts) ? pageEvidence.conflicts : [])];
  if (page) {
    for (const record of diagnostics.filter(record => ['E1', 'E2', 'E3'].includes(record.evidence_level))) {
      const same = page.value && record.value ? page.value === record.value
        : page.precision === 'unknown-timezone' && record.precision === 'unknown-timezone' ? page.raw === record.raw
          : page.on && record.on ? page.on === record.on : true;
      if (!same && !conflicts.some(conflict => conflict.source === record.source && conflict.value === record.value && conflict.on === record.on && conflict.raw === record.raw)) conflicts.push(record);
    }
  }
  const conflict = conflicts.length > 0 || declarations.some(record => record.conflict);
  const verdict = page && !conflict ? classifyVerifiedWindow({ ...page, source_kind: 'page_publisher' }, window) : 'unknown';
  return {
    status: page ? (verdict === 'stale' ? 'out_of_window' : verdict) : claim ? 'claimed' : 'unknown',
    evidence_level: page?.evidence_level ?? claim?.evidence_level ?? (diagnostics.some(record => record.evidence_level === 'E3') ? 'E3' : 'E5'),
    source: page?.source ?? claim?.source ?? null,
    published_at: page?.value ?? null,
    published_on: page?.on ?? null,
    precision: page?.precision ?? null,
    evidence_url: pageEvidence.source?.url ?? null,
    checked_at,
    reason: conflict ? 'conflicting_evidence' : null,
    diagnostics,
    conflicts,
    conflict_count: conflicts.length,
  };
}
