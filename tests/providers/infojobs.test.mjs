// tests/providers/infojobs.test.mjs
import { pass, fail, ROOT } from '../helpers.mjs';
import { join } from 'path';
import { pathToFileURL } from 'url';

console.log('\nProvider — infojobs');

const listPayload = {
  currentPage: 1,
  pageSize: 1,
  totalResults: 1,
  currentResults: 1,
  totalPages: 1,
  offers: [
    {
      id: 'offer-data-analyst-001',
      title: 'Data Analyst',
      link: 'https://www.infojobs.net/madrid/data-analyst/of-i0000000000000000000000000001',
      city: 'Madrid',
      province: {
        id: 33,
        value: 'Madrid',
      },
      author: {
        id: 'acme-analytics',
        name: 'Acme Analytics',
      },
      contractType: {
        id: 1,
        value: 'Indefinido',
      },
      workDay: {
        id: 1,
        value: 'Completa',
      },
      salaryMin: {
        id: 30000,
        value: '30.000 \u20ac',
      },
      salaryMax: {
        id: 40000,
        value: '40.000 \u20ac',
      },
      salaryPeriod: {
        id: 4,
        value: 'Bruto/a\u00f1o',
      },
      teleworking: {
        id: 2,
        value: 'Teletrabajo posible',
      },
      published: '2026-10-07T12:00:00Z',
    },
  ],
};

const detailPayload = {
  id: 'offer-data-analyst-001',
  title: 'Data Analyst',
  link: 'https://www.infojobs.net/madrid/data-analyst/of-i0000000000000000000000000001',
  city: 'Madrid',
  province: {
    id: 33,
    value: 'Madrid',
  },
  profile: {
    id: 'acme-analytics',
    name: 'Acme Analytics',
  },
  description: 'Buscamos un Data Analyst para analizar datos de producto y negocio.',
  minRequirements: 'Experiencia con SQL y Power BI.',
  desiredRequirements: 'Se valorar\u00e1 experiencia con Python.',
  contractType: {
    id: 1,
    value: 'Indefinido',
  },
  journey: {
    id: 1,
    value: 'Completa',
  },
  experienceMin: {
    value: 'Al menos 2 a\u00f1os',
  },
  jobLevel: {
    value: 'Empleado',
  },
  minPay: {
    amount: 30000,
    periodValue: 'Bruto/a\u00f1o',
  },
  maxPay: {
    amount: 40000,
    periodValue: 'Bruto/a\u00f1o',
  },
  creationDate: '2026-10-07T12:00:00.000+0000',
};

try {
  const infojobsModule = await import(
    pathToFileURL(join(ROOT, 'providers/infojobs.mjs')).href
  );
  const infojobs = infojobsModule.default;
  const { normalizeInfoJobsOffer } = infojobsModule;

  if (infojobs.id === 'infojobs') {
    pass('infojobs.id is "infojobs"');
  } else {
    fail(`infojobs.id is ${JSON.stringify(infojobs.id)}`);
  }
 const hit = infojobs.detect({
    name: 'InfoJobs',
    provider: 'infojobs',
  });

  if (
    hit
    && hit.url === 'https://api.infojobs.net/api/9/offer'
  ) {
    pass('infojobs.detect() claims explicit provider config');
  } else {
    fail(`infojobs.detect() returned ${JSON.stringify(hit)}`);
  }

  if (
    infojobs.detect({
      name: 'Jobicy',
      provider: 'jobicy',
    }) === null
  ) {
    pass('infojobs.detect() ignores other provider ids');
  } else {
    fail('infojobs.detect() should only claim provider: infojobs');
  }
  const normalized = normalizeInfoJobsOffer(
    listPayload.offers[0],
    detailPayload,
  );

  if (
    normalized?.sourceJobId === 'offer-data-analyst-001'
    && normalized?.title === 'Data Analyst'
    && normalized?.url === 'https://www.infojobs.net/madrid/data-analyst/of-i0000000000000000000000000001'
    && normalized?.company === 'Acme Analytics'
    && normalized?.location === 'Madrid'
  ) {
    pass('normalizeInfoJobsOffer maps core offer fields');
  } else {
    fail(`normalizeInfoJobsOffer core fields = ${JSON.stringify(normalized)}`);
  }
  if (
    normalized?.description === 'Buscamos un Data Analyst para analizar datos de producto y negocio.'
    && normalized?.minRequirements === 'Experiencia con SQL y Power BI.'
    && normalized?.desiredRequirements === 'Se valorar\u00e1 experiencia con Python.'
  ) {
    pass('normalizeInfoJobsOffer preserves description and requirements');
  } else {
    fail(`normalizeInfoJobsOffer description fields = ${JSON.stringify({
      description: normalized?.description,
      minRequirements: normalized?.minRequirements,
      desiredRequirements: normalized?.desiredRequirements,
    })}`);
  }
  if (
    normalized?.employmentTypeRaw === 'permanent'
    && normalized?.workingTimeRaw === 'full_time'
  ) {
    pass('normalizeInfoJobsOffer separates employment type and working time');
  } else {
    fail(`normalizeInfoJobsOffer employment metadata = ${JSON.stringify({
      employmentTypeRaw: normalized?.employmentTypeRaw,
      workingTimeRaw: normalized?.workingTimeRaw,
    })}`);
  }
  if (
    normalized?.salaryMin === 30000
    && normalized?.salaryMax === 40000
    && normalized?.salaryCurrency === 'EUR'
    && normalized?.salaryPeriod === 'yearly'
  ) {
    pass('normalizeInfoJobsOffer preserves structured salary metadata');
  } else {
    fail(`normalizeInfoJobsOffer salary metadata = ${JSON.stringify({
      salaryMin: normalized?.salaryMin,
      salaryMax: normalized?.salaryMax,
      salaryCurrency: normalized?.salaryCurrency,
      salaryPeriod: normalized?.salaryPeriod,
    })}`);
  }
  if (
    normalized?.experienceMinRaw === 'Al menos 2 a\u00f1os'
    && normalized?.jobLevelRaw === 'Empleado'
    && normalized?.rawPayload?.list === listPayload.offers[0]
    && normalized?.rawPayload?.detail === detailPayload
  ) {
    pass('normalizeInfoJobsOffer preserves experience, job level, and raw payload');
  } else {
    fail(`normalizeInfoJobsOffer experience/raw payload = ${JSON.stringify({
      experienceMinRaw: normalized?.experienceMinRaw,
      jobLevelRaw: normalized?.jobLevelRaw,
      hasRawList: normalized?.rawPayload?.list === listPayload.offers[0],
      hasRawDetail: normalized?.rawPayload?.detail === detailPayload,
    })}`);
  }
} catch (e) {
  fail(`infojobs provider tests crashed: ${e.message}`);
}
 