// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

import { decodeEntities } from './_html-entities.mjs';

// Lever provider — hits the public postings endpoint.
// Auto-detects from careers_url via jobs.(eu.)?lever.co/<slug>.
// Handles both explicit `api:` URLs and auto-detection from `careers_url`.

const ALLOWED_LEVER_HOSTS = new Set(['api.lever.co', 'api.eu.lever.co']);
const PAGE_SIZE = 100;
const DEFAULT_MAX_PAGES = 50;
const HARD_MAX_PAGES = 200;

/** Reject ambiguous paths before URL parsing can normalize traversal away.
 * @param {string} url
 */
function unsafePath(url) {
  const path = url.split(/[?#]/)[0];
  return /[\u0000-\u0020%\\]/.test(path) || /(?:^|\/)\.{1,2}(?:\/|$)/.test(path);
}

/** @param {string} url */
function assertLeverUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`lever: invalid URL: ${url}`);
  }
  if (parsed.protocol !== 'https:') throw new Error(`lever: URL must use HTTPS: ${url}`);
  if (!ALLOWED_LEVER_HOSTS.has(parsed.hostname))
    throw new Error(`lever: untrusted hostname "${parsed.hostname}" — must be one of: ${[...ALLOWED_LEVER_HOSTS].join(', ')}`);
  if (parsed.username || parsed.password || parsed.port || parsed.hash || unsafePath(url)
      || !/^\/v0\/postings\/[a-zA-Z0-9_-]+\/?$/.test(parsed.pathname)) {
    throw new Error('lever: invalid API board path or URL authority');
  }
  return parsed;
}

