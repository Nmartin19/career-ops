// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// Ashby provider — hits the public posting-api endpoint.
// Auto-detects from careers_url pattern `https://jobs.ashbyhq.com/<slug>`.
//
// Ashby's public posting-api carries a ~10s+ server-side latency floor
// (response time is independent of board size) and rate-limits repeated
// unauthenticated hits. The global default timeout (10s, providers/_http.mjs)
// sits right on that floor, so requests race the timeout and abort. We give
// Ashby a longer timeout plus a backoff+jitter retry (the backoff spaces
// requests out to dodge rate-limiting).
// See .planning/codebase/ashby-scan-abort-diagnosis.md.
const ASHBY_TIMEOUT_MS = 30_000;
const ASHBY_RETRIES = 2;

// Annualization multipliers for different compensation intervals
const INTERVAL_MULTIPLIERS = {
  '1 HOUR': 2080,
  '1 DAY': 260,
  '1 WEEK': 52,
  '2 WEEK': 26,
  '0.5 MONTH': 24,
  '1 MONTH': 12,
  '2 MONTH': 6,
  '3 MONTH': 4,
  '6 MONTH': 2,
  '1 YEAR': 1,
};

/**
 * Parse compensation data from Ashby job object.
 * Returns structured salary object with min, max, and currency,
 * or null if no valid compensation data exists.
 * @param {any} job - Ashby job object
 * @returns {{min: number, max: number, currency: string}|null}
 */
export function parseCompensation(job) {
  const comp = job?.compensation;
  if (!comp) return null;

  const interval = /** @type {keyof typeof INTERVAL_MULTIPLIERS} */ (comp.interval || '1 YEAR');
  const multiplier = INTERVAL_MULTIPLIERS[interval];
  if (!multiplier) return null;

  // Coerce and validate numeric fields — malformed API payloads must not propagate
  /** @param {any} v */
  const normalizeNum = (v) => {
    if (v == null) return null;
    if (typeof v === 'string' && v.trim() === '') return null;
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : null;
  };
  const minValue = normalizeNum(comp.minValue);
  const maxValue = normalizeNum(comp.maxValue);
  const currency = typeof comp.currency === 'string' ? comp.currency.trim() : '';

  // If neither min nor max is provided, no valid compensation
  if (minValue == null && maxValue == null) return null;

  // Annualize the values
  const min = minValue != null ? minValue * multiplier : null;
  const max = maxValue != null ? maxValue * multiplier : null;

  // Must have at least one valid annual value
  if (min == null && max == null) return null;

  // Ensure correct ordering (min <= max)
  const resolvedMin = /** @type {number} */ (min ?? max);
  const resolvedMax = /** @type {number} */ (max ?? min);
  return {
    min: Math.min(resolvedMin, resolvedMax),
    max: Math.max(resolvedMin, resolvedMax),
    currency: currency.toUpperCase(),
  };
}

/**
 * Preserve one optional string from an Ashby compensation tier. Ashby uses
 * null for unavailable tier metadata; malformed non-string values are treated
 * as unavailable while the untouched value remains available in rawPayload.
 * @param {any} value
 * @returns {string|null}
 */
function normalizeTierString(value) {
  if (value == null) return null;
  if (typeof value !== 'string') return null;
  return value;
}

/**
 * Normalize a salary-band amount without coercion. `undefined` means the
 * source value was invalid; `null` means Ashby explicitly omitted the amount.
 * @param {any} value
 * @returns {number|null|undefined}
 */
