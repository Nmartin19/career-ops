// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */
import { decodeEntities } from './_html-entities.mjs';

// Arbeitnow provider — board-wide aggregator feed (EU/DACH-heavy, but
// international): https://www.arbeitnow.com/api/job-board-api
// Response shape: { data: [ { slug, company_name, title, description, remote,
//   url, tags, job_types, location, created_at } ], links, meta }
//
// Jobs are ordered newest-first. Page sizes may vary; page URLs are built
// directly as `?page=N` rather than following links.next, keeping pagination
// deterministic and avoiding query parameters that could narrow the board.
// Pages are fetched until one comes back short/empty or the page cap is reached
// (default 3, override with `max_pages` on the portal entry).
//
// Wire in via a `job_boards:` entry with `provider: arbeitnow`.

const FEED_BASE = 'https://www.arbeitnow.com/api/job-board-api';
const TRUSTED_HOSTS = new Set(['www.arbeitnow.com', 'www.arbeitnow.co.uk']);
const PER_PAGE = 100;
const DEFAULT_MAX_PAGES = 3;
const MAX_PAGES_CAP = 50;

/** @param {string} url */
function assertArbeitnowUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`arbeitnow: invalid URL: ${url}`);
  }
  if (parsed.protocol !== 'https:') throw new Error(`arbeitnow: URL must use HTTPS: ${url}`);
  if (!TRUSTED_HOSTS.has(parsed.hostname)) {
    throw new Error(`arbeitnow: untrusted hostname "${parsed.hostname}" — allowed: ${[...TRUSTED_HOSTS].join(', ')}`);
  }
  return url;
}

/** Resolve the page cap: a positive integer `max_pages` on the entry, capped. */
/** @param {{ max_pages?: number } | undefined} entry */
function resolveMaxPages(entry) {
  const v = entry?.max_pages;
  if (typeof v === 'number' && Number.isInteger(v) && v > 0) return Math.min(v, MAX_PAGES_CAP);
  return DEFAULT_MAX_PAGES;
}

/**
 * @param {unknown} html
 * @returns {string}
 */
function htmlToText(html) {
  if (typeof html !== 'string' || !html) return '';

  const decoded = decodeEntities(html);
  const cleaned = decoded
    .replace(/<script\b[\s\S]*?<\/script\b[^>]*>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style\b[^>]*>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<\/li>/gi, '\n')
    .replace(/<[^>]*>/g, ' ');

  return decodeEntities(cleaned)
    .replace(/[ \t]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * @param {unknown} tags
 * @returns {string[]}
 */
function normalizeTags(tags) {
  if (!Array.isArray(tags)) return [];

  return tags
    .filter((/** @type {unknown} */ tag) => typeof tag === 'string')
    .map((/** @type {string} */ tag) => tag.trim())
    .filter(Boolean);
}

/**
 * @param {unknown} jobTypes
 * @returns {string}
 */
function employmentTypeFromJobTypes(jobTypes) {
  const types = normalizeTags(jobTypes)
    .map(type => type.toLowerCase());

  if (types.some(type => type === 'intern' || type.includes('internship'))) return 'internship';
  if (types.some(type => type.includes('freelance'))) return 'freelance';
  if (types.some(type => type.includes('temporary'))) return 'temporary';
  if (types.some(type => type.includes('permanent'))) return 'permanent';
  if (types.some(type => type.includes('contract'))) return 'contractor';

  return '';
}

/**
 * @param {unknown} jobTypes
 * @returns {string}
 */
function workingTimeFromJobTypes(jobTypes) {
  const types = normalizeTags(jobTypes)
    .map(type => type.toLowerCase());

  const explicitTypes = types
    .filter(type => !type.includes('full or part time'));

  if (explicitTypes.some(type => /\bpart[- ]?time\b|\bparttime\b/.test(type))) return 'part_time';
  if (explicitTypes.some(type => /\bfull[- ]?time\b|\bfulltime\b/.test(type))) return 'full_time';

  return '';
}

/**
 * @param {any} j
 * @param {string} [fallbackCompany]
 */
export function normalizeArbeitnowJob(j, fallbackCompany) {
  if (!j || typeof j !== 'object') return null;

  const title = typeof j.title === 'string' ? j.title.trim() : '';
  if (!title) return null;

  // URL must be an absolute HTTPS posting link on a trusted Arbeitnow host.
  // Any other host is untrusted and the item is dropped.
  let url = '';
  const rawUrl = typeof j.url === 'string' ? j.url.trim() : '';
  if (rawUrl) {
    try {
      const parsed = new URL(rawUrl);
      if (parsed.protocol === 'https:' && TRUSTED_HOSTS.has(parsed.hostname)) url = parsed.href;
    } catch {
      // malformed URL → leave url = '' → dropped below
    }
  }
  if (!url) return null;

  const company =
    typeof j.company_name === 'string' && j.company_name.trim()
      ? j.company_name.trim()
      : fallbackCompany || 'Arbeitnow';

  const baseLocation = typeof j.location === 'string' ? j.location.trim() : '';
  const location = [baseLocation, j.remote === true ? 'Remote' : ''].filter(Boolean).join(', ');

  const tags = normalizeTags(j.tags);

  /** @type {{
   * title: string,
   * url: string,
   * company: string,
   * location: string,
   * sourceJobId: string,
   * description: string,
   * employmentTypeRaw: string,
   * workingTimeRaw: string,
   * tags: string[],
   * rawPayload: any,
   * postedAt?: number
   * }} */
  const job = {
    title,
    url,
    company,
    location,
    sourceJobId: typeof j.slug === 'string' ? j.slug.trim() : '',
    description: htmlToText(j.description),
    employmentTypeRaw: employmentTypeFromJobTypes(j.job_types),
    workingTimeRaw: workingTimeFromJobTypes(j.job_types),
    tags,
    rawPayload: j,
  };

  if (Number.isFinite(j.created_at)) job.postedAt = j.created_at * 1000;
  return job;
}

/** @type {Provider} */
export default {
  id: 'arbeitnow',

  async fetch(entry, ctx) {
    assertArbeitnowUrl(FEED_BASE);
    const maxPages = resolveMaxPages(entry);
    const fallbackCompany = entry?.name;
    const out = [];

    for (let page = 1; page <= maxPages; page++) {
      // Build the page URL directly (do NOT follow links.next — it carries a
      // featured `?search=` term that would narrow the board).
      const url = `${FEED_BASE}?page=${page}`;
      // redirect:'error' prevents SSRF via server-side redirects
      const json = /** @type {any} */ (await ctx.fetchJson(url, { redirect: 'error' }));
      if (!json || !Array.isArray(json.data)) {
        throw new Error(
          `arbeitnow: unexpected API response on page ${page} — expected { data: [...] }, got keys: [${json ? Object.keys(json).join(', ') : 'null'}]`,
        );
      }
      for (const j of json.data) {
        const normalized = normalizeArbeitnowJob(j, fallbackCompany);
        if (normalized) out.push(normalized);
      }
      if (json.data.length < PER_PAGE) break; // short page → last page reached
    }
    return out;
  },
};