/** @param {import('./_types.js').PortalEntry} entry */
function resolveApiUrl(entry) {
  // Explicit api: wins — lets an entry keep a human-facing corporate
  // careers_url (e.g. https://www.coalfire.com/careers) while still pinning
  // the Lever postings board (mirrors greenhouse's api: precedence).
  if (entry.api) {
    assertLeverUrl(entry.api);
    return entry.api;
  }
  let url;
  try {
    url = new URL(entry.careers_url || '');
  } catch {
    return null;
  }
  const host = url.hostname.match(/^jobs\.((?:eu\.)?lever\.co)$/);
  if (!host || url.protocol !== 'https:' || url.username || url.password || url.port
      || unsafePath(entry.careers_url)
      || !/^\/[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*\/?$/.test(url.pathname)) return null;
  const slug = url.pathname.split('/').filter(Boolean)[0];
  if (!slug) return null;
  return `https://api.${host[1]}/v0/postings/${slug}`;
}

/** @param {unknown} value */
function text(value) {
  return typeof value === 'string' ? value : '';
}

/** Require a usable scanner deduplication key without repairing source URLs.
 * @param {string} value
 */
function validPostingUrl(value) {
  if (!/^https?:\/\//i.test(value) || /[\s\\]/.test(value)) return false;
  try {
    const url = new URL(value);
    return Boolean(url.hostname) && !url.username && !url.password;
  } catch {
    return false;
  }
}

/** Lists carry HTML in Lever's list response; retain boundaries and entities.
 * @param {unknown} value
 */
function htmlToText(value) {
  return decodeEntities(text(value)
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<br\s*\/?>|<\/(?:p|div|ul|ol|h[1-6])\s*>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '- ')
    .replace(/<\/li\s*>/gi, '\n')
    .replace(/<[^>]*>/g, ' '))
    .replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').trim();
}

/** @param {any} job */
function fullDescription(job) {
  const sections = [text(job.descriptionPlain).trim()];
  if (Array.isArray(job.lists)) {
    for (const list of job.lists) {
      if (!list || typeof list !== 'object') continue;
      sections.push(text(list.text).trim(), htmlToText(list.content));
    }
  }
  sections.push(text(job.additionalPlain).trim());
  return [...new Set(sections.filter(Boolean))].join('\n\n');
}

/** Source units only: no cents division, annualization, or repaired ranges.
 * Missing endpoints become null; malformed endpoints invalidate the band.
 * @param {any} job
 * @returns {import('./_types.js').SalaryBand[]}
 */
export function parseLeverSalaryBands(job) {
  const range = job?.salaryRange;
  if (!range || typeof range !== 'object' || Array.isArray(range)) return [];
  /** @param {unknown} value */
  const valid = value => value == null
    || (typeof value === 'number' && Number.isFinite(value) && value >= 0);
  if (!valid(range.min) || !valid(range.max)) return [];
  const minValue = range.min ?? null;
  const maxValue = range.max ?? null;
  if ((minValue === null && maxValue === null)
      || (minValue !== null && maxValue !== null && minValue > maxValue)) return [];
  return [{
    minValue, maxValue,
    ...(text(range.currency).trim() ? { currencyCode: range.currency } : {}),
    ...(text(range.interval).trim() ? { interval: range.interval } : {}),
  }];
}

/** @param {any} j @param {string} company */
function normalizeJob(j, company) {
  const categories = j.categories;
  const locations = [categories?.location,
    ...(Array.isArray(categories?.allLocations) ? categories.allLocations : [])]
    .filter(value => typeof value === 'string' && value.trim()).map(value => value.trim());
  return {
    title: text(j.text),
    url: text(j.hostedUrl),
    company,
    location: [...new Set(locations)].join(' · '),
    sourceJobId: typeof j.id === 'string' ? j.id.trim()
      : typeof j.id === 'number' && Number.isFinite(j.id) ? String(j.id) : '',
    description: fullDescription(j),
    workplaceTypeRaw: text(j.workplaceType),
    salaryBands: parseLeverSalaryBands(j),
    postedAt: typeof j.createdAt === 'number' && Number.isFinite(j.createdAt)
      && Number.isFinite(new Date(j.createdAt).getTime()) ? j.createdAt : undefined,
    // categories (including allLocations), country and applyUrl remain exact,
    // including fields not represented by Job or the JSON serializer.
    rawPayload: j,
  };
}

/** @type {Provider} */
export default {
  id: 'lever',

  detect(entry) {
    try {
      const apiUrl = resolveApiUrl(entry);
      return apiUrl ? { url: apiUrl } : null;
    } catch {
      return null;
    }
  },

  async fetch(entry, ctx) {
    const apiUrl = resolveApiUrl(entry);
    if (!apiUrl) throw new Error(`lever: cannot derive API URL for ${entry.name}`);
    const url = assertLeverUrl(apiUrl);
    const limitParam = url.searchParams.get('limit');
    const skipParam = url.searchParams.get('skip');
    const limit = limitParam === null ? PAGE_SIZE : Number(limitParam);
    let skip = skipParam === null ? 0 : Number(skipParam);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > PAGE_SIZE
        || !Number.isSafeInteger(skip) || skip < 0
        || limitParam?.trim() === '' || skipParam?.trim() === '') {
      throw new Error('lever: invalid pagination limit or skip');
    }
    /** @param {number | undefined} value */
    const positiveCap = value => typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : Infinity;
    const maxPages = Math.min(HARD_MAX_PAGES,
      positiveCap(entry.max_pages) === Infinity ? DEFAULT_MAX_PAGES : entry.max_pages,
      positiveCap(ctx.maxPages));
    const jobs = [];
    const seen = new Set();
    const seenPages = new Set();
    for (let page = 0; page < maxPages; page++) {
      url.searchParams.set('mode', 'json');
      url.searchParams.set('limit', String(limit));
      url.searchParams.set('skip', String(skip));
      let json;
      try {
        json = await ctx.fetchJson(url.href, { redirect: 'error', headers: { Accept: 'application/json' } });
        if (!Array.isArray(json)) {
          throw new Error(`lever: ${entry.name}: invalid postings response (expected an array)`);
        }
      } catch (error) {
        if (page === 0) throw error;
        // The array-only Provider contract has no completeness flag. Keep the
        // successful prefix and warn explicitly rather than lose it or imply completeness.
        console.warn(`lever: ${entry.name}: partial results (${jobs.length} jobs); page ${page + 1} failed`, error);
        return jobs;
      }
      if (json.length === 0) return jobs;
      const fingerprint = JSON.stringify(json);
      if (seenPages.has(fingerprint)) {
        console.warn(`lever: ${entry.name}: partial results; repeated page ${page + 1}`);
        return jobs;
      }
      seenPages.add(fingerprint);
      let added = 0;
      for (const j of json) {
        if (!j || typeof j !== 'object' || Array.isArray(j)) continue;
        const job = normalizeJob(j, entry.name);
        // An ID alone cannot identify a posting for the scanner's URL dedup.
        // Validate before reserving any identity keys from this row.
        if (!validPostingUrl(job.url)) continue;
        const keys = [job.sourceJobId ? `id:${job.sourceJobId}` : '', job.url ? `url:${job.url}` : ''].filter(Boolean);
        const duplicate = keys.some(key => seen.has(key));
        if (duplicate) continue;
        // Only accepted postings establish identity; discarded aliases must
        // not suppress a later posting with an otherwise unseen ID or URL.
        keys.forEach(key => seen.add(key));
        jobs.push(job);
        added++;
      }
      if (json.length < limit) return jobs;
      if (!added || page + 1 === maxPages || !Number.isSafeInteger(skip + limit)) {
        console.warn(`lever: ${entry.name}: partial results (${jobs.length} jobs); pagination stopped at page ${page + 1}`);
        return jobs;
      }
      skip += limit;
    }
    return jobs;
  },
};
