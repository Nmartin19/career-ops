// tests/providers/lever.test.mjs — direct provider-contract tests (#1499).
// Covers the id/detect/fetch contract scan.mjs calls: hostname-anchored
// detection for both jobs.lever.co and jobs.eu.lever.co, normalization from
// the v0 postings shape (including the free descriptionPlain for
// content_filter), and malformed-input tolerance.
// (Indirect coverage elsewhere: tests/providers/ats-ssrf-hardening.test.mjs
// asserts the redirect:'error' guard per instance; liveness tests cover URL
// resolution. This file tests the provider module contract itself.)
import { pass, fail, ROOT } from '../helpers.mjs';
import { join } from 'path';
import { pathToFileURL } from 'url';
import assert from 'node:assert/strict';
import { serializeOfferForJson } from '../../scan.mjs';

console.log('\nProvider — lever');

try {
  const leverModule = await import(pathToFileURL(join(ROOT, 'providers/lever.mjs')).href);
  const lever = leverModule.default;

  if (lever.id === 'lever') pass('lever.id is "lever"');
  else fail(`lever.id is ${JSON.stringify(lever.id)}`);

  // detect() — positive cases, both instances.
  const hit = lever.detect({ name: 'Acme', careers_url: 'https://jobs.lever.co/acme' });
  if (hit && hit.url === 'https://api.lever.co/v0/postings/acme') {
    pass('lever.detect() resolves jobs.lever.co/<slug> → api.lever.co postings endpoint');
  } else {
    fail(`lever.detect() returned ${JSON.stringify(hit)}`);
  }

  const hitEu = lever.detect({ name: 'EuCo', careers_url: 'https://jobs.eu.lever.co/euco/some-posting' });
  if (hitEu && hitEu.url === 'https://api.eu.lever.co/v0/postings/euco') {
    pass('lever.detect() resolves jobs.eu.lever.co → api.eu.lever.co and takes the first path segment as slug');
  } else {
    fail(`lever.detect(eu) returned ${JSON.stringify(hitEu)}`);
  }

  // detect() — negative / spoof / degenerate cases.
  if (lever.detect({ name: 'X', careers_url: 'https://example.com/careers' }) === null) {
    pass('lever.detect() returns null for a non-lever careers_url');
  } else {
    fail('lever.detect() should return null for non-lever URLs');
  }

  if (lever.detect({ name: 'Spoof', careers_url: 'https://jobs.lever.co.evil.example/acme' }) === null) {
    pass('lever.detect() rejects a hostname-suffix spoof (jobs.lever.co.evil.example)');
  } else {
    fail('lever.detect() must NOT detect hostname-suffix spoofs');
  }

  if (lever.detect({ name: 'PathSpoof', careers_url: 'https://evil.example/jobs.lever.co/acme' }) === null) {
    pass('lever.detect() rejects a path-spoofed URL (lever host in path, not hostname)');
  } else {
    fail('lever.detect() must NOT detect path-spoofed URLs');
  }

  if (lever.detect({ name: 'NoSlug', careers_url: 'https://jobs.lever.co/' }) === null) {
    pass('lever.detect() returns null when the URL has no board slug');
  } else {
    fail('lever.detect() should return null for a slug-less lever URL');
  }

  if (lever.detect({ name: 'X' }) === null
      && lever.detect({ name: 'X', careers_url: null }) === null
      && lever.detect({ name: 'X', careers_url: 7 }) === null) {
    pass('lever.detect() returns null for missing / null / non-string careers_url');
  } else {
    fail('lever.detect() should treat non-string careers_url as missing');
  }

  // detect() — api: takes precedence over careers_url and is used verbatim
  // when its host is on the allowlist. Lets an entry keep a human-facing
  // corporate careers_url (e.g. https://www.coalfire.com/careers) while
  // pinning the Lever board explicitly.
  const hitApi = lever.detect({
    name: 'Pinned',
    careers_url: 'https://www.coalfire.com/careers',
    api: 'https://api.lever.co/v0/postings/coalfire',
  });
  if (hitApi && hitApi.url === 'https://api.lever.co/v0/postings/coalfire') {
    pass('lever.detect() honors an allowlisted api: over a branded careers_url');
  } else {
    fail(`lever.detect(api-pinned) returned ${JSON.stringify(hitApi)}`);
  }

  // detect() — api: on the EU host is also allowlisted.
  const hitApiEu = lever.detect({ name: 'PinnedEu', api: 'https://api.eu.lever.co/v0/postings/euco' });
  if (hitApiEu && hitApiEu.url === 'https://api.eu.lever.co/v0/postings/euco') {
    pass('lever.detect() honors an allowlisted api: on the EU host');
  } else {
    fail(`lever.detect(api-pinned-eu) returned ${JSON.stringify(hitApiEu)}`);
  }

  // detect() — api: with an untrusted host must NOT be claimed (SSRF guard).
  if (lever.detect({ name: 'Evil', api: 'https://evil.example/v0/postings/acme' }) === null) {
    pass('lever.detect() returns null for an api: on an untrusted host');
  } else {
    fail('lever.detect() must reject an untrusted api: host');
  }

  // detect() — api: must be HTTPS.
  if (lever.detect({ name: 'Insecure', api: 'http://api.lever.co/v0/postings/acme' }) === null) {
    pass('lever.detect() returns null for a non-HTTPS api:');
  } else {
    fail('lever.detect() must reject an http:// api:');
  }

  // detect() — malformed api: URL → null, not a crash.
  if (lever.detect({ name: 'Broken', api: 'not a url' }) === null) {
    pass('lever.detect() returns null for a malformed api: URL');
  } else {
    fail('lever.detect() must reject a malformed api: URL');
  }

  // fetch() — request URL, SSRF guard, and normalization from the real v0
  // postings shape: [{ text, hostedUrl, categories: {location}, descriptionPlain, createdAt }].
  const sample = [
    {
      text: 'Staff Platform Engineer',
      hostedUrl: 'https://jobs.lever.co/acme/1111-staff-platform-engineer',
      categories: { location: 'Remote — Europe', team: 'Platform', commitment: 'Full-time' },
      descriptionPlain: 'Build the platform that powers everything.',
      createdAt: 1751328000000,
    },
    {
      // no text → '' ; no categories → location '' ;
      // descriptionPlain non-string → '' ; createdAt non-number → undefined
      descriptionPlain: { html: true },
      hostedUrl: 'https://jobs.lever.co/acme/malformed-fields',
      createdAt: '2026-07-01',
    },
    {},                                                                   // no identity: discarded
  ];

  let capturedUrl = null;
  let capturedOpts = null;
  const fetched = await lever.fetch(
    { name: 'Acme', careers_url: 'https://jobs.lever.co/acme' },
    { fetchJson: async (url, opts) => { capturedUrl = url; capturedOpts = opts; return sample; } },
  );

  if (capturedUrl === 'https://api.lever.co/v0/postings/acme?mode=json&limit=100&skip=0' && capturedOpts?.redirect === 'error') {
    pass('lever.fetch() hits the derived api.lever.co URL with redirect:"error" (SSRF guard)');
  } else {
    fail(`lever.fetch() url=${JSON.stringify(capturedUrl)} opts=${JSON.stringify(capturedOpts)}`);
  }

  if (fetched.length === 2)
    pass('lever.fetch() preserves usable postings and discards an empty posting');
  else fail(`lever.fetch() returned ${fetched.length} rows (expected 2)`);

  if (fetched[0]?.title === 'Staff Platform Engineer'
      && fetched[0]?.url === 'https://jobs.lever.co/acme/1111-staff-platform-engineer'
      && fetched[0]?.company === 'Acme'
      && fetched[0]?.location === 'Remote — Europe'
      && fetched[0]?.description === 'Build the platform that powers everything.'
      && fetched[0]?.postedAt === 1751328000000)
    pass('lever.fetch() maps text/hostedUrl/entry.name/categories.location/descriptionPlain/createdAt');
  else fail(`lever.fetch() row 0 = ${JSON.stringify(fetched[0])}`);

  if (fetched[1]?.description === '' && fetched[1]?.postedAt === undefined)
    pass('lever.fetch() coerces a non-string descriptionPlain to "" and a non-number createdAt to undefined');
  else fail(`lever.fetch() row 1 = ${JSON.stringify(fetched[1])}`);

  if (fetched.every(job => job.url))
    pass('lever.fetch() does not return empty URL keys to the scanner');
  else fail('lever.fetch() returned an empty URL');

  // Non-array response bodies are provider errors, not empty boards.
  for (const body of [null, {}, { postings: [] }, 'nope', '', 0, false, undefined]) {
    await assert.rejects(lever.fetch(
      { name: 'Acme', careers_url: 'https://jobs.lever.co/acme' },
      { fetchJson: async () => body },
    ), /lever: Acme: invalid postings response \(expected an array\)/);
    pass(`lever.fetch() rejects malformed initial response ${JSON.stringify(body)}`);
  }

  // fetch() — a pinned api: is used verbatim, bypassing careers_url parsing entirely.
  let pinnedUrl = null;
  await lever.fetch(
    { name: 'Coalfire', careers_url: 'https://www.coalfire.com/careers', api: 'https://api.lever.co/v0/postings/coalfire' },
    { fetchJson: async (url) => { pinnedUrl = url; return []; } },
  );
  if (pinnedUrl === 'https://api.lever.co/v0/postings/coalfire?mode=json&limit=100&skip=0') {
    pass('lever.fetch() honors a pinned api: over a non-lever careers_url');
  } else {
    fail(`lever.fetch() pinned api: requested ${JSON.stringify(pinnedUrl)}`);
  }

  // fetch() — an untrusted api: host throws before any request (SSRF guard).
  let evilFetchCalled = false;
  try {
    await lever.fetch(
      { name: 'Evil', api: 'https://evil.example/v0/postings/acme' },
      { fetchJson: async () => { evilFetchCalled = true; return []; } },
    );
    fail('lever.fetch() should throw for an untrusted api: host');
  } catch (e) {
    if (!evilFetchCalled && /untrusted hostname/.test(e.message)) {
      pass('lever.fetch() rejects an untrusted api: host before fetching');
    } else {
      fail(`lever.fetch() untrusted api: fetchCalled=${evilFetchCalled}, error=${e.message}`);
    }
  }

  // Underivable entry → typed error before any request.
  try {
    await lever.fetch(
      { name: 'NoBoard', careers_url: 'https://example.com/careers' },
      { fetchJson: async () => { throw new Error('must not be called'); } },
    );
    fail('lever.fetch() should throw when no API URL can be derived');
  } catch (e) {
    if (/cannot derive API URL for NoBoard/.test(e.message)) {
      pass('lever.fetch() throws "cannot derive API URL" before fetching for an undetectable entry');
    } else {
      fail(`lever.fetch() threw the wrong error: ${e.message}`);
    }
  }

} catch (e) {
  fail(`lever provider tests crashed: ${e.message}`);
}

