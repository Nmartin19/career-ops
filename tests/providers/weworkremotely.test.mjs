// tests/providers/weworkremotely.test.mjs — moved verbatim from test-all.mjs (#1440).
import { pass, fail, ROOT } from '../helpers.mjs';
import { join } from 'path';
import { pathToFileURL } from 'url';

console.log('\nProvider — weworkremotely');


try {
  const wwrModule = await import(pathToFileURL(join(ROOT, 'providers/weworkremotely.mjs')).href);
  const weworkremotely = wwrModule.default;
  const { parseWwrFeed } = wwrModule;

  if (weworkremotely.id === 'weworkremotely') pass('weworkremotely.id is "weworkremotely"');
  else fail(`weworkremotely.id is ${JSON.stringify(weworkremotely.id)}`);

  const hit = weworkremotely.detect({ name: 'WWR', provider: 'weworkremotely' });
  if (hit && hit.url === 'https://weworkremotely.com/remote-jobs.rss') {
    pass('weworkremotely.detect() claims explicit provider config');
  } else {
    fail(`weworkremotely.detect() returned ${JSON.stringify(hit)}`);
  }

  if (weworkremotely.detect({ name: 'Remote Board', provider: 'remoteok' }) === null) {
    pass('weworkremotely.detect() ignores other provider ids');
  } else {
    fail('weworkremotely.detect() should only claim provider: weworkremotely');
  }

  const sample = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <item>
      <title><![CDATA[Acme & Co: Staff AI Engineer]]></title>
      <link>https://weworkremotely.com/remote-jobs/acme-staff-ai-engineer</link>
      <guid>https://weworkremotely.com/remote-jobs/acme-staff-ai-engineer</guid>
      <pubDate>Thu, 13 Nov 2025 14:10:41 +0000</pubDate>
      <expires_at>Sat, 13 Dec 2025 14:10:41 +0000</expires_at>
      <region><![CDATA[Anywhere in the World]]></region>
      <country>Spain</country>
      <state></state>
      <skills>SQL, Python, Power BI</skills>
      <category>Programming</category>
      <type>Full-Time</type>
      <description>&lt;p&gt;Build analytics solutions with &lt;strong&gt;SQL&lt;/strong&gt;.&lt;/p&gt;</description>
    </item>
    <item>
      <title>Principal Platform Engineer &amp; Tooling</title>
      <link>https://weworkremotely.com/remote-jobs/example-platform-engineer</link>
      <guid>https://weworkremotely.com/remote-jobs/example-platform-engineer</guid>
      <pubDate>Fri, 02 Jan 2026 09:00:00 +0000</pubDate>
      <region></region>
      <country></country>
      <state></state>
      <skills></skills>
      <category>DevOps and Sysadmin</category>
      <type>Contract</type>
      <description><![CDATA[<p>Platform engineering and infrastructure.</p>]]></description>
    </item>
    <item>
      <title>Missing Link Inc: Dropped Role</title>
      <pubDate>Fri, 02 Jan 2026 09:00:00 +0000</pubDate>
      <region>USA Only</region>
    </item>
    <item>
      <title>Bad Link Inc: Dropped Role</title>
      <link>/remote-jobs/bad-link</link>
      <region>Europe Only</region>
    </item>
    <item>
      <title>Off Host Inc: Dropped Role</title>
      <link>https://example.com/remote-jobs/off-host</link>
      <region>Internal</region>
    </item>
  </channel>
</rss>`;
  const jobs = parseWwrFeed(sample, 'WWR Board');

  if (jobs.length === 2) pass('parseWwrFeed keeps 2 items (drops missing/relative/off-host links)');
  else fail(`parseWwrFeed returned ${jobs.length} jobs (expected 2)`);

  if (jobs[0]?.company === 'Acme & Co' && jobs[0]?.title === 'Staff AI Engineer') {
    pass('parseWwrFeed splits "Company: Role" titles');
  } else {
    fail(`row 0 title/company = ${JSON.stringify({ title: jobs[0]?.title, company: jobs[0]?.company })}`);
  }

  if (jobs[0]?.url === 'https://weworkremotely.com/remote-jobs/acme-staff-ai-engineer') {
    pass('parseWwrFeed maps <link> to url');
  } else {
    fail(`row 0 url = ${JSON.stringify(jobs[0]?.url)}`);
  }

  if (jobs[0]?.location === 'Anywhere in the World') {
    pass('parseWwrFeed maps <region> to location');
  } else {
    fail(`row 0 location = ${JSON.stringify(jobs[0]?.location)}`);
  }

  if (jobs[0]?.postedAt === Date.parse('Thu, 13 Nov 2025 14:10:41 +0000')) {
    pass('parseWwrFeed parses pubDate -> postedAt');
  } else {
    fail(`row 0 postedAt = ${JSON.stringify(jobs[0]?.postedAt)}`);
  }

  if (jobs[1]?.company === 'WWR Board' && jobs[1]?.title === 'Principal Platform Engineer & Tooling') {
    pass('parseWwrFeed falls back to entry name and decodes entities');
  } else {
    fail(`row 1 = ${JSON.stringify(jobs[1])}`);
  }

  if (jobs[1]?.location === '' && jobs[1]?.category === 'DevOps and Sysadmin') {
    pass('parseWwrFeed keeps category separate from geographic location');
  } else {
    fail(`row 1 location/category = ${JSON.stringify({
      location: jobs[1]?.location,
      category: jobs[1]?.category,
    })}`);
  }

  if (jobs[0]?.category === 'Programming') {
    pass('parseWwrFeed preserves job category');
  } else {
    fail(`row 0 category = ${JSON.stringify(jobs[0]?.category)}`);
  }

  if (
    jobs[0]?.type === 'Full-Time' &&
    jobs[0]?.workingTimeRaw === 'Full-Time' &&
    jobs[0]?.employmentTypeRaw === '' &&
    jobs[1]?.type === 'Contract' &&
    jobs[1]?.workingTimeRaw === '' &&
    jobs[1]?.employmentTypeRaw === 'Contract'
  ) {
    pass('parseWwrFeed maps RSS type without confusing working time and employment type');
  } else {
    fail(`type mapping = ${JSON.stringify(jobs.map(job => ({
      type: job.type,
      workingTimeRaw: job.workingTimeRaw,
      employmentTypeRaw: job.employmentTypeRaw,
    })))}`);
  }

  if (jobs[0]?.country === 'Spain' && jobs[0]?.state === '') {
    pass('parseWwrFeed preserves country and empty state');
  } else {
    fail(`row 0 country/state = ${JSON.stringify({
      country: jobs[0]?.country,
      state: jobs[0]?.state,
    })}`);
  }

  if (
    jobs[0]?.skills === 'SQL, Python, Power BI' &&
    JSON.stringify(jobs[0]?.tags) === JSON.stringify(['SQL', 'Python', 'Power BI']) &&
    jobs[1]?.skills === '' &&
    Array.isArray(jobs[1]?.tags) &&
    jobs[1].tags.length === 0
  ) {
    pass('parseWwrFeed preserves source skills and normalizes them into tags');
  } else {
    fail(`skills/tags = ${JSON.stringify(jobs.map(job => ({
      skills: job.skills,
      tags: job.tags,
    })))}`);
  }

  const expectedDescription = '<p>Build analytics solutions with <strong>SQL</strong>.</p>';

  if (jobs[0]?.description === expectedDescription) {
    pass('parseWwrFeed decodes and preserves complete HTML description');
  } else {
    fail(`row 0 description = ${JSON.stringify(jobs[0]?.description)}`);
  }

  if (jobs[1]?.description === '<p>Platform engineering and infrastructure.</p>') {
    pass('parseWwrFeed preserves HTML description inside CDATA');
  } else {
    fail(`row 1 description = ${JSON.stringify(jobs[1]?.description)}`);
  }

  if (jobs[0]?.expiresAt === Date.parse('Sat, 13 Dec 2025 14:10:41 +0000')) {
    pass('parseWwrFeed parses expires_at into epoch milliseconds');
  } else {
    fail(`row 0 expiresAt = ${JSON.stringify(jobs[0]?.expiresAt)}`);
  }

  if (
    jobs[0]?.guid === 'https://weworkremotely.com/remote-jobs/acme-staff-ai-engineer' &&
    jobs[0]?.sourceJobId === 'https://weworkremotely.com/remote-jobs/acme-staff-ai-engineer'
  ) {
    pass('parseWwrFeed preserves GUID and maps it to sourceJobId');
  } else {
    fail(`row 0 guid/sourceJobId = ${JSON.stringify({
      guid: jobs[0]?.guid,
      sourceJobId: jobs[0]?.sourceJobId,
    })}`);
  }

  if (
    typeof jobs[0]?.rawPayload === 'string' &&
    jobs[0].rawPayload.includes('<title><![CDATA[Acme & Co: Staff AI Engineer]]></title>') &&
    jobs[0].rawPayload.includes('<description>') &&
    jobs[0].rawPayload.includes('<expires_at>')
  ) {
    pass('parseWwrFeed preserves original RSS item XML as rawPayload');
  } else {
    fail('row 0 rawPayload is missing or incomplete');
  }

  if (parseWwrFeed('', 'X').length === 0 && parseWwrFeed(null, 'X').length === 0) {
    pass('parseWwrFeed empty / non-string feed -> empty result (no crash)');
  } else {
    fail('parseWwrFeed empty / non-string feed should yield empty result');
  }

  let capturedUrl = null;
  let capturedOpts = null;
  const fetched = await weworkremotely.fetch(
    { name: 'WWR Board', provider: 'weworkremotely' },
    { fetchText: async (url, opts) => { capturedUrl = url; capturedOpts = opts; return sample; } },
  );

  if (capturedUrl === 'https://weworkremotely.com/remote-jobs.rss') {
    pass('weworkremotely.fetch() requests the pinned RSS feed URL');
  } else {
    fail(`weworkremotely.fetch() requested ${JSON.stringify(capturedUrl)}`);
  }

  if (capturedOpts && capturedOpts.redirect === 'error') {
    pass('weworkremotely.fetch() passes redirect:"error" to fetchText');
  } else {
    fail(`weworkremotely.fetch() should pass redirect:"error", got: ${JSON.stringify(capturedOpts)}`);
  }

  if (fetched[0]?.company === 'Acme & Co' && fetched[0]?.title === 'Staff AI Engineer') {
    pass('provider: weworkremotely config returns normalized jobs');
  } else {
    fail(`weworkremotely.fetch() normalized row = ${JSON.stringify(fetched[0])}`);
  }
} catch (e) {
  fail(`weworkremotely provider tests crashed: ${e.message}`);
}

