// Stage 3: build the app's drug index from stages 1–2.
// Usage: npx tsx scripts/pipeline/3-build.ts
//
// Output (pipeline-data/dist/):
//   catalog.json          searchable list of drugs → strengths (bundled in the app)
//   shards/<rxcui>.json   one small file per drug strength, downloaded on demand
//   stats.json            coverage numbers for sanity checks

import { gzipSync } from 'node:zlib';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { shardFromLabels, type CatalogDrug, type DrugCatalog } from '../../src/core/shard';
import { loadLabel } from './1-labels';
import { DIST, MAPPING_JSON, progress, readJson, RXNORM_JSON, writeJson, type MappingFile, type RxnormFile } from './common';

/**
 * Ingredient part of an RxNorm name, used to group strengths under one drug:
 *   "atorvastatin 20 MG Oral Tablet"                         → "atorvastatin"
 *   "0.3 ML epinephrine 1 MG/ML Auto-Injector"               → "epinephrine"
 *   "amlodipine 5 MG / benazepril hydrochloride 10 MG Oral…" → "amlodipine / benazepril hydrochloride"
 */
export function ingredientOf(name: string): string {
  const cleaned = name
    .replace(/^NDA\d+\s+/, '')
    .replace(/^[\d.]+\s+(ML|HR|MG|ACTUAT|CM2|G)\s+/i, '') // leading package/duration quantity
    .replace(/^(Once-Daily|Extended Release|Abuse-Deterrent)\s+/i, '');
  const parts = cleaned.split(' / ').map((seg) => seg.split(/\s+(?=[\d.]+\s*(MG|MCG|UNT|ML|%|MEQ|MMOL|G\b|IU|ACTUAT|BAU|AU|PNU|MG\/ML))/i)[0]);
  return parts.map((p) => p.trim().toLowerCase()).join(' / ');
}

const display = (ingredient: string) => ingredient.replace(/(^|\/\s)([a-z])/g, (_, p, c) => p + c.toUpperCase());

function formRank(name: string): number {
  if (/ Oral Tablet$/.test(name)) return 0;
  if (/ Oral Capsule$/.test(name)) return 1;
  if (/Oral/.test(name)) return 2;
  if (/Auto-Injector|Inject/.test(name)) return 3;
  return 4;
}

function main() {
  const mapping = readJson<MappingFile>(MAPPING_JSON);
  const rxnorm = readJson<RxnormFile>(RXNORM_JSON);
  rmSync(join(DIST, 'shards'), { recursive: true, force: true });

  const groups = new Map<string, CatalogDrug>();
  const scds = Object.keys(rxnorm.scd);
  const started = Date.now();
  let written = 0;
  let totalBytes = 0;
  let totalGz = 0;
  let noLabels = 0;

  scds.forEach((rxcui, i) => {
    const info = rxnorm.scd[rxcui];
    const setids = new Set([rxcui, ...info.brands.map((b) => b.rxcui)].flatMap((c) => mapping.rxcuiSetids[c] ?? []));
    const labels = [...setids].map(loadLabel);
    const shard = shardFromLabels(rxcui, info.name, labels, new Set(info.codes), {
      labelsFound: setids.size,
      labelsFailed: labels.filter((l) => !l).length,
    });
    if (shard.labelsMatched === 0) {
      noLabels++;
      return;
    }

    const file = join(DIST, 'shards', `${rxcui}.json`);
    writeJson(file, shard);
    const raw = readFileSync(file);
    totalBytes += raw.length;
    totalGz += gzipSync(raw).length;
    written++;

    const ingredient = ingredientOf(info.name);
    const drug = groups.get(ingredient) ?? { name: display(ingredient), brands: [], strengths: [] };
    for (const b of info.brands) {
      const brand = b.name.match(/\[([^\]]+)\]$/)?.[1]?.replace(/\s+Reformulated.*$/, '');
      if (brand && !drug.brands.includes(brand)) drug.brands.push(brand);
    }
    drug.strengths.push({ rxcui, name: info.name });
    groups.set(ingredient, drug);

    if ((i + 1) % 2000 === 0) progress('shards', i + 1, scds.length, started);
  });

  const drugs = [...groups.values()].sort((a, b) => a.name.localeCompare(b.name));
  for (const d of drugs) {
    d.brands.sort();
    d.strengths.sort((a, b) => formRank(a.name) - formRank(b.name) || a.name.localeCompare(b.name, undefined, { numeric: true }));
  }
  const catalog: DrugCatalog = { v: 1, builtAt: new Date().toISOString().slice(0, 10), drugs };
  writeJson(join(DIST, 'catalog.json'), catalog);
  const catalogBytes = readFileSync(join(DIST, 'catalog.json'));

  const stats = {
    builtAt: catalog.builtAt,
    drugs: drugs.length,
    strengths: written,
    strengthsWithoutLabels: noLabels,
    shardsMB: +(totalBytes / 1e6).toFixed(1),
    shardsGzippedMB: +(totalGz / 1e6).toFixed(1),
    catalogKB: Math.round(catalogBytes.length / 1024),
    catalogGzippedKB: Math.round(gzipSync(catalogBytes).length / 1024),
  };
  writeJson(join(DIST, 'stats.json'), stats);
  console.log(stats);
}

if (require.main === module) main();
