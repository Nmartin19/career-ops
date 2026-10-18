// tests/providers/greenhouse.test.mjs — direct provider-contract tests (#1499).
// Covers the id/detect/fetch contract scan.mjs calls: api: precedence with the
// host allowlist, careers_url auto-detection, normalization from the
// boards-api JSON shape, and the guard chain running before any request.
// (Indirect coverage elsewhere: liveness tests exercise Greenhouse URL
// resolution; this file tests the provider module itself.)
import { pass, fail, ROOT } from '../helpers.mjs';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { isDeepStrictEqual } from 'util';

console.log('\nProvider — greenhouse');

try {
  const greenhouseModule = await import(pathToFileURL(join(ROOT, 'providers/greenhouse.mjs')).href);
  const greenhouse = greenhouseModule.default;
  const { parseGreenhouseSalaryBands } = greenhouseModule;

  if (greenhouse.id === 'greenhouse') pass('greenhouse.id is "greenhouse"');
  else fail(`greenhouse.id is ${JSON.stringify(greenhouse.id)}`);

  // detect() — careers_url auto-detection (job-boards host → boards-api endpoint).
  // The listing request must opt into the full content field.
  const hit = greenhouse.detect({ name: 'Acme', careers_url: 'https://job-boards.greenhouse.io/acme' });
  if (hit && hit.url === 'https://boards-api.greenhouse.io/v1/boards/acme/jobs?content=true&pay_transparency=true') {
    pass('greenhouse.detect() resolves job-boards.greenhouse.io/<slug> with content=true');
  } else {
    fail(`greenhouse.detect() returned ${JSON.stringify(hit)}`);
  }

  const hitEu = greenhouse.detect({ name: 'EuCo', careers_url: 'https://job-boards.eu.greenhouse.io/euco' });
  if (hitEu && hitEu.url === 'https://boards-api.greenhouse.io/v1/boards/euco/jobs?content=true&pay_transparency=true') {
    pass('greenhouse.detect() extracts the EU board slug and requests content');
  } else {
    fail(`greenhouse.detect(eu) returned ${JSON.stringify(hitEu)}`);
  }

  const hitLegacy = greenhouse.detect({ name: 'Legacy', careers_url: 'https://boards.greenhouse.io/legacy/jobs' });
  if (hitLegacy?.url === 'https://boards-api.greenhouse.io/v1/boards/legacy/jobs?content=true&pay_transparency=true') {
    pass('greenhouse.detect() supports the allowlisted legacy boards.greenhouse.io host');
  } else {
    fail(`greenhouse.detect(legacy) returned ${JSON.stringify(hitLegacy)}`);
  }
// detect() — embedded Greenhouse boards use the ?for= parameter.
const embedHit = greenhouse.detect({
  name: 'Embedded',
  careers_url: 'https://boards.greenhouse.io/embed/job_board?for=acme',
});

const embedMissing = greenhouse.detect({
  name: 'Embedded',
  careers_url: 'https://boards.greenhouse.io/embed/job_board',
});

const embedInvalid = greenhouse.detect({
  name: 'Embedded',
  careers_url: 'https://boards.greenhouse.io/embed/job_board?for=../invalid',
});

if (
  embedHit?.url === 'https://boards-api.greenhouse.io/v1/boards/acme/jobs?content=true&pay_transparency=true'
  && embedMissing === null
  && embedInvalid === null
) {
  pass('greenhouse.detect() resolves embedded boards and rejects invalid identifiers');
} else {
  fail(`greenhouse.detect() embed validation failed: ${JSON.stringify({
    embedHit,
    embedMissing,
    embedInvalid,
  })}`);
}
  // detect() — api: takes precedence over careers_url. Existing query params
  // survive, while duplicate/false content values collapse to one true value.
  const hitApi = greenhouse.detect({
    name: 'Pinned',
    careers_url: 'https://www.pinned.example/careers',
    api: 'https://boards-api.greenhouse.io/v1/boards/pinned/jobs?per_page=50&locale=en&content=false&content=0&pay_transparency=false&pay_transparency=0',
  });
  const parsedHitApi = hitApi ? new URL(hitApi.url) : null;
  if (parsedHitApi
      && parsedHitApi.searchParams.get('per_page') === '50'
      && parsedHitApi.searchParams.get('locale') === 'en'
      && JSON.stringify(parsedHitApi.searchParams.getAll('content')) === JSON.stringify(['true'])
      && JSON.stringify(parsedHitApi.searchParams.getAll('pay_transparency')) === JSON.stringify(['true'])) {
    pass('greenhouse.detect() preserves api: params and forces one content=true and pay_transparency=true');
  } else {
    fail(`greenhouse.detect(api-pinned) returned ${JSON.stringify(hitApi)}`);
  }

  // detect() — api: with an untrusted host must NOT be claimed (SSRF guard).
  if (greenhouse.detect({ name: 'Evil', api: 'https://evil.example/v1/boards/acme/jobs' }) === null) {
    pass('greenhouse.detect() returns null for an api: on an untrusted host');
  } else {
    fail('greenhouse.detect() must reject an untrusted api: host');
  }

  // detect() — api: must be HTTPS.
  if (greenhouse.detect({ name: 'Insecure', api: 'http://boards-api.greenhouse.io/v1/boards/acme/jobs' }) === null) {
    pass('greenhouse.detect() returns null for a non-HTTPS api:');
  } else {
    fail('greenhouse.detect() must reject an http:// api:');
  }

  // detect() — malformed api: URL → null, not a crash.
  if (greenhouse.detect({ name: 'Broken', api: 'not a url' }) === null) {
    pass('greenhouse.detect() returns null for a malformed api: URL');
  } else {
    fail('greenhouse.detect() should treat a malformed api: as unclaimable');
  }

  // detect() — negative and non-string careers_url cases.
  if (greenhouse.detect({ name: 'X', careers_url: 'https://example.com/careers' }) === null) {
    pass('greenhouse.detect() returns null for a non-greenhouse careers_url');
  } else {
    fail('greenhouse.detect() should return null for non-greenhouse URLs');
  }

  if (greenhouse.detect({ name: 'X' }) === null
      && greenhouse.detect({ name: 'X', careers_url: null }) === null
      && greenhouse.detect({ name: 'X', careers_url: 7 }) === null) {
    pass('greenhouse.detect() returns null for missing / null / non-string careers_url');
  } else {
    fail('greenhouse.detect() should treat non-string careers_url as missing');
  }

  const misleadingCareersUrls = [
    'https://evil.example/job-boards.greenhouse.io/acme',
    'https://evil.example/?next=https://job-boards.greenhouse.io/acme',
    'https://job-boards.greenhouse.io.evil.example/acme',
    'https://job-boards.greenhouse.io@evil.example/acme',
    'http://job-boards.greenhouse.io/acme',
  ];
  if (misleadingCareersUrls.every(careers_url => greenhouse.detect({ name: 'Spoof', careers_url }) === null)) {
    pass('greenhouse.detect() rejects embedded, lookalike, userinfo, and non-HTTPS careers URLs');
  } else {
    fail('greenhouse.detect() accepted a misleading careers_url');
  }

  // Local fixture representative of Greenhouse's documented list schema. It
  // is intentionally not presented as a live response.
  const sample = {
    jobs: [
      {
        id: 101,
        internal_job_id: 9001,
        title: 'Senior Backend Engineer',
        absolute_url: 'https://job-boards.greenhouse.io/acme/jobs/101',
        location: { name: 'Berlin, Germany' },
        first_published: '2026-07-01T09:30:00-04:00',
        updated_at: '2026-07-02T11:15:00-04:00',
        requisition_id: 'REQ-2026-101',
        content: '<h2>About &amp; impact</h2><p>Build <strong>AI</strong> systems.<br>Ship safely.</p><ul><li>Python&nbsp;&amp; SQL</li></ul><script>ignored()</script><style>ignored</style>',
        metadata: [{ id: 1, name: 'Employment Type', value: 'Permanent' }],
        departments: [{ id: 10, name: 'Engineering', child_ids: [], parent_id: null }],
        offices: [{ id: 20, name: 'Berlin', location: 'Berlin, Germany', child_ids: [], parent_id: null }],
        language: 'en',
      },
      {
        internal_job_id: 9002,
        content: null,
        // no publication id/title/location/first_published: do not backfill from internal_job_id
        absolute_url: 'https://job-boards.greenhouse.io/acme/jobs/102',
      },
      { id: 103, title: 'Ghost Role' },                                    // no absolute_url — dropped
      { id: 104, title: 'Bad Date', absolute_url: 'https://job-boards.greenhouse.io/acme/jobs/104', first_published: 'not-a-date' },
    ],
  };

  let capturedUrl = null;
  let capturedOpts = null;
  const fetched = await greenhouse.fetch(
    { name: 'Acme', careers_url: 'https://job-boards.greenhouse.io/acme' },
    { fetchJson: async (url, opts) => { capturedUrl = url; capturedOpts = opts; return sample; } },
  );

  if (capturedUrl === 'https://boards-api.greenhouse.io/v1/boards/acme/jobs?content=true&pay_transparency=true' && capturedOpts?.redirect === 'error') {
    pass('greenhouse.fetch() requests derived content=true URL with redirect:"error"');
  } else {
    fail(`greenhouse.fetch() url=${JSON.stringify(capturedUrl)} opts=${JSON.stringify(capturedOpts)}`);
  }

  if (fetched.length === 3)
    pass('greenhouse.fetch() drops rows without absolute_url (3 of 4 kept)');
  else fail(`greenhouse.fetch() returned ${fetched.length} jobs (expected 3)`);

  if (fetched[0]?.title === 'Senior Backend Engineer'
      && fetched[0]?.url === 'https://job-boards.greenhouse.io/acme/jobs/101'
      && fetched[0]?.company === 'Acme'
      && fetched[0]?.location === 'Berlin, Germany'
      && fetched[0]?.postedAt === Date.parse('2026-07-01T09:30:00-04:00'))
    pass('greenhouse.fetch() maps title/absolute_url/entry.name/location.name/first_published');
  else fail(`greenhouse.fetch() row 0 = ${JSON.stringify(fetched[0])}`);

  if (fetched[0]?.sourceJobId === '101')
    pass('greenhouse.fetch() maps the publication j.id to sourceJobId');
  else fail(`greenhouse.fetch() sourceJobId = ${JSON.stringify(fetched[0]?.sourceJobId)}`);

  const expectedDescription = 'About & impact Build AI systems.\nShip safely.\n\n- Python & SQL';
  if (fetched[0]?.description === expectedDescription)
    pass('greenhouse.fetch() normalizes HTML content into plain-text description');
  else fail(`greenhouse.fetch() description = ${JSON.stringify(fetched[0]?.description)}`);

  const encodedContent = await greenhouse.fetch(
    { name: 'Acme', careers_url: 'https://job-boards.greenhouse.io/acme' },
    { fetchJson: async () => ({ jobs: [{ id: 105, title: 'Encoded', absolute_url: 'https://job-boards.greenhouse.io/acme/jobs/105', content: '&lt;p&gt;Encoded &amp;amp; complete&lt;/p&gt;' }] }) },
  );
  if (encodedContent[0]?.description === 'Encoded & complete')
    pass('greenhouse.fetch() normalizes entity-encoded HTML content');
  else fail(`greenhouse.fetch() encoded description = ${JSON.stringify(encodedContent[0]?.description)}`);
// HTML cleanup must preserve entity-encoded technical terms.
const technicalContent = await greenhouse.fetch(
  {
    name: 'Technical',
    careers_url: 'https://job-boards.greenhouse.io/technical',
  },
  {
    fetchJson: async () => ({
      jobs: [
        {
          id: 200,
          title: 'Frontend Developer',
          absolute_url: 'https://job-boards.greenhouse.io/technical/jobs/200',
          content: '<p>Experience with &lt;React&gt;, &lt;TypeScript&gt; and SQL.</p>',
        },
      ],
    }),
  },
);

const expectedTechnicalDescription =
  'Experience with <React>, <TypeScript> and SQL.';

if (technicalContent[0]?.description === expectedTechnicalDescription) {
  pass('greenhouse.fetch() preserves technical terms in HTML descriptions');
} else {
  fail(
    `greenhouse.fetch() technical description = ${
      JSON.stringify(technicalContent[0]?.description)
    }`
  );
}
  if (fetched[0]?.rawPayload === sample.jobs[0]
      && fetched[0].rawPayload.internal_job_id === 9001
      && fetched[0].rawPayload.updated_at === '2026-07-02T11:15:00-04:00'
      && fetched[0].rawPayload.requisition_id === 'REQ-2026-101'
      && fetched[0].rawPayload.metadata === sample.jobs[0].metadata
      && fetched[0].rawPayload.departments === sample.jobs[0].departments
      && fetched[0].rawPayload.offices === sample.jobs[0].offices
      && fetched[0].rawPayload.language === 'en'
      && fetched[0].rawPayload.content === sample.jobs[0].content) {
    pass('greenhouse.fetch() preserves the complete original object as rawPayload');
  } else {
    fail(`greenhouse.fetch() rawPayload = ${JSON.stringify(fetched[0]?.rawPayload)}`);
  }

  if (fetched[1]?.title === ''
      && fetched[1]?.location === ''
      && fetched[1]?.description === ''
      && fetched[1]?.sourceJobId === ''
      && fetched[1]?.postedAt === undefined
      && fetched[1]?.rawPayload === sample.jobs[1])
    pass('greenhouse.fetch() keeps incomplete rows compatible without using internal_job_id as sourceJobId');
  else fail(`greenhouse.fetch() row 1 = ${JSON.stringify(fetched[1])}`);

  if (!('employmentTypeRaw' in fetched[0])
      && !('workingTimeRaw' in fetched[0])
      && !('workplaceTypeRaw' in fetched[0])) {
    pass('greenhouse.fetch() does not infer unsupported employment, working-time, or workplace metadata');
  } else {
    fail('greenhouse.fetch() invented unsupported optional metadata');
  }

  if (fetched[2]?.postedAt === undefined)
    pass('greenhouse.fetch() yields undefined postedAt for an unparseable first_published (NaN-safe)');
  else fail(`greenhouse.fetch() row 2 postedAt = ${JSON.stringify(fetched[2]?.postedAt)}`);

  // Local salary fixtures cover ISO currencies with zero, two, and three
  // minor-unit digits. They are representative inputs, not live responses.
  const payInputRanges = [
    { title: 'Annual Base Salary Range:', min_cents: 16500000, max_cents: 19000000, currency_type: 'usd' },
    { title: 'Hourly Base Pay Range:', min_cents: 2500, max_cents: 4500, currency_type: 'USD' },
    { title: 'Japan Base Salary', min_cents: 4000000, max_cents: 5000000, currency_type: 'JPY' },
    { title: 'Kuwait Compensation', min_cents: 123456, max_cents: 234567, currency_type: 'KWD' },
    { title: 'Minimum only', min_cents: 100000, max_cents: null, currency_type: 'EUR' },
    { title: 'Maximum only', max_cents: 200000, currency_type: 'EUR' },
    { title: 'Both missing', min_cents: null, max_cents: null, currency_type: 'USD' },
    { title: 'Zero placeholders', min_cents: 0, max_cents: 0, currency_type: 'USD' },
    { title: 'Inverted', min_cents: 20000, max_cents: 10000, currency_type: 'USD' },
    { title: 'Negative', min_cents: -1, max_cents: 10000, currency_type: 'USD' },
    { title: 'String', min_cents: '10000', max_cents: 20000, currency_type: 'USD' },
    { title: 'Fractional', min_cents: 10000.5, max_cents: 20000, currency_type: 'USD' },
    { title: 'NaN', min_cents: Number.NaN, max_cents: 20000, currency_type: 'USD' },
    { title: 'Infinite', min_cents: 10000, max_cents: Number.POSITIVE_INFINITY, currency_type: 'USD' },
    { title: 'Unsafe', min_cents: 10000, max_cents: Number.MAX_SAFE_INTEGER + 1, currency_type: 'USD' },
  ];
  const payInputRangesSnapshot = payInputRanges.map(range => ({ ...range }));
  const salaryBands = parseGreenhouseSalaryBands({ pay_input_ranges: payInputRanges });
  const expectedSalaryBands = [
    { tierName: 'Annual Base Salary Range:', minValue: 165000, maxValue: 190000, currencyCode: 'USD', interval: '1 YEAR' },
    { tierName: 'Hourly Base Pay Range:', minValue: 25, maxValue: 45, currencyCode: 'USD', interval: '1 HOUR' },
    { tierName: 'Japan Base Salary', minValue: 4000000, maxValue: 5000000, currencyCode: 'JPY' },
    { tierName: 'Kuwait Compensation', minValue: 123.456, maxValue: 234.567, currencyCode: 'KWD' },
    { tierName: 'Minimum only', minValue: 1000, maxValue: null, currencyCode: 'EUR' },
    { tierName: 'Maximum only', minValue: null, maxValue: 2000, currencyCode: 'EUR' },
  ];

  if (JSON.stringify(salaryBands) === JSON.stringify(expectedSalaryBands)) {
    pass('parseGreenhouseSalaryBands() converts 0/2/3-digit currencies and preserves valid range order');
  } else {
    fail(`parseGreenhouseSalaryBands() returned ${JSON.stringify(salaryBands)}`);
  }

  if (salaryBands[0]?.interval === '1 YEAR'
      && salaryBands[1]?.interval === '1 HOUR'
      && !('interval' in salaryBands[2])
      && !('interval' in salaryBands[3])) {
    pass('parseGreenhouseSalaryBands() distinguishes annual, hourly, and ambiguous periods');
  } else {
    fail('parseGreenhouseSalaryBands() inferred an incorrect compensation period');
  }

  if (salaryBands[4]?.minValue === 1000
      && salaryBands[4]?.maxValue === null
      && salaryBands[5]?.minValue === null
      && salaryBands[5]?.maxValue === 2000) {
    pass('parseGreenhouseSalaryBands() preserves valid one-sided ranges with null missing limits');
  } else {
    fail('parseGreenhouseSalaryBands() did not preserve one-sided salary limits');
  }

  if (salaryBands.length === 6) {
    pass('parseGreenhouseSalaryBands() rejects empty, inverted, negative, non-numeric, fractional, infinite, and unsafe ranges');
  } else {
    fail(`parseGreenhouseSalaryBands() accepted invalid ranges: ${JSON.stringify(salaryBands)}`);
  }

  if (isDeepStrictEqual(payInputRanges, payInputRangesSnapshot)) {
    pass('parseGreenhouseSalaryBands() does not mutate pay_input_ranges');
  } else {
    fail('parseGreenhouseSalaryBands() mutated pay_input_ranges');
  }

  const salarySourceJob = {
    id: 300,
    title: 'Compensated Role',
    absolute_url: 'https://job-boards.greenhouse.io/acme/jobs/300',
    pay_input_ranges: payInputRanges,
  };
  const salaryFetched = await greenhouse.fetch(
    { name: 'Acme', careers_url: 'https://job-boards.greenhouse.io/acme' },
    { fetchJson: async () => ({ jobs: [salarySourceJob] }) },
  );
  const normalizedSalaryJob = salaryFetched[0];

  if (normalizedSalaryJob?.rawPayload === salarySourceJob
      && normalizedSalaryJob.rawPayload.pay_input_ranges === payInputRanges
      && JSON.stringify(normalizedSalaryJob.salaryBands) === JSON.stringify(expectedSalaryBands)) {
    pass('greenhouse.fetch() preserves pay_input_ranges in rawPayload and exposes all normalized salaryBands');
  } else {
    fail(`greenhouse.fetch() salary integration = ${JSON.stringify(normalizedSalaryJob)}`);
  }

  if (!('salary' in normalizedSalaryJob)
      && !('salaryMin' in normalizedSalaryJob)
      && !('salaryMax' in normalizedSalaryJob)
      && !('salaryCurrency' in normalizedSalaryJob)
      && !('salaryPeriod' in normalizedSalaryJob)) {
    pass('greenhouse.fetch() does not select a band or populate simple salary fields arbitrarily');
  } else {
    fail('greenhouse.fetch() populated simple salary fields from multiple bands');
  }

  // Epoch-0 first_published must survive (the `|| undefined` trap toEpochMs avoids).
  const epochZero = await greenhouse.fetch(
    { name: 'Acme', careers_url: 'https://job-boards.greenhouse.io/acme' },
    { fetchJson: async () => ({ jobs: [{ title: 'Old', absolute_url: 'https://job-boards.greenhouse.io/acme/jobs/1', first_published: '1970-01-01T00:00:00.000Z' }] }) },
  );
  if (epochZero[0]?.postedAt === 0)
    pass('greenhouse.fetch() preserves a valid epoch-0 first_published as postedAt 0');
  else fail(`greenhouse.fetch() epoch-0 postedAt = ${JSON.stringify(epochZero[0]?.postedAt)}`);

  // Malformed response bodies → empty result, no crash.
  const emptyCases = [
    null,
    {},
    { jobs: null },
    { jobs: 'nope' },
    { jobs: [null, undefined, 'nope', 7, {}, { absolute_url: '' }] },
  ];
  let emptyOk = true;
  for (const body of emptyCases) {
    const out = await greenhouse.fetch(
      { name: 'Acme', careers_url: 'https://job-boards.greenhouse.io/acme' },
      { fetchJson: async () => body },
    );
    if (!Array.isArray(out) || out.length !== 0) { emptyOk = false; fail(`greenhouse.fetch() body=${JSON.stringify(body)} → ${JSON.stringify(out)}`); break; }
  }
  if (emptyOk) pass('greenhouse.fetch() returns [] for malformed bodies and incomplete job rows');

  let explicitUrl = null;
  let explicitOpts = null;
  await greenhouse.fetch(
    { name: 'Pinned', api: 'https://boards-api.greenhouse.io/v1/boards/pinned/jobs?per_page=25&content=false&content=0&pay_transparency=false&pay_transparency=0' },
    { fetchJson: async (url, opts) => { explicitUrl = url; explicitOpts = opts; return { jobs: [] }; } },
  );
  const parsedExplicitUrl = new URL(explicitUrl);
  if (parsedExplicitUrl.searchParams.get('per_page') === '25'
      && JSON.stringify(parsedExplicitUrl.searchParams.getAll('content')) === JSON.stringify(['true'])
      && JSON.stringify(parsedExplicitUrl.searchParams.getAll('pay_transparency')) === JSON.stringify(['true'])
      && explicitOpts?.redirect === 'error') {
    pass('greenhouse.fetch() preserves api params, deduplicates content/pay transparency, and blocks redirects');
  } else {
    fail(`greenhouse.fetch() explicit url=${JSON.stringify(explicitUrl)} opts=${JSON.stringify(explicitOpts)}`);
  }

  // Guard chain runs BEFORE any request: an untrusted api: must throw without
  // ever calling fetchJson.
  let untrustedFetchCalled = false;
  try {
    await greenhouse.fetch(
      { name: 'Evil', api: 'https://evil.example/v1/boards/acme/jobs' },
      { fetchJson: async () => { untrustedFetchCalled = true; return { jobs: [] }; } },
    );
    fail('greenhouse.fetch() should throw for an untrusted api: host');
  } catch (e) {
    if (!untrustedFetchCalled && /untrusted hostname/.test(e.message)) {
      pass('greenhouse.fetch() throws on an untrusted api: host before any request is made');
    } else {
      fail(`greenhouse.fetch() untrusted api: fetchCalled=${untrustedFetchCalled}, error=${e.message}`);
    }
  }

  let lookalikeFetchCalled = false;
  try {
    await greenhouse.fetch(
      { name: 'Lookalike', api: 'https://boards-api.greenhouse.io.evil.example/v1/boards/acme/jobs' },
      { fetchJson: async () => { lookalikeFetchCalled = true; return { jobs: [] }; } },
    );
    fail('greenhouse.fetch() should throw for a lookalike api host');
  } catch (e) {
    if (!lookalikeFetchCalled && /untrusted hostname/.test(e.message)) {
      pass('greenhouse.fetch() rejects lookalike api hosts before requesting');
    } else {
      fail(`greenhouse.fetch() lookalike fetchCalled=${lookalikeFetchCalled}, error=${e.message}`);
    }
  }

  // Underivable entry → typed error, no request.
  try {
    await greenhouse.fetch(
      { name: 'NoBoard', careers_url: 'https://example.com/careers' },
      { fetchJson: async () => { throw new Error('must not be called'); } },
    );
    fail('greenhouse.fetch() should throw when no API URL can be derived');
  } catch (e) {
    if (/cannot derive API URL for NoBoard/.test(e.message)) {
      pass('greenhouse.fetch() throws "cannot derive API URL" for an undetectable entry');
    } else {
      fail(`greenhouse.fetch() threw the wrong error: ${e.message}`);
    }
  }

} catch (e) {
  fail(`greenhouse provider tests crashed: ${e.message}`);
}