// Local-only enrichment and pagination fixtures. Every request is intercepted.
const { default: lever, parseLeverSalaryBands } = await import('../../providers/lever.mjs');
const entry = { name: 'FixtureCo', careers_url: 'https://jobs.lever.co/fixture-co' };
const posting = id => ({ id, text: `Role ${id}`, hostedUrl: `https://jobs.lever.co/fixture-co/${id}` });
const fetchRows = (rows, config = entry) => lever.fetch(config, { fetchJson: async () => rows });
async function check(name, fn) {
  try { await fn(); pass(name); }
  catch (error) { fail(`${name}: ${error.stack || error}`); process.exitCode = 1; }
}
async function captureWarnings(fn) {
  const original = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args.map(String).join(' '));
  try { return { value: await fn(), warnings }; }
  finally { console.warn = original; }
}

await check('lever enriches identifiers and preserves complete source metadata without mutation', async () => {
  const source = {
    ...posting(' job-123 '),
    hostedUrl: 'https://jobs.lever.co/fixture-co/job-123',
    categories: { location: 'Madrid', allLocations: ['Madrid', 'Berlin', ' Madrid ', '', null],
      team: 'Platform', department: 'Engineering', commitment: 'Full-time', extra: { unknown: true } },
    country: 'ES', applyUrl: 'https://jobs.lever.co/fixture-co/job-123/apply',
    workplaceType: 'hybrid', createdAt: 1751328000000, unknownField: { retain: true },
  };
  const before = JSON.stringify(source);
  const [job] = await fetchRows([source]);
  assert.equal(job.sourceJobId, 'job-123');
  assert.equal(job.location, 'Madrid · Berlin');
  assert.equal(job.rawPayload, source);
  assert.equal(job.rawPayload.categories.allLocations, source.categories.allLocations);
  assert.equal(job.rawPayload.categories.commitment, 'Full-time');
  assert.equal(job.rawPayload.country, 'ES');
  assert.equal(job.rawPayload.applyUrl, source.applyUrl);
  assert.deepEqual(job.rawPayload.unknownField, { retain: true });
  assert.equal(JSON.stringify(source), before);
  for (const key of ['employmentTypeRaw', 'workingTimeRaw', 'seniority', 'expiresAt']) assert.equal(job[key], undefined);
});

