// tests/providers/remotive.test.mjs
import { pass, fail, ROOT } from '../helpers.mjs';
import { join } from 'path';
import { pathToFileURL } from 'url';

console.log('\nProvider — remotive');

try {
  const remotiveModule = await import(
    pathToFileURL(join(ROOT, 'providers/remotive.mjs')).href
  );
  const remotive = remotiveModule.default;

  if (remotive.id === 'remotive') {
    pass('remotive.id is "remotive"');
  } else {
    fail(`remotive.id is ${JSON.stringify(remotive.id)}`);
  }

  const sample = {
    jobs: [
      {
        id: 12345,
        title: 'Staff AI Engineer',
        url: 'https://remotive.com/remote-jobs/acme-staff-ai-engineer',
        company_name: 'Acme Corp',
        candidate_required_location: 'Worldwide',
        description: '<p>Build <strong>AI systems</strong>.</p><ul><li>Python</li><li>SQL</li></ul>',
        publication_date: '2026-08-05T09:45:42',
        job_type: 'full_time',
        salary: '$100k - $130k',
        tags: ['python', ' sql ', '', 123],
        category: 'Software Development',
      },
      {
        id: 67890,
        title: '  Platform Engineer  ',
        url: '  https://remotive.com/remote-jobs/beta-platform-engineer  ',
        company_name: '',
      },
      {
        title: '',
        url: 'https://remotive.com/remote-jobs/bad-empty-title',
        company_name: 'Bad Co',
      },
      {
        title: 'Relative URL Role',
        url: '/remote-jobs/relative',
        company_name: 'Rel Co',
      },
    ],
  };

  let capturedUrl = null;
  let capturedOpts = null;

  const fetched = await remotive.fetch(
    { name: 'Remotive Board', provider: 'remotive' },
    {
      fetchJson: async (url, opts) => {
        capturedUrl = url;
        capturedOpts = opts;
        return sample;
      },
    },
  );

  if (capturedUrl === 'https://remotive.com/api/remote-jobs') {
    pass('remotive.fetch() requests the board-wide feed URL');
  } else {
    fail(`remotive.fetch() requested ${JSON.stringify(capturedUrl)}`);
  }

  if (capturedOpts && capturedOpts.redirect === 'error') {
    pass('remotive.fetch() passes redirect:"error" to fetchJson (SSRF guard)');
  } else {
    fail(
      `remotive.fetch() should pass redirect:"error", got: ${JSON.stringify(capturedOpts)}`,
    );
  }

  if (fetched.length === 2) {
    pass('remotive.fetch() keeps 2 valid jobs');
  } else {
    fail(`remotive.fetch() returned ${fetched.length} jobs (expected 2)`);
  }

  const first = fetched[0];

  if (
    first?.title === 'Staff AI Engineer' &&
    first?.url === 'https://remotive.com/remote-jobs/acme-staff-ai-engineer' &&
    first?.company === 'Acme Corp' &&
    first?.location === 'Worldwide'
  ) {
    pass('remotive.fetch() preserves core normalized fields');
  } else {
    fail(`remotive.fetch() core fields = ${JSON.stringify(first)}`);
  }

    if (
    first?.sourceJobId === '12345' &&
    first?.employmentTypeRaw === '' &&
    first?.workingTimeRaw === 'full_time' &&
    first?.salaryRaw === '$100k - $130k' &&
    first?.category === 'Software Development'
  ) {
    pass('remotive.fetch() preserves Remotive-specific metadata');
  } else {
    fail(`remotive.fetch() source metadata = ${JSON.stringify(first)}`);
  }

  if (
    typeof first?.description === 'string' &&
    first.description.includes('Build AI systems') &&
    first.description.includes('Python') &&
    first.description.includes('SQL') &&
    !first.description.includes('<p>') &&
    !first.description.includes('<li>')
  ) {
    pass('remotive.fetch() converts HTML description to plain text');
  } else {
    fail(`remotive.fetch() description = ${JSON.stringify(first?.description)}`);
  }

  const expectedPostedAt = Date.UTC(2026, 7, 5, 9, 45, 42);

  if (first?.postedAt === expectedPostedAt) {
    pass('remotive.fetch() converts publication_date to epoch milliseconds');
  } else {
    fail(`remotive.fetch() postedAt = ${JSON.stringify(first?.postedAt)}`);
  }
const explicitTimezone = await remotive.fetch(
  { name: 'Remotive Board', provider: 'remotive' },
  {
    fetchJson: async () => ({
      jobs: [
        {
          id: 24680,
          title: 'Timezone Role',
          url: 'https://remotive.com/remote-jobs/timezone-role',
          company_name: 'TZ Corp',
          publication_date: '2026-08-05T09:45:42+02:00',
        },
      ],
    }),
  },
);

const explicitTimezoneExpected = Date.parse(
  '2026-08-05T09:45:42+02:00',
);

if (explicitTimezone[0]?.postedAt === explicitTimezoneExpected) {
  pass('remotive.fetch() preserves explicit publication_date timezone offsets');
} else {
  fail(
    `remotive.fetch() explicit timezone postedAt = ${JSON.stringify(
      explicitTimezone[0]?.postedAt,
    )}`,
  );
}
  if (
    Array.isArray(first?.tags) &&
    first.tags.length === 2 &&
    first.tags[0] === 'python' &&
    first.tags[1] === 'sql'
  ) {
    pass('remotive.fetch() normalizes string tags');
  } else {
    fail(`remotive.fetch() tags = ${JSON.stringify(first?.tags)}`);
  }

  if (first?.rawPayload === sample.jobs[0]) {
    pass('remotive.fetch() preserves the original raw payload');
  } else {
    fail('remotive.fetch() does not preserve rawPayload');
  }

  const second = fetched[1];

  if (
    second?.title === 'Platform Engineer' &&
    second?.url === 'https://remotive.com/remote-jobs/beta-platform-engineer'
  ) {
    pass('remotive.fetch() trims title and url');
  } else {
    fail(
      `remotive.fetch() row 1 title/url = ${JSON.stringify({
        title: second?.title,
        url: second?.url,
      })}`,
    );
  }

  if (second?.company === 'Remotive Board') {
    pass('remotive.fetch() falls back to entry.name when company_name is empty');
  } else {
    fail(`remotive.fetch() row 1 company = ${JSON.stringify(second?.company)}`);
  }

  if (second?.location === '') {
    pass('remotive.fetch() yields empty location when location is absent');
  } else {
    fail(`remotive.fetch() row 1 location = ${JSON.stringify(second?.location)}`);
  }

  if (
    second?.description === '' &&
    second?.postedAt === undefined &&
    second?.sourceJobId === '67890' &&
    second?.employmentTypeRaw === '' &&
    second?.workingTimeRaw === '' &&
    second?.salaryRaw === '' &&
    Array.isArray(second?.tags) &&
    second.tags.length === 0 &&
    second?.category === ''
  ) {
    pass('remotive.fetch() handles absent optional metadata safely');
  } else {
    fail(`remotive.fetch() optional defaults = ${JSON.stringify(second)}`);
  }

  const noName = await remotive.fetch(
    {},
    {
      fetchJson: async () => ({
        jobs: [
          {
            title: 'Role',
            url: 'https://remotive.com/remote-jobs/x',
          },
        ],
      }),
    },
  );

  if (noName[0]?.company === 'Remotive') {
    pass('remotive.fetch() defaults company to "Remotive"');
  } else {
    fail(`remotive.fetch() default company = ${JSON.stringify(noName[0]?.company)}`);
  }

  let badResponseThrew = false;

  try {
    await remotive.fetch(
      { name: 'X', provider: 'remotive' },
      { fetchJson: async () => ({ wrong: true }) },
    );
  } catch (e) {
    badResponseThrew = /unexpected API response/.test(e.message);
  }

  if (badResponseThrew) {
    pass('remotive.fetch() throws on unexpected API response shape');
  } else {
    fail('remotive.fetch() should throw when the jobs array is absent');
  }
} catch (e) {
  fail(`remotive provider tests crashed: ${e.message}`);
}