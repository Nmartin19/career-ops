// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

import { decodeEntities } from './_html-entities.mjs';

// Remotive provider — board-wide aggregator feed
// (https://remotive.com/api/remote-jobs). Returns { jobs: [...] }. The full
// feed (no ?search=) is fetched so scan.mjs's title_filter can gate locally.
//
// Besides Career-Ops' core normalized fields, preserve useful source metadata
// so downstream adapters can build a richer canonical JobPosting without
// re-fetching the Remotive API.

const FEED_URL = 'https://remotive.com/api/remote-jobs';

/**
 * @param {unknown} html
 * @returns {string}
 */
function htmlToText(html) {
  if (typeof html !== 'string' || !html) return '';

  const cleaned = html
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
 * @param {unknown} value
 * @returns {number|undefined}
 */
function toEpochMs(value) {
  if (typeof value !== 'string' || !value.trim()) return undefined;

  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

/** @type {Provider} */
export default {
  id: 'remotive',

  /**
   * Fetches and normalizes postings from the Remotive public feed.
   * Core Career-Ops fields are preserved together with source-specific
   * metadata needed by downstream consumers.
   *
   * @param {{ name?: string }} entry - The job_boards entry being processed.
   * @param {{ fetchJson: (url: string, opts?: { redirect?: 'error'|'follow'|'manual' }) => Promise<any> }} ctx - HTTP context.
   */
  async fetch(entry, ctx) {
    // redirect:'error' prevents SSRF via server-side redirects
    const json = await ctx.fetchJson(FEED_URL, { redirect: 'error' });

    if (!json || !Array.isArray(json.jobs)) {
      throw new Error(
        `remotive: unexpected API response — expected { jobs: [...] }, got keys: [${json ? Object.keys(json).join(', ') : 'null'}]`,
      );
    }

    /** @type {any[]} */
    const jobs = json.jobs;

    return jobs
      .filter(j => j && typeof j === 'object'
        && typeof j.title === 'string' && j.title.trim() !== ''
        && typeof j.url === 'string' && /^https?:\/\//i.test(j.url.trim()))
      .map(j => ({
        // Career-Ops normalized contract
        title: j.title.trim(),
        url: j.url.trim(),
        company: typeof j.company_name === 'string' && j.company_name.trim()
          ? j.company_name.trim()
          : (entry.name || 'Remotive'),
        location: typeof j.candidate_required_location === 'string'
          ? j.candidate_required_location.trim()
          : '',
        description: htmlToText(j.description),
        postedAt: toEpochMs(j.publication_date),

        // Remotive-specific metadata preserved for downstream normalization
        sourceJobId: j.id != null ? String(j.id) : '',
        employmentTypeRaw: typeof j.job_type === 'string'
          ? j.job_type.trim()
          : '',
        salaryRaw: typeof j.salary === 'string'
          ? j.salary.trim()
          : '',
        tags: Array.isArray(j.tags)
          ? j.tags
              .filter((/** @type {unknown} */ tag) => typeof tag === 'string')
              .map((/** @type {string} */ tag) => tag.trim())
              .filter(Boolean)
          : [],
        category: typeof j.category === 'string'
          ? j.category.trim()
          : '',
        rawPayload: j,
      }));
  },
};