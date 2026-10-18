// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

import { decodeEntities } from './_html-entities.mjs';

// Greenhouse provider — hits the public boards-api JSON endpoint.
// Handles both explicit `api:` URLs and auto-detection from `careers_url`.

const ALLOWED_GREENHOUSE_HOSTS = new Set([
  'boards-api.greenhouse.io',
  'boards.greenhouse.io',
  'job-boards.greenhouse.io',
  'job-boards.eu.greenhouse.io',
]);

const GREENHOUSE_CAREERS_HOSTS = new Set([
  'boards.greenhouse.io',
  'job-boards.greenhouse.io',
  'job-boards.eu.greenhouse.io',
]);

/** @param {string} url */
function assertGreenhouseUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`greenhouse: invalid URL: ${url}`);
  }
  if (parsed.protocol !== 'https:') throw new Error(`greenhouse: URL must use HTTPS: ${url}`);
  if (!ALLOWED_GREENHOUSE_HOSTS.has(parsed.hostname))
    throw new Error(`greenhouse: untrusted hostname "${parsed.hostname}" — must be one of: ${[...ALLOWED_GREENHOUSE_HOSTS].join(', ')}`);
  return parsed;
}

/**
 * Ask Greenhouse to include the full posting content while preserving every
 * other query parameter. URLSearchParams#set also replaces duplicate content
 * parameters, so the request has one authoritative content=true value.
 * @param {string} url
 */
function withContent(url) {
  const parsed = assertGreenhouseUrl(url);
  parsed.searchParams.set('content', 'true');
  parsed.searchParams.set('pay_transparency', 'true');
  return parsed.href;
}

/** @param {import('./_types.js').PortalEntry} entry */
function resolveApiUrl(entry) {
  if (entry.api) {
    return withContent(entry.api);
  }

  if (typeof entry.careers_url !== 'string') return null;

  let careersUrl;
  try {
    careersUrl = new URL(entry.careers_url);
  } catch {
    return null;
  }

  // Parse the URL structurally: a Greenhouse-looking substring in an
  // unrelated path/query/userinfo must never claim the entry.
  if (careersUrl.protocol !== 'https:' || !GREENHOUSE_CAREERS_HOSTS.has(careersUrl.hostname)) return null;

  const pathParts = careersUrl.pathname.split('/').filter(Boolean);
  let boardToken = pathParts[0];

  if (boardToken === 'embed') {
  if (pathParts[1] !== 'job_board') return null;
  boardToken = careersUrl.searchParams.get('for')?.trim() ?? '';
  }

  if (!boardToken || !/^[a-zA-Z0-9_-]+$/.test(boardToken)) {
  return null;
  }

  const apiUrl = new URL(`https://boards-api.greenhouse.io/v1/boards/${boardToken}/jobs`);
  apiUrl.searchParams.set('content', 'true');
  apiUrl.searchParams.set('pay_transparency', 'true');
  return apiUrl.href;
}

/**
 * Convert the HTML content Greenhouse includes in its list response into the
 * plain-text description consumed by scan.mjs. The original HTML remains
 * untouched in rawPayload.
 * @param {unknown} html
 */
function htmlToText(html) {
  if (typeof html !== 'string' || !html) return '';

  const decoded = html
  .replace(/&amp;lt;/gi, '&lt;')
  .replace(/&amp;gt;/gi, '&gt;')
  .replace(
    /&lt;(\/?(?:p|div|br|ul|ol|li|strong|em|b|i|h[1-6]|script|style)\b[^<>]*?)&gt;/gi,
    '<$1>',
  );
  const cleaned = decoded
    .replace(/<script\b[\s\S]*?<\/script\b[^>]*>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style\b[^>]*>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<\/li>/gi, '\n')
    .replace(/<[^>]*>/g, ' ');

  return decodeEntities(decodeEntities(cleaned))
    .replace(/[ \t]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** @param {unknown} value */
function sourceJobId(value) {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

// NaN-safe Date.parse — `|| undefined` would also coerce a valid epoch 0.
/** @param {string | null | undefined} value */
function toEpochMs(value) {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

/**
 * Normalize Greenhouse pay transparency ranges.
 * Preserve every valid range independently.
 * Original values remain available in rawPayload.
 *
 * @param {any} job
 * @returns {import('./_types.js').SalaryBand[]}
 */
export function parseGreenhouseSalaryBands(job) {
  const ranges = job?.pay_input_ranges;

  if (!Array.isArray(ranges)) return [];

  const bands = [];

  for (const range of ranges) {
    if (!range || typeof range !== 'object' || Array.isArray(range)) {
      continue;
    }

    const currency = typeof range.currency_type === 'string'
      ? range.currency_type.trim().toUpperCase()
      : '';

    if (!/^[A-Z]{3}$/.test(currency)) continue;

    // Do not assume that every currency uses two decimal places.
    if (!Intl.supportedValuesOf('currency').includes(currency)) {
      continue;
    }

    const minorDigits = new Intl.NumberFormat('en', {
      style: 'currency',
      currency,
    }).resolvedOptions().maximumFractionDigits;

    if (minorDigits === undefined) continue;

const divisor = 10 ** minorDigits;

    // Reject malformed or unsafe amounts.
    /** @param {unknown} value */
const validAmount = (value) =>
  value == null ||
  (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 0
  );

    if (
      !validAmount(range.min_cents) ||
      !validAmount(range.max_cents)
    ) {
      continue;
    }

    // Greenhouse uses zero for ranges that are not filled in.
    const minValue =
      range.min_cents == null || range.min_cents === 0
        ? null
        : range.min_cents / divisor;

    const maxValue =
      range.max_cents == null || range.max_cents === 0
        ? null
        : range.max_cents / divisor;

    if (minValue === null && maxValue === null) {
      continue;
    }

    if (
      minValue !== null &&
      maxValue !== null &&
      minValue > maxValue
    ) {
      continue;
    }

    const tierName =
      typeof range.title === 'string'
        ? range.title.trim()
        : '';

    // Infer periodicity only from unambiguous source wording.
    const interval = /\bannual\b/i.test(tierName)
      ? '1 YEAR'
      : /\bhourly\b/i.test(tierName)
        ? '1 HOUR'
        : undefined;

    bands.push({
      tierName,
      minValue,
      maxValue,
      currencyCode: currency,
      ...(interval ? { interval } : {}),
    });
  }

  return bands;
}

/** @type {Provider} */
export default {
  id: 'greenhouse',

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
    if (!apiUrl) throw new Error(`greenhouse: cannot derive API URL for ${entry.name}`);
    assertGreenhouseUrl(apiUrl);
    // redirect:'error' prevents SSRF via server-side redirects; combined with
    // assertGreenhouseUrl above it guarantees the final hostname stays in the allowlist.
    const json = /** @type {any} */ (await ctx.fetchJson(apiUrl, { redirect: 'error' }));
    const jobs = Array.isArray(json?.jobs) ? json.jobs : [];
    return jobs.filter(/** @param {any} j */ j => j && typeof j === 'object' && j.absolute_url).map(/** @param {any} j */ j => ({
      title: j.title || '',
      url: j.absolute_url,
      company: entry.name,
      location: j.location?.name || '',
      sourceJobId: sourceJobId(j.id) || '',
      description: htmlToText(j.content),
      salaryBands: parseGreenhouseSalaryBands(j),
      postedAt: toEpochMs(j.first_published),
      rawPayload: j,
    }));
  },
};
