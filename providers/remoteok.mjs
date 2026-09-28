// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */
import { decodeEntities } from './_html-entities.mjs';

// RemoteOK provider — board-wide aggregator feed (https://remoteok.com/api).
// Returns the latest ~100 remote postings as a JSON array; index 0 is a
// {last_updated, legal} metadata object and is skipped. scan.mjs applies the
// configured title_filter / location_filter to the returned rows.
//
// Wire in via a `job_boards:` entry with `provider: remoteok`.
// RemoteOK API ToS asks for a follow link-back when republishing — N/A for
// private scanning, but don't redistribute this feed publicly without it.

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
 * @param {string[]} tags
 * @returns {string}
 */
function employmentTypeFromTags(tags) {
  if (tags.includes('internship') || tags.includes('intern')) return 'internship';
  if (tags.includes('contract')) return 'contractor';
  if (tags.includes('freelance')) return 'freelance';
  if (tags.includes('temporary')) return 'temporary';

  return '';
}

/**
 * @param {string[]} tags
 * @returns {string}
 */
function workingTimeFromTags(tags) {
  if (tags.includes('full time')) return 'full_time';
  if (tags.includes('part time')) return 'part_time';

  return '';
}

/**
 * @param {unknown} epoch
 * @param {unknown} date
 * @returns {number | undefined}
 */

function toEpochMs(epoch, date) {
  if (typeof epoch === 'number' && Number.isFinite(epoch))
    return epoch * 1000;

  if (typeof date === 'string' && date.trim()) {
    const timestamp = Date.parse(date.trim());
    if (Number.isFinite(timestamp)) return timestamp;
  }

  return undefined;
}

const FEED_URL = 'https://remoteok.com/api';

/** @type {Provider} */
export default {
  id: 'remoteok',

  /**
   * Fetches and normalizes postings from the RemoteOK public feed.
   * @param {{ name?: string }} entry - The job_boards entry being processed.
   * @param {{ fetchJson: (url: string, opts?: { redirect?: 'error'|'follow'|'manual' }) => Promise<any> }} ctx - HTTP context.
   * @returns {Promise<Array<{title: string, url: string, company: string, location: string, sourceJobId: string, description: string, postedAt: number|undefined, employmentTypeRaw: string, tags: string[], rawPayload: any}>>}
   */
  async fetch(entry, ctx) {
    // redirect:'error' prevents SSRF via server-side redirects
    const data = await ctx.fetchJson(FEED_URL, { redirect: 'error' });
    if (!Array.isArray(data)) {
      throw new Error(`remoteok: unexpected API response — expected a JSON array, got ${data === null ? 'null' : typeof data}`);
    }

    return data
      .filter(j => j && typeof j === 'object'
        && typeof j.position === 'string' && j.position.trim() !== ''
        && typeof j.url === 'string' && /^https?:\/\//i.test(j.url.trim()))
            .map(j => {
        const tags = normalizeTags(j.tags);

        return {
          title: j.position.trim(),
          url: j.url.trim(),
          company: typeof j.company === 'string' && j.company.trim() ? j.company.trim() : (entry.name || 'RemoteOK'),
          location: typeof j.location === 'string' ? j.location.trim() : '',
          sourceJobId: j.id != null ? String(j.id) : '',
          description: htmlToText(j.description),
          postedAt: toEpochMs(j.epoch, j.date),
          employmentTypeRaw: employmentTypeFromTags(tags),
          workingTimeRaw: workingTimeFromTags(tags),
          tags,
          rawPayload: j,
        };
      });
  },
};