function normalizeBandAmount(value) {
  if (value == null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined;
  return value;
}

/**
 * Extract unambiguous Salary components from Ashby compensation tiers.
 * Amounts and intervals stay in their source units; annualization belongs only
 * to the legacy/simple salary fields. Invalid or ambiguous tiers are skipped
 * without affecting the surrounding job, whose original data remains in
 * rawPayload.
 * @param {any} job
 * @returns {Array<{
 *   tierId: string|null,
 *   tierName: string|null,
 *   minValue: number|null,
 *   maxValue: number|null,
 *   currencyCode: string|null,
 *   interval: string|null,
 * }>}
 */
export function parseSalaryBands(job) {
  const tiers = job?.compensation?.compensationTiers;
  if (!Array.isArray(tiers)) return [];

  const bands = [];
  for (const tier of tiers) {
    if (!tier || typeof tier !== 'object' || !Array.isArray(tier.components)) continue;

  const salaryComponents = tier.components.filter(
    /** @param {any} component */
    (component) => component
    && typeof component === 'object'
    && component.compensationType === 'Salary',
);

    if (salaryComponents.length > 1) {
      const tierId = normalizeTierString(tier.id) ?? '<unknown>';
      console.warn(`ashby: compensation tier ${tierId} has multiple Salary components; skipping ambiguous tier`);
      continue;
    }
    if (salaryComponents.length === 0) continue;

    const salary = salaryComponents[0];
    const minValue = normalizeBandAmount(salary.minValue);
    const maxValue = normalizeBandAmount(salary.maxValue);

    // Invalid numbers and inverted ranges cannot be represented faithfully by
    // the common contract. Keep them only in rawPayload rather than repairing
    // or combining them here.
    if (minValue === undefined || maxValue === undefined) continue;
    if (minValue != null && maxValue != null && minValue > maxValue) continue;

    bands.push({
      tierId: normalizeTierString(tier.id),
      tierName: normalizeTierString(tier.title),
      minValue,
      maxValue,
      currencyCode: normalizeTierString(salary.currencyCode),
      interval: normalizeTierString(salary.interval),
    });
  }

  return bands;
}

/**
 * Derive the existing annualized salary shape from one source-unit band.
 * Unlike legacy compensation, a missing tier interval is not defaulted to a
 * year because that would invent information absent from the tier.
 * @param {ReturnType<typeof parseSalaryBands>[number]} band
 */
function simpleSalaryFromBand(band) {
  const currency = typeof band.currencyCode === 'string'
    ? band.currencyCode.trim()
    : '';

  if (!band.interval || !/^[A-Za-z]{3}$/.test(currency)) return null;

  return parseCompensation({
    compensation: {
      interval: band.interval,
      minValue: band.minValue,
      maxValue: band.maxValue,
      currency: band.currencyCode,
    },
  });
}

const ALLOWED_ASHBY_HOSTS = new Set(['api.ashbyhq.com']);

/** @param {string} url */
function assertAshbyUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`ashby: invalid URL: ${url}`);
  }
  if (parsed.protocol !== 'https:') throw new Error(`ashby: URL must use HTTPS: ${url}`);
  if (!ALLOWED_ASHBY_HOSTS.has(parsed.hostname))
    throw new Error(`ashby: untrusted hostname "${parsed.hostname}" — must be one of: ${[...ALLOWED_ASHBY_HOSTS].join(', ')}`);
  return url;
}