await check('lever assembles plain sections and HTML lists with entities, boundaries and no repeated sections', async () => {
  const [job] = await fetchRows([{
    ...posting('description'),
    descriptionPlain: 'Build tools.',
    lists: [null, { text: 'Responsibilities', content: '<ul><li>Build &amp; ship</li><li><b>Own</b> API&nbsp;quality<br>and tests</li></ul><script>ignore()</script><style>ignore</style>' },
      { text: 'Responsibilities', content: '<li>Build &amp; ship</li>' }, { text: {}, content: 3 }],
    additionalPlain: 'Build tools.',
  }]);
  assert.equal(job.description, 'Build tools.\n\nResponsibilities\n\n- Build & ship\n- Own API quality\nand tests\n\n- Build & ship');
  assert.equal(job.description.split('Responsibilities').length - 1, 1);
  assert.ok(!/<(?:li|script|style)>|ignore/.test(job.description));
});

await check('lever removes identical list bodies and retains additional plain text', async () => {
  const list = { text: 'Requirements', content: '<li>Node.js</li>' };
  const [job] = await fetchRows([{ ...posting('lists'), descriptionPlain: 'Intro', lists: [list, list], additionalPlain: 'Equal opportunity.' }]);
  assert.equal(job.description, 'Intro\n\nRequirements\n\n- Node.js\n\nEqual opportunity.');
});

