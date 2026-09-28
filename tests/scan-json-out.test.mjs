import { execFileSync } from 'child_process';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

import { fail, finish, pass } from './helpers.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HERE);
const NODE = process.execPath;

console.log('\nscan.mjs — --json-out structured file');

// Run scan.mjs inside an isolated temporary directory.
//
// The fixture provider is local, so this test:
// - makes no network requests;
// - does not touch the real data/ directory;
// - does not depend on the current Remotive feed;
// - verifies the actual CLI wiring of --json-out.
{
  const dir = mkdtempSync(join(tmpdir(), 'scan-json-out-'));

  try {
    mkdirSync(join(dir, 'data'), { recursive: true });

    writeFileSync(
      join(dir, 'data', 'applications.md'),
      `# Applications Tracker

| # | Date | Company | Role | Score | Status | PDF | Report | Notes |
|---|------|---------|------|-------|--------|-----|--------|-------|
`,
    );

    writeFileSync(
      join(dir, 'data', 'pipeline.md'),
      '# Pipeline\n\n',
    );

    const portals = join(dir, 'portals.yml');

    writeFileSync(
      portals,
      `title_filter:
  positive:
    - "Strategic Finance"

tracked_companies:
  - name: Fixture Defense
    careers_url: https://boards.example.com/fixture
    parser:
      command: node
      script: tests/fixtures/three-city-board.mjs
`,
    );

    const output = join(dir, 'scan-output.json');

    execFileSync(
      NODE,
      [
        join(ROOT, 'scan.mjs'),
        '--json-out',
        output,
      ],
      {
        cwd: dir,
        env: {
          ...process.env,
          CAREER_OPS_PORTALS: portals,
        },
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );

    if (existsSync(output)) {
      pass('--json-out creates the requested JSON file');
    } else {
      fail('--json-out did not create the requested JSON file');
    }

    if (existsSync(output)) {
      let payload = null;

      try {
        payload = JSON.parse(readFileSync(output, 'utf-8'));
        pass('generated output is valid JSON');
      } catch (err) {
        fail(`generated output is not valid JSON: ${err.message}`);
      }

      if (payload) {
        if (payload.schemaVersion === 1) {
          pass('JSON output uses schemaVersion 1');
        } else {
          fail(`schemaVersion is ${payload.schemaVersion}, expected 1`);
        }

        if (Array.isArray(payload.offers)) {
          pass('JSON output contains an offers array');
        } else {
          fail('JSON output does not contain an offers array');
        }

        if (
          Array.isArray(payload.offers)
          && payload.offersCount === payload.offers.length
        ) {
          pass('offersCount matches offers.length');
        } else {
          fail('offersCount does not match offers.length');
        }

        if (payload.offersCount === 1) {
          pass('scan exports the single post-dedup fixture offer');
        } else {
          fail(`scan exported ${payload.offersCount} offers, expected 1`);
        }

        const offer = Array.isArray(payload.offers)
          ? payload.offers[0]
          : null;

        const hasCoreFields = offer
          && typeof offer.title === 'string'
          && offer.title.trim() !== ''
          && typeof offer.url === 'string'
          && offer.url.startsWith('http')
          && typeof offer.company === 'string'
          && offer.company.trim() !== '';

        if (hasCoreFields) {
          pass('exported offer preserves the core structured fields');
        } else {
          fail('exported offer is missing required core structured fields');
        }

        if (
          offer?.employmentTypeRaw === ''
          && offer?.workingTimeRaw === 'full_time'
          && offer?.rawPayload?.fixtureJobType === 'full_time'
        ) {
          pass('JSON output preserves employment, working-time, and raw metadata');
        } else {
          fail(`JSON output metadata = ${JSON.stringify({
            employmentTypeRaw: offer?.employmentTypeRaw,
            workingTimeRaw: offer?.workingTimeRaw,
            rawPayload: offer?.rawPayload,
          })}`);
        }
      }
    }
  } catch (err) {
    fail(`--json-out CLI test failed: ${err.message}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

finish();