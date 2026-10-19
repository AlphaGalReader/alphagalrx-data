// Stage 2: for every generic drug product (SCD), collect its NDC product codes and
// its brand-name versions (SBD) and their codes, from RxNorm.
// Usage: npx tsx scripts/pipeline/2-rxnorm.ts   (needs pipeline-data/mapping.json from stage 1)
//
// RxNav allows ~20 requests/second per IP, so requests are paced below that.
// Responses are cached for 25 days, so monthly reruns refresh them.

import { brandRxcuis, productCodesForRxcui, type TextFetcher } from '../../src/core/api';
import { cachedFetcher, MAPPING_JSON, mapLimit, progress, readJson, RXNAV_CACHE, RXNORM_JSON, sleep, writeJson, type MappingFile, type RxnormFile } from './common';

const MIN_INTERVAL_MS = 70; // ≈14 requests/second
const cached = cachedFetcher(RXNAV_CACHE, 25);

// Pace only real network calls; cache hits return immediately.
let nextSlot = 0;
const paced: TextFetcher = async (url) => {
  const now = Date.now();
  const wait = Math.max(0, nextSlot - now);
  nextSlot = Math.max(now, nextSlot) + MIN_INTERVAL_MS;
  if (wait) await sleep(wait);
  return cached(url);
};

async function main() {
  const mapping = readJson<MappingFile>(MAPPING_JSON);
  const scds = Object.keys(mapping.scdNames);
  const out: RxnormFile = { builtAt: new Date().toISOString().slice(0, 10), scd: {} };
  const brandNames = new Map<string, string>();

  const started = Date.now();
  let done = 0;
  const failures: string[] = [];
  await mapLimit(scds, 6, async (rxcui) => {
    try {
      const brands = await brandRxcuisWithNames(rxcui, paced, brandNames);
      const codeSets = await Promise.all([rxcui, ...brands.map((b) => b.rxcui)].map((c) => productCodesForRxcui(c, paced)));
      out.scd[rxcui] = {
        name: mapping.scdNames[rxcui],
        codes: [...new Set(codeSets.flatMap((s) => [...s]))],
        brands,
      };
    } catch (e) {
      failures.push(`${rxcui}\t${(e as Error).message}`);
    }
    if (++done % 500 === 0 || done === scds.length) progress('rxnorm', done, scds.length, started);
  });

  writeJson(RXNORM_JSON, out);
  console.log(`Done. ${Object.keys(out.scd).length} drug products, ${failures.length} failures.`);
  if (failures.length) console.log(failures.slice(0, 20).join('\n'));
}

/** Brand concepts for a generic, with names like "atorvastatin 20 MG Oral Tablet [Lipitor]". */
async function brandRxcuisWithNames(rxcui: string, fetchText: TextFetcher, names: Map<string, string>) {
  const ids = await brandRxcuis(rxcui, async (url) => {
    const text = await fetchText(url);
    for (const g of JSON.parse(text)?.relatedGroup?.conceptGroup ?? []) {
      for (const c of g.conceptProperties ?? []) names.set(c.rxcui, c.name);
    }
    return text;
  });
  return ids.map((id) => ({ rxcui: id, name: names.get(id) ?? '' }));
}

main();