for (const workplace of ['remote', 'hybrid', 'on-site', 'unspecified', '', null, 7, undefined]) {
  await check(`lever preserves explicit workplaceType ${JSON.stringify(workplace)} without inferring from location`, async () => {
    const [job] = await fetchRows([{ ...posting('workplace'), workplaceType: workplace, categories: { location: 'Remote' }, text: 'Remote Senior Full-time' }]);
    assert.equal(job.workplaceTypeRaw, typeof workplace === 'string' ? workplace : '');
    assert.equal(job.seniority, undefined);
    assert.equal(job.workingTimeRaw, undefined);
  });
}

for (const createdAt of [0, 1751328000000, -1, 8640000000000000, NaN, Infinity, -Infinity, 8640000000000001, '2026-07-01', null, undefined, {}]) {
  await check(`lever validates epoch timestamp ${String(createdAt)}`, async () => {
    const [job] = await fetchRows([{ ...posting('timestamp'), createdAt }]);
    const valid = typeof createdAt === 'number' && Number.isFinite(createdAt) && Math.abs(createdAt) <= 8640000000000000;
    assert.equal(job.postedAt, valid ? createdAt : undefined);
    assert.notEqual(JSON.stringify(serializeOfferForJson(job)).includes('NaN'), true);
  });
}

