// Sanity checks on a freshly built index. Fails (exit 1) so a broken monthly
// build is never published to patients. Uses only raw label data (no clinical
// rules), so it also runs in the public data repository.
// Usage: npx tsx scripts/pipeline/check.ts

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { DrugCatalog, DrugShard } from '../../src/core/shard';
import { DIST, readJson } from './common';

const problems: string[] = [];
const expect = (ok: boolean, message: string) => {
  if (!ok) problems.push(message);
};

const shard = (rxcui: string): DrugShard | null => {
  const file = join(DIST, 'shards', `${rxcui}.json`);
  return existsSync(file) ? readJson<DrugShard>(file) : null;
};
const contains = (s: DrugShard | null, pattern: RegExp, role?: 'active' | 'inactive') =>
  !!s?.formulations.some((f) => f.ingredients.some((i) => (!role || i.role === role) && pattern.test(i.name)));

const catalog = readJson<DrugCatalog>(join(DIST, 'catalog.json'));
const strengths = catalog.drugs.reduce((n, d) => n + d.strengths.length, 0);
expect(catalog.drugs.length > 3000, `only ${catalog.drugs.length} drugs in catalog`);
expect(strengths > 10000, `only ${strengths} strengths in catalog`);

// Known answers, checked every month.
const atorva = shard('617310'); // atorvastatin 20 MG Oral Tablet
expect(!!atorva && atorva.formulations.length > 20, 'atorvastatin 20 mg missing or too few formulations');
expect(
  !!atorva?.formulations.some((f) => f.labelers.some((l) => /viatris|pfizer|parke/i.test(l))),
  'atorvastatin 20 mg is missing the Lipitor (brand) label',
);
expect(contains(shard('198051'), /\bGELATIN\b/, 'inactive'), 'omeprazole 20 mg capsules should include gelatin formulations');

const heparin = catalog.drugs.find((d) => d.name.toLowerCase().startsWith('heparin sodium, porcine'));
expect(!!heparin && contains(shard(heparin.strengths[0].rxcui), /HEPARIN/, 'active'), 'heparin data missing');

expect(!!shard('1870207'), 'EpiPen 0.3 mg missing'); // NDA019430 0.3 ML epinephrine 1 MG/ML Auto-Injector

if (problems.length) {
  console.error(`❌ Index check failed:\n- ${problems.join('\n- ')}`);
  process.exit(1);
}
console.log(`✅ Index check passed: ${catalog.drugs.length} drugs, ${strengths} strengths.`);
