// SPEC #78 stage A: offline, bounded RSS/Atom parser for the verified-news feed catalog.
//
// Security posture: this parser never fetches anything and never resolves external or network
// entities. Any document carrying a DTD (`<!DOCTYPE` / `<!ENTITY`) is rejected outright, which also
// removes the classic entity-expansion ("billion laughs") and external-entity vectors. On top of that
// it enforces raw byte, element, nesting-depth and item-count budgets before the caller can be
// exposed to an oversized or deeply nested document.
//
// Date semantics are item-scoped: Atom `published` (not `updated`) and RSS item `pubDate` (not the
// channel `lastBuildDate`) are publication evidence. Feed-level freshness fields are returned under
// `feed` and are marked diagnostic — they can never reach a verified result.

import { JSDOM } from 'jsdom';

export const FEED_LIMITS = Object.freeze({
  maxBytes: 512 * 1024,
  maxItems: 100,
  maxDepth: 64,
  maxElements: 5000,
});

const RDF_NS = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

function limitValue(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function resolvedLimits(options = {}) {
  return {
    maxBytes: limitValue(options.maxBytes, FEED_LIMITS.maxBytes),
    maxItems: limitValue(options.maxItems, FEED_LIMITS.maxItems),
    maxDepth: limitValue(options.maxDepth, FEED_LIMITS.maxDepth),
    maxElements: limitValue(options.maxElements, FEED_LIMITS.maxElements),
  };
}

function civilDay(year, month, day) {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

// Parses one feed date into `{ value, on, precision }`. A timezone-bearing moment becomes an
// `instant`; a bare calendar date is `day`; a time-of-day without an offset keeps its civil date but
// stays `unknown-timezone` (no fabricated UTC instant). Anything unparseable returns null.
export function parseFeedDate(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    return civilDay(...raw.split('-').map(Number)) ? { value: null, on: raw, precision: 'day' } : null;
  }
  if (/^\d{4}-\d{2}$/.test(raw)) {
    const on = `${raw}-01`;
    return civilDay(...on.split('-').map(Number)) ? { value: null, on: raw, precision: 'month' } : null;
  }
  const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(raw) || /\b(?:GMT|UTC)\b/i.test(raw);
  if (hasZone) {
    const normalized = raw.replace(/([+-]\d{2})(\d{2})$/, '$1:$2').replace(/\bUTC\b/i, 'GMT');
    const milliseconds = Date.parse(normalized);
    if (Number.isFinite(milliseconds)) {
      const iso = new Date(milliseconds).toISOString();
      return { value: iso, on: iso.slice(0, 10), precision: 'instant' };
    }
    return null;
  }
  // Anchored time-of-day without an offset: the civil date is real, the instant is not.
  const isoLike = /^(\d{4}-\d{2}-\d{2})[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/.exec(raw);
  if (isoLike && civilDay(...isoLike[1].split('-').map(Number))) {
    return { value: null, on: isoLike[1], precision: 'unknown-timezone' };
  }
  // RFC822 without a zone, e.g. "Mon, 06 Oct 2025 12:00:00".
  const rfc = /^[A-Za-z]{3},\s*(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})\b/.exec(raw);
  if (rfc && MONTHS[rfc[2].toLowerCase()]) {
    const on = civilDay(Number(rfc[3]), MONTHS[rfc[2].toLowerCase()], Number(rfc[1]));
    if (on) return { value: null, on, precision: 'unknown-timezone' };
  }
  return null;
}

// Bounded structural walk: counts elements and rejects a document that nests past `maxDepth` or
// holds more than `maxElements` nodes, without recursing (so a hostile depth cannot blow the stack).
function inspectStructure(root, { maxDepth, maxElements }) {
  let elements = 0;
  let deepest = 0;
  const stack = [{ node: root, depth: 1 }];
  while (stack.length) {
    const { node, depth } = stack.pop();
    elements += 1;
    if (depth > deepest) deepest = depth;
    if (depth > maxDepth) return { elements, depth: deepest, exceeded: 'too_deep' };
    if (elements > maxElements) return { elements, depth: deepest, exceeded: 'too_many_elements' };
    for (const child of node.children) stack.push({ node: child, depth: depth + 1 });
  }
  return { elements, depth: deepest, exceeded: null };
}

function childElements(node, name) {
  return [...node.children].filter(child => child.localName === name);
}

function firstChildText(node, name) {
  const child = childElements(node, name)[0];
  return child ? child.textContent.trim() : '';
}

function atomLink(entry) {
  const links = childElements(entry, 'link');
  const alternate = links.find(link => (link.getAttribute('rel') ?? 'alternate') === 'alternate' && link.getAttribute('href'));
  return (alternate ?? links.find(link => link.getAttribute('href')))?.getAttribute('href') ?? null;
}

function rssLink(item) {
  const link = firstChildText(item, 'link');
  if (link) return link;
  return item.getAttribute('rdf:about') ?? item.getAttributeNS(RDF_NS, 'about') ?? null;
}

// Publication candidates for one item, in document order — the full list is kept so a duplicate that
// disagrees is recorded as a conflict rather than silently last-write-wins.
function itemDateCandidates(item, format) {
  const published = [];
  const updated = [];
  for (const child of item.children) {
    const name = child.localName;
    const text = child.textContent;
    if (format === 'atom') {
      if (name === 'published') published.push({ source: 'feed.item.published', parsed: parseFeedDate(text) });
      else if (name === 'updated') updated.push({ source: 'feed.item.updated', parsed: parseFeedDate(text) });
    } else if (name === 'pubDate') {
      published.push({ source: 'feed.item.pubDate', parsed: parseFeedDate(text) });
    } else if (name === 'date') {
      // dc:date — the RSS 1.0 item publication field.
      published.push({ source: 'feed.item.date', parsed: parseFeedDate(text) });
    }
  }
  return { published, updated };
}

function pickDate(candidates) {
  for (const candidate of candidates) {
    if (candidate.parsed) return { ...candidate.parsed, source: candidate.source };
  }
  return null;
}

function countConflicts(candidates, primary) {
  const primaryKey = primary ? primary.value ?? primary.on : null;
  const seen = new Set([primaryKey]);
  let conflicts = 0;
  for (const candidate of candidates) {
    if (!candidate.parsed) continue;
    const key = candidate.parsed.value ?? candidate.parsed.on;
    if (seen.has(key)) continue;
    seen.add(key);
    conflicts += 1;
  }
  return conflicts;
}

function parseItem(item, format) {
  const { published: publishedCandidates, updated: updatedCandidates } = itemDateCandidates(item, format);
  const published = pickDate(publishedCandidates);
  const updated = pickDate(updatedCandidates);
  return {
    title: firstChildText(item, 'title') || null,
    link: (format === 'atom' ? atomLink(item) : rssLink(item)) ?? null,
    published,
    updated,
    conflicts: countConflicts(publishedCandidates, published),
    date_missing: published === null,
  };
}

// Feed-level freshness. Diagnostic only: `last_build` / `updated` describe the feed document, never a
// published item, so they can never become verified evidence.
function feedFreshness(format, root) {
  const scope = format === 'atom' ? root : (childElements(root, 'channel')[0] ?? root);
  const field = (name, source) => {
    const parsed = parseFeedDate(firstChildText(scope, name));
    return parsed ? { ...parsed, source, diagnostic: true } : null;
  };
  if (format === 'atom') {
    return {
      title: firstChildText(root, 'title') || null,
      updated: field('updated', 'feed.updated'),
      published: field('published', 'feed.published'),
      last_build: null,
    };
  }
  return {
    title: firstChildText(scope, 'title') || null,
    updated: null,
    published: field('pubDate', 'feed.pubDate'),
    last_build: field('lastBuildDate', 'feed.lastBuildDate'),
  };
}

// Parses an RSS 2.0 / RSS 1.0 (RDF) / Atom document. Never throws for malformed input: an unsafe,
// oversized, malformed or unsupported document returns `{ ok: false, error }` so callers can classify
// a source failure without a try/catch around untrusted bytes.
export function parseNewsFeed(xml, options = {}) {
  const limits = resolvedLimits(options);
  const base = { ok: false, format: null, error: null, feed: null, items: [], limited: false, inspected_elements: 0, limits };
  if (typeof xml !== 'string' || xml.trim() === '') return { ...base, error: 'empty' };
  if (Buffer.byteLength(xml, 'utf8') > limits.maxBytes) return { ...base, error: 'feed_too_large' };
  if (/<!doctype/i.test(xml) || /<!entity/i.test(xml)) return { ...base, error: 'unsafe_xml' };

  let document;
  try {
    document = new JSDOM(xml, { contentType: 'text/xml' }).window.document;
  } catch {
    return { ...base, error: 'malformed_xml' };
  }
  const root = document.documentElement;
  if (!root || document.querySelector('parsererror')) return { ...base, error: 'malformed_xml' };

  const structure = inspectStructure(root, limits);
  if (structure.exceeded) return { ...base, error: structure.exceeded, inspected_elements: structure.elements };

  const rootName = root.localName;
  const format = rootName === 'feed' ? 'atom' : rootName === 'rss' || rootName === 'RDF' ? 'rss' : null;
  if (!format) return { ...base, error: 'unsupported_feed', inspected_elements: structure.elements };

  const nodes = [...root.querySelectorAll(format === 'atom' ? 'entry' : 'item')];
  const limited = nodes.length > limits.maxItems;
  const items = nodes.slice(0, limits.maxItems).map(node => parseItem(node, format));
  return {
    ok: true,
    format,
    error: null,
    feed: feedFreshness(format, root),
    items,
    limited,
    inspected_elements: structure.elements,
    limits,
  };
}