const salaryFixtures = [
  [{ min: 85000, max: 175000, currency: 'USD', interval: 'per-year-salary' },
    { minValue: 85000, maxValue: 175000, currencyCode: 'USD', interval: 'per-year-salary' }],
  [{ min: 32.5, max: 42.75, currency: 'EUR', interval: 'per-hour-wage' },
    { minValue: 32.5, maxValue: 42.75, currencyCode: 'EUR', interval: 'per-hour-wage' }],
  [{ min: 100000, currency: 'JPY', interval: 'per-month-salary' },
    { minValue: 100000, maxValue: null, currencyCode: 'JPY', interval: 'per-month-salary' }],
  [{ max: 2000.123, min: null, currency: 'KWD', interval: 'custom-period' },
    { minValue: null, maxValue: 2000.123, currencyCode: 'KWD', interval: 'custom-period' }],
  [{ min: 0, max: 0 }, { minValue: 0, maxValue: 0 }],
  [{ min: 5, currency: ' usd ', interval: ' explicit ' },
    { minValue: 5, maxValue: null, currencyCode: ' usd ', interval: ' explicit ' }],
  [{ min: 5, currency: 3, interval: {} }, { minValue: 5, maxValue: null }],
];
for (const [salaryRange, band] of salaryFixtures) {
  await check(`lever retains original salary units and metadata ${JSON.stringify(salaryRange)}`, async () => {
    const source = { ...posting('salary'), salaryRange };
    const [job] = await fetchRows([source]);
    assert.deepEqual(job.salaryBands, [band]);
    assert.equal(job.rawPayload.salaryRange, salaryRange);
    for (const key of ['salary', 'salaryMin', 'salaryMax', 'salaryCurrency', 'salaryPeriod']) assert.equal(job[key], undefined);
  });
}
for (const salaryRange of [undefined, null, [], '85000', {}, { min: null, max: null },
  { min: NaN, max: 10 }, { min: 1, max: Infinity }, { min: -1, max: 10 },
  { min: 20, max: 10 }, { min: '10', max: 20 }, { min: false, max: 20 }, { min: 1, max: {} }]) {
  await check(`lever rejects absent or invalid salary range ${String(salaryRange)} ${JSON.stringify(salaryRange)}`, async () => {
    assert.deepEqual(parseLeverSalaryBands({ salaryRange }), []);
    const [job] = await fetchRows([{ ...posting('salary'), salaryRange, salaryDescriptionPlain: '$100k' }]);
    assert.deepEqual(job.salaryBands, []);
    assert.equal(job.rawPayload.salaryRange, salaryRange);
  });
}

await check('lever tolerates malformed rows, categories, descriptions and identifiers', async () => {
  const rows = [null, 7, 'bad', [], {}, { ...posting(123), text: {}, categories: 'bad', lists: {}, additionalPlain: 7 },
    { ...posting('bad-id'), id: NaN, categories: { location: {}, allLocations: 'Madrid' }, descriptionPlain: null },
    { ...posting('locations'), categories: { allLocations: ['Paris', 'Berlin'] } }];
  const jobs = await fetchRows(rows);
  assert.equal(jobs.length, 3);
  assert.equal(jobs[0].sourceJobId, '123');
  assert.equal(jobs[1].sourceJobId, '');
  assert.equal(jobs[2].location, 'Paris · Berlin');
  for (const job of jobs) {
    for (const field of ['title', 'url', 'company', 'location', 'description']) assert.equal(typeof job[field], 'string');
  }
});

await check('lever treats an empty initial array as a valid board without vacancies or warnings', async () => {
  let calls = 0;
  const result = await captureWarnings(() => lever.fetch(entry, {
    fetchJson: async () => { calls++; return []; },
  }));
  assert.deepEqual(result, { value: [], warnings: [] });
  assert.equal(calls, 1);
});

for (const hostedUrl of [undefined, null, '', '   ', 7, [], {}, 'not a url',
  '/fixture-co/a', '//jobs.lever.co/fixture-co/a', 'https://', 'https://[invalid',
  'javascript:alert(1)', 'data:text/plain,job', 'ftp://jobs.lever.co/a',
  'https://user:pass@jobs.lever.co/a', 'https://jobs.lever.co/a b',
  'https://jobs.lever.co/a\nb', 'https://jobs.lever.co\\a']) {
  await check(`lever drops unusable URL ${JSON.stringify(hostedUrl)} before reserving its ID`, async () => {
    const valid = posting('a');
    const jobs = await fetchRows([{ ...valid, hostedUrl }, valid]);
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].rawPayload, valid);
    assert.equal(jobs[0].url, valid.hostedUrl);
    assert.equal(jobs[0].sourceJobId, 'a');
  });
}

