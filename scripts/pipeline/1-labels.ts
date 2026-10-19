// Stage 1: parse every DailyMed label linked to an RxNorm drug product.
// Usage:
//   npx tsx scripts/pipeline/1-labels.ts            full release (human Rx + OTC bulk files)
//   npx tsx scripts/pipeline/1-labels.ts --update   latest monthly update file only
//   npx tsx scripts/pipeline/1-labels.ts --parts human_rx_part1   (comma-separated subset, for testing)
//
// Uses DailyMed's bulk release files (the per-label API rate-limits large jobs).
// Each bulk file is a zip of per-label zips (XML + images); only the XML is read,
// only labels linked to RxNorm drug products are kept, and only a compact parsed
// summary is stored. Resumable: finished bulk files are recorded and skipped.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseSpl } from '../../src/core/spl';
import type { Label } from '../../src/core/types';
import { DATA, labelFile, MAPPING_JSON, progress, readJson, writeJson, type MappingFile } from './common';

const BASE = 'https://dailymed-data.nlm.nih.gov/public-release-files';
const PARTS = [
  ...Array.from({ length: 6 }, (_, i) => `release_human_rx_part${i + 1}`),
  ...Array.from({ length: 12 }, (_, i) => `release_human_otc_part${i + 1}`),
];
const BULK = join(DATA, 'bulk');
const STATE = join(DATA, 'bulk-state.json');

export interface StoredLabel extends Label {
  version: string;
}

interface State {
  done: Record<string, string>; // bulk file → date processed
}

function downloadMapping(): MappingFile {
  const zip = join(DATA, 'rxnorm_mappings.zip');
  execFileSync('curl', ['-sSfL', '--retry', '5', '-o', zip, `${BASE}/rxnorm_mappings.zip`]);
  const txt = execFileSync('unzip', ['-p', zip, 'rxnorm_mappings.txt'], { maxBuffer: 512 * 1024 * 1024 }).toString('utf8');
  rmSync(zip);

  const mapping: MappingFile = { builtAt: new Date().toISOString().slice(0, 10), setVersions: {}, rxcuiSetids: {}, scdNames: {} };
  for (const line of txt.split('\n').slice(1)) {
    const [setid, version, rxcui, rxstring, tty] = line.trim().split('|');
    if (tty !== 'SCD' && tty !== 'SBD') continue;
    mapping.setVersions[setid] = version;
    const sets = (mapping.rxcuiSetids[rxcui] ??= []);
    if (!sets.includes(setid)) sets.push(setid);
    if (tty === 'SCD') mapping.scdNames[rxcui] ??= rxstring;
  }
  return mapping;
}

/** Download one bulk zip, parse the labels we need, then delete it. */
function processBulkFile(name: string, wanted: Set<string>) {
  const zip = join(BULK, `${name}.zip`);
  const work = join(BULK, name);
  console.log(`⬇️  ${name}: downloading…`);
  // -C - resumes a partial download after an interruption.
  execFileSync('curl', ['-sSfL', '--retry', '5', '-C', '-', '-o', zip, `${BASE}/dm_spl_${name}.zip`], { stdio: 'inherit' });

  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  execFileSync('unzip', ['-q', '-o', zip, '-d', work]);

  const inner: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.zip')) inner.push(p);
    }
  };
  walk(work);

  let kept = 0;
  let skipped = 0;
  let failed = 0;
  const started = Date.now();
  inner.forEach((file, i) => {
    try {
      const xml = execFileSync('unzip', ['-p', file, '*.xml'], { maxBuffer: 256 * 1024 * 1024 }).toString('utf8');
      const setid = xml.match(/<setId root="([^"]+)"/)?.[1];
      const version = xml.match(/<versionNumber value="(\d+)"/)?.[1] ?? '';
      if (!setid || !wanted.has(setid)) {
        skipped++;
      } else {
        writeJson(labelFile(setid), { ...parseSpl(xml, { setid, title: '', publishedDate: '' }), version } satisfies StoredLabel);
        kept++;
      }
    } catch {
      failed++;
    }
    if ((i + 1) % 5000 === 0) progress(`   ${name}`, i + 1, inner.length, started);
  });

  rmSync(work, { recursive: true, force: true });
  rmSync(zip, { force: true });
  console.log(`✅ ${name}: kept ${kept}, not linked to a drug product ${skipped}, failed ${failed}`);
}

function latestMonthlyUpdate(): string {
  const html = execFileSync('curl', ['-sSfL', 'https://dailymed.nlm.nih.gov/dailymed/spl-resources-all-drug-labels.cfm']).toString();
  const m = html.match(/dm_spl_(monthly_update_[a-z]{3}\d{4})\.zip/);
  if (!m) throw new Error('Could not find the latest monthly update file on DailyMed.');
  return m[1];
}

function main() {
  mkdirSync(BULK, { recursive: true });
  console.log('Downloading DailyMed → RxNorm mapping…');
  const mapping = downloadMapping();
  writeJson(MAPPING_JSON, mapping);
  const wanted = new Set(Object.keys(mapping.setVersions));
  console.log(`${wanted.size} labels linked to ${Object.keys(mapping.scdNames).length} generic drug products`);

  const state: State = existsSync(STATE) ? readJson<State>(STATE) : { done: {} };
  const partsArg = process.argv.indexOf('--parts');
  const files = process.argv.includes('--update')
    ? [latestMonthlyUpdate()]
    : partsArg > 0
      ? process.argv[partsArg + 1].split(',')
      : PARTS;

  for (const name of files) {
    if (state.done[name]) {
      console.log(`⏭️  ${name}: already processed ${state.done[name]}`);
      continue;
    }
    processBulkFile(name, wanted);
    state.done[name] = new Date().toISOString().slice(0, 10);
    writeFileSync(STATE, JSON.stringify(state, null, 2));
  }

  const missing = [...wanted].filter((s) => !existsSync(labelFile(s)));
  writeFileSync(join(DATA, 'labels-missing.txt'), missing.join('\n'));
  console.log(`Done. ${wanted.size - missing.length}/${wanted.size} linked labels on disk (missing list: pipeline-data/labels-missing.txt).`);
}

if (require.main === module) main();

export const loadLabel = (setid: string): StoredLabel | null => {
  try {
    return JSON.parse(readFileSync(labelFile(setid), 'utf8'));
  } catch {
    return null;
  }
};