/** @param {import('./_types.js').PortalEntry} entry */
function resolveApiUrl(entry) {
  // Explicit api: wins — lets an entry keep a human-facing corporate
  // careers_url (e.g. https://openai.com/careers) while still pinning the
  // Ashby posting-api board (mirrors greenhouse's api: precedence).
  if (entry.api) {
    assertAshbyUrl(entry.api);
    return entry.api;
  }
  const url = entry.careers_url || '';
  const match = url.match(/jobs\.ashbyhq\.com\/([^/?#]+)/);
  if (!match) return null;
  return `https://api.ashbyhq.com/posting-api/job-board/${match[1]}?includeCompensation=true`;
}

/**
 * @param {number} ms
 * @param {import('./_types.js').Context} ctx
 */
function sleep(ms, ctx) {
  if (typeof ctx?.sleep === 'function') return ctx.sleep(ms);
  return new Promise((r) => setTimeout(r, ms));
}

// NaN-safe Date.parse — `|| undefined` would also coerce a valid epoch 0.
/**
 * @param {string | null | undefined} value
 */
function toEpochMs(value) {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

// Build the full location string from primary + secondary locations.
// Ashby's posting-api puts extra hiring regions in `secondaryLocations[]`
// (each with a region label + a postalAddress). Using only `j.location` drops
// them, so an EU-eligible role whose PRIMARY label is e.g. "Canada" reads as
// Canada-only and gets wrongly removed by scan.mjs's location_filter. We fold
// in each secondary's region, locality, and country so the filter can match
// (e.g. "Europe", "Berlin", "Germany"). Deduped, joined with " · ".
/** @param {any} j */
function formatLocation(j) {
  const parts = [];
  if (typeof j.location === 'string' && j.location.trim()) parts.push(j.location.trim());
  if (Array.isArray(j.secondaryLocations)) {
    for (const s of j.secondaryLocations) {
      if (!s || typeof s !== 'object') continue;
      if (typeof s.location === 'string' && s.location.trim()) parts.push(s.location.trim());
      const pa = s.address && s.address.postalAddress;
      if (pa) {
        for (const k of ['addressLocality', 'addressCountry']) {
          if (typeof pa[k] === 'string' && pa[k].trim()) parts.push(pa[k].trim());
        }
      }
    }
  }
  return [...new Set(parts)].join(' · ');
}

/** @type {Provider} */
export default {
  id: 'ashby',

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
    if (!apiUrl) throw new Error(`ashby: cannot derive API URL for ${entry.name}`);
    assertAshbyUrl(apiUrl);
    let lastErr;
    for (let attempt = 0; attempt <= ASHBY_RETRIES; attempt++) {
      if (attempt > 0) {
        // exponential backoff + jitter — spaces out retries to dodge Ashby rate-limiting
        const backoff = 1000 * 2 ** (attempt - 1) + Math.floor(Math.random() * 500);
        await sleep(backoff, ctx);
      }
      try {
        const json = /** @type {any} */ (await ctx.fetchJson(apiUrl, { timeoutMs: ASHBY_TIMEOUT_MS, redirect: 'error' }));
        const jobs = Array.isArray(json?.jobs) ? json.jobs : [];
        return jobs.map(/** @param {any} j */ (j) => {
          const compensationTiers = j?.compensation?.compensationTiers;
          const salaryBands = parseSalaryBands(j);
          const hasTierData = Array.isArray(compensationTiers) && compensationTiers.length > 0;
          const hasSingleUnambiguousBand = compensationTiers?.length === 1 && salaryBands.length === 1;
          const bandSalary = hasSingleUnambiguousBand
            ? simpleSalaryFromBand(salaryBands[0])
            : null;
          const salary = hasTierData ? bandSalary : parseCompensation(j);

          return {
            title: j.title || '',
            url: j.jobUrl || '',
            company: entry.name,
            location: formatLocation(j),
            sourceJobId: typeof j.id === 'string' ? j.id.trim() : '',
            description: typeof j.descriptionPlain === 'string' ? j.descriptionPlain : '',
            employmentTypeRaw: typeof j.employmentType === 'string' ? j.employmentType : '',
            workingTimeRaw: typeof j.employmentType === 'string' ? j.employmentType : '',
            workplaceTypeRaw: typeof j.workplaceType === 'string'
              ? j.workplaceType
              : j.isRemote === true ? 'Remote' : '',
            salary,
            salaryBands,
            salaryMin: bandSalary?.min ?? null,
            salaryMax: bandSalary?.max ?? null,
            salaryCurrency: bandSalary?.currency || '',
            salaryPeriod: bandSalary ? 'yearly' : '',
            postedAt: toEpochMs(j.publishedAt),
            rawPayload: j,
          };
        });
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr;
  },
};