await check('lever drops identity-less rows while preserving surrounding valid postings', async () => {
  const first = posting('a');
  const last = posting('b');
  const jobs = await fetchRows([{}, first, { id: ' ', hostedUrl: '' }, null, [],
    { id: NaN, hostedUrl: 'invalid' }, { id: 'id-only' }, last, {}]);
  assert.deepEqual(jobs.map(job => job.rawPayload), [first, last]);
});

await check('lever accepts and deduplicates valid URLs without inventing missing IDs', async () => {
  const rows = [undefined, null, '', '  ', NaN, {}, false].map((id, index) => ({
    ...posting(`url-only-${index}`), id,
  }));
  rows.push({ hostedUrl: 'http://jobs.lever.co/fixture-co/http-url-only' });
  const jobs = await fetchRows([...rows, ...rows]);
  assert.deepEqual(jobs.map(job => job.rawPayload), rows);
  assert.ok(jobs.every(job => job.sourceJobId === ''));
  assert.deepEqual(jobs.map(job => job.url), rows.map(row => row.hostedUrl));
});

await check('lever skips ID-only rows across pages without suppressing a later usable posting', async () => {
  const first = posting('a');
  const last = posting('b');
  const pages = [[first, { id: 'b' }], [last]];
  let calls = 0;
  const jobs = await lever.fetch({ ...entry, api: 'https://api.lever.co/v0/postings/fixture-co?limit=2' }, {
    fetchJson: async () => pages[calls++],
  });
  assert.deepEqual(jobs.map(job => job.rawPayload), [first, last]);
  assert.equal(calls, 2);
});

await check('lever paginates with skip/limit, preserves filters and forces one JSON mode', async () => {
  const requests = [];
  const pages = [[posting('a'), posting('b')], [posting('b'), posting('c')], [posting('d')]];
  const jobs = await lever.fetch({ ...entry, api: 'https://api.eu.lever.co/v0/postings/fixture-co?team=AI&team=Data&mode=html&mode=xml&limit=2&skip=4&location=Madrid' }, {
    fetchJson: async (url, opts) => {
      const parsed = new URL(url);
      requests.push(parsed);
      assert.equal(opts.redirect, 'error');
      assert.equal(opts.headers.Accept, 'application/json');
      assert.deepEqual(parsed.searchParams.getAll('mode'), ['json']);
      assert.deepEqual(parsed.searchParams.getAll('team'), ['AI', 'Data']);
      assert.equal(parsed.searchParams.get('location'), 'Madrid');
      return pages[requests.length - 1];
    },
  });
  assert.deepEqual(requests.map(url => url.searchParams.get('skip')), ['4', '6', '8']);
  assert.deepEqual(jobs.map(job => job.sourceJobId), ['a', 'b', 'c', 'd']);
});

await check('lever stops at an empty final page after a full page', async () => {
  let calls = 0;
  const jobs = await lever.fetch({ ...entry, api: 'https://api.lever.co/v0/postings/fixture-co?limit=1' }, {
    fetchJson: async () => ++calls === 1 ? [posting('a')] : [],
  });
  assert.equal(calls, 2);
  assert.equal(jobs.length, 1);
});

await check('lever stops repeated pages and reports partial results', async () => {
  let calls = 0;
  const result = await captureWarnings(() => lever.fetch({ ...entry, api: 'https://api.lever.co/v0/postings/fixture-co?limit=1' }, {
    fetchJson: async () => { calls++; return [posting('a')]; },
  }));
  assert.equal(calls, 2);
  assert.equal(result.value.length, 1);
  assert.match(result.warnings[0], /partial results.*repeated page/);
});

await check('lever deduplicates by ID or URL and stops changed pages containing only duplicates', async () => {
  let calls = 0;
  const result = await captureWarnings(() => lever.fetch({ ...entry, api: 'https://api.lever.co/v0/postings/fixture-co?limit=2' }, {
    fetchJson: async () => ++calls === 1 ? [posting('a'), posting('b')]
      : [{ ...posting('a'), hostedUrl: 'https://jobs.lever.co/new' }, { ...posting('c'), hostedUrl: posting('b').hostedUrl }],
  }));
  assert.equal(calls, 2);
  assert.equal(result.value.length, 2);
  assert.match(result.warnings[0], /partial results/);
});

