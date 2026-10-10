// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// InfoJobs provider — authenticated public job-search API.
//
// Discovery uses the public offer search endpoint.
// Full job details will be fetched separately by offer id.
//
// Credentials are read from environment variables:
// INFOJOBS_CLIENT_ID
// INFOJOBS_CLIENT_SECRET

const LIST_URL = 'https://api.infojobs.net/api/9/offer';
/**
 * Normalize one InfoJobs offer using list and detail payloads.
 *
 * @param {any} listOffer
 * @param {any} detailOffer
 */
export function normalizeInfoJobsOffer(listOffer, detailOffer) {
  const list = listOffer && typeof listOffer === 'object'
    ? listOffer
    : {};
  const detail = detailOffer && typeof detailOffer === 'object'
    ? detailOffer
    : {};

  const sourceJobId = String(detail.id || list.id || '').trim();
  const title = String(detail.title || list.title || '').trim();
  const url = String(detail.link || list.link || '').trim();
  const company = String(
    detail.profile?.name
    || list.author?.name
    || '',
  ).trim();
  const location = String(
    detail.city
    || list.city
    || '',
  ).trim();

     const contractType = String(
    detail.contractType?.value
    || list.contractType?.value
    || '',
  ).trim().toLowerCase();

  const workDay = String(
    detail.journey?.value
    || list.workDay?.value
    || '',
  ).trim().toLowerCase();

  const employmentTypeRaw = contractType === 'indefinido'
    ? 'permanent'
    : '';

  const workingTimeRaw = workDay === 'completa'
    ? 'full_time'
    : '';

  const salaryMin = Number.isFinite(detail.minPay?.amount)
    ? detail.minPay.amount
    : Number.isFinite(list.salaryMin?.id)
      ? list.salaryMin.id
      : null;

  const salaryMax = Number.isFinite(detail.maxPay?.amount)
    ? detail.maxPay.amount
    : Number.isFinite(list.salaryMax?.id)
      ? list.salaryMax.id
      : null;

  const salaryPeriodRaw = String(
    detail.minPay?.periodValue
    || detail.maxPay?.periodValue
    || list.salaryPeriod?.value
    || '',
  ).trim().toLowerCase();

  const salaryPeriod = salaryPeriodRaw.includes('a\u00f1o')
    ? 'yearly'
    : '';

  const salaryCurrency = (
    salaryMin !== null
    || salaryMax !== null
  )
    ? 'EUR'
    : '';

    const experienceMinRaw = String(
    detail.experienceMin?.value
    || list.experienceMin?.value
    || '',
  ).trim();

  const jobLevelRaw = String(
    detail.jobLevel?.value
    || list.jobLevel?.value
    || '',
  ).trim();

  return {
    sourceJobId,
    title,
    url,
    company,
    location,
    description: String(detail.description || '').trim(),
    minRequirements: String(detail.minRequirements || '').trim(),
    desiredRequirements: String(detail.desiredRequirements || '').trim(),
    employmentTypeRaw,
    workingTimeRaw,
    salaryMin,
    salaryMax,
    salaryCurrency,
    salaryPeriod,
    experienceMinRaw,
    jobLevelRaw,
    rawPayload: {
      list,
      detail,
    },
  };
}
/** @type {Provider} */
export default {
  id: 'infojobs',

  detect(entry) {
    return entry?.provider === 'infojobs'
      ? { url: LIST_URL }
      : null;
  },

  async fetch() {
    return [];
  },
};