for (const collision of ['id', 'url']) {
  for (const paginated of [false, true]) {
    await check(`lever does not reserve ${collision === 'id' ? 'URLs' : 'IDs'} from discarded duplicates ${paginated ? 'across pages' : 'within a page'}`, async () => {
      const first = posting('a');
      const third = posting('b');
      const duplicate = collision === 'id'
        ? { ...first, hostedUrl: third.hostedUrl }
        : { ...third, hostedUrl: first.hostedUrl };
      const pages = paginated ? [[first, duplicate], [third]] : [[first, duplicate, third]];
      let calls = 0;
      const jobs = await lever.fetch({ ...entry,
        api: `https://api.lever.co/v0/postings/fixture-co?limit=${paginated ? 2 : 100}`,
      }, { fetchJson: async () => pages[calls++] ?? [] });
      assert.deepEqual(jobs.map(job => job.rawPayload), [first, third]);
      assert.deepEqual(jobs.map(job => job.sourceJobId), ['a', 'b']);
      assert.deepEqual(jobs.map(job => job.url), [first.hostedUrl, third.hostedUrl]);
      assert.equal(calls, paginated ? 2 : 1);
    });
  }
}

for (const [config, context, expected] of [
  [{ max_pages: 2 }, {}, 2], [{ max_pages: 5 }, { maxPages: 1 }, 1],
  [{ max_pages: 1 }, { maxPages: 5 }, 1], [{}, {}, 50],
  [{ max_pages: 99999 }, { maxPages: 99999 }, 200],
  [{ max_pages: -1 }, { maxPages: 0 }, 50], [{ max_pages: 1.5 }, { maxPages: NaN }, 50],
]) {
  await check(`lever respects pagination caps ${JSON.stringify(config)} ${JSON.stringify(context)}`, async () => {
    let calls = 0;
    const result = await captureWarnings(() => lever.fetch({ ...entry, ...config, api: 'https://api.lever.co/v0/postings/fixture-co?limit=1' }, {
      ...context, fetchJson: async () => [posting(String(++calls))],
    }));
    assert.equal(calls, expected);
    assert.equal(result.value.length, expected);
    assert.match(result.warnings[0], /partial results/);
  });
}

for (const body of [null, {}, { postings: [] }, 'nope', '', 0, false, undefined, new Error('fixture timeout')]) {
  await check(`lever retains prior pages and warns on intermediate failure ${String(body)}`, async () => {
    let calls = 0;
    const result = await captureWarnings(() => lever.fetch({ ...entry, api: 'https://api.lever.co/v0/postings/fixture-co?limit=1' }, {
      fetchJson: async () => {
        if (++calls === 1) return [posting('a')];
        if (body instanceof Error) throw body;
        return body;
      },
    }));
    assert.equal(calls, 2);
    assert.deepEqual(result.value.map(job => job.sourceJobId), ['a']);
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0], /partial results.*page 2 failed/);
    assert.match(result.warnings[0], body instanceof Error ? /fixture timeout/ : /lever: FixtureCo: invalid postings response/);
  });
}

await check('lever propagates first-page request errors', async () => {
  await assert.rejects(lever.fetch(entry, { fetchJson: async () => { throw new Error('fixture network failure'); } }), /fixture network failure/);
});

for (const query of ['limit=0', 'limit=101', 'limit=-1', 'limit=1.5', 'limit=bad', 'limit=', 'skip=-1', 'skip=0.5', 'skip=Infinity', 'skip=9007199254740992', 'skip=']) {
  await check(`lever rejects unsafe pagination ${query} before fetching`, async () => {
    let called = false;
    await assert.rejects(lever.fetch({ ...entry, api: `https://api.lever.co/v0/postings/fixture-co?${query}` }, {
      fetchJson: async () => { called = true; return []; },
    }), /invalid pagination/);
    assert.equal(called, false);
  });
}

await check('lever stops safely before skip loses integer precision', async () => {
  let calls = 0;
  const result = await captureWarnings(() => lever.fetch({ ...entry, api: 'https://api.lever.co/v0/postings/fixture-co?skip=9007199254740991&limit=1' }, {
    fetchJson: async () => { calls++; return [posting('a')]; },
  }));
  assert.equal(calls, 1);
  assert.equal(result.value.length, 1);
  assert.equal(result.warnings.length, 1);
});

for (const api of [
  'http://api.lever.co/v0/postings/acme', 'https://api.lever.co.evil.test/v0/postings/acme',
  'https://api.lever.co@evil.test/v0/postings/acme', 'https://user:pass@api.lever.co/v0/postings/acme',
  'https://api.lever.co:444/v0/postings/acme', 'https://api.lever.co/v0/postings/',
  'https://api.lever.co/v0/postings/acme/posting-id', 'https://api.lever.co/v1/postings/acme',
  'https://api.lever.co/v0/postings/acme%2Fevil', 'https://api.lever.co/v0/postings/%2e%2e/acme',
  'https://api.lever.co/evil/../v0/postings/acme', 'https://api.lever.co/v0/postings/acme#fragment',
  'https://api.lever.co/v0/postings/acme\\evil', 'https://api.lever.co/other',
  'https://api.lever.co/v0/postings/ac\nme',
]) {
  await check(`lever rejects malicious or unsupported API URL ${api}`, async () => {
    assert.equal(lever.detect({ name: 'X', api }), null);
    let called = false;
    await assert.rejects(lever.fetch({ name: 'X', api }, { fetchJson: async () => { called = true; return []; } }));
    assert.equal(called, false);
  });
}
for (const careers_url of [
  'http://jobs.lever.co/acme', 'https://user@jobs.lever.co/acme', 'https://jobs.lever.co:444/acme',
  'https://jobs.lever.co/%2Fevil', 'https://jobs.lever.co/../acme', 'https://jobs.lever.co/a/../acme',
  'https://jobs.lever.co/acme%3Fevil', 'https://jobs.lever.co/acme\\evil',
  'https://jobs.lever.co/ac\tme',
]) {
  await check(`lever rejects unsafe careers URL ${careers_url}`, () => {
    assert.equal(lever.detect({ name: 'X', careers_url }), null);
  });
}

await check('lever supports trusted EU and US API boards with safe slugs and trailing slash', async () => {
  for (const host of ['api.lever.co', 'api.eu.lever.co']) {
    const api = `https://${host}/v0/postings/Acme_123-test/`;
    assert.equal(lever.detect({ name: 'X', api }).url, api);
    assert.deepEqual(await fetchRows([], { name: 'X', api }), []);
  }
});

await check('lever enrichment survives the real JSON serializer with no invented simple salary', async () => {
  const source = { ...posting('serialized'), country: 'ES', applyUrl: 'https://jobs.lever.co/fixture-co/serialized/apply',
    categories: { location: 'Madrid', allLocations: ['Madrid', 'Berlin'], team: 'AI', commitment: 'Full-time' },
    workplaceType: 'remote', descriptionPlain: 'Build AI', additionalPlain: 'More details', createdAt: 0,
    salaryRange: { min: 85000, max: 175000, currency: 'USD', interval: 'per-year-salary' } };
  const [job] = await fetchRows([source]);
  const serialized = JSON.parse(JSON.stringify(serializeOfferForJson(job)));
  assert.equal(serialized.sourceJobId, 'serialized');
  assert.equal(serialized.location, 'Madrid · Berlin');
  assert.equal(serialized.description, 'Build AI\n\nMore details');
  assert.equal(serialized.postedAt, 0);
  assert.equal(serialized.workplaceTypeRaw, 'remote');
  assert.deepEqual(serialized.salaryBands, job.salaryBands);
  assert.deepEqual(serialized.rawPayload, source);
  assert.equal(serialized.salary, null);
  assert.equal(serialized.salaryMin, null);
  assert.equal(serialized.salaryMax, null);
  assert.equal(serialized.salaryPeriod, '');
});
