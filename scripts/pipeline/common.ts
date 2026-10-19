// Shared helpers for the full drug-index pipeline (scripts/pipeline/1-3).
// Working data lives in pipeline-data/ (git-ignored); output goes to pipeline-data/dist/.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const ROOT = join(__dirname, '..', '..');
export const DATA = join(ROOT, 'pipeline-data');
export const LABELS_DIR = join(DATA, 'labels');
export const RXNAV_CACHE = join(DATA, 'rxnav-cache');
export const DIST = join(DATA, 'dist');
for (const d of [DATA, LABELS_DIR, RXNAV_CACHE, DIST]) mkdirSync(d, { recursive: true });

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function writeJson(file: string, value: unknown) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value));
}

export function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(file, 'utf8')) as T;
}

/** Fetch text with retries and backoff (NLM services occasionally rate-limit or time out). */
export async function fetchText(url: string, attempts = 4): Promise<string> {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
      if (res.status === 404) throw Object.assign(new Error('HTTP 404'), { permanent: true });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (e) {
      if ((e as { permanent?: boolean }).permanent || attempt >= attempts) throw e;
      await sleep(1500 * attempt);
    }
  }
}

/** fetchText with an on-disk cache that expires after maxAgeDays. */
export function cachedFetcher(dir: string, maxAgeDays: number) {
  mkdirSync(dir, { recursive: true });
  return async (url: string): Promise<string> => {
    const file = join(dir, createHash('sha1').update(url).digest('hex'));
    if (existsSync(file) && Date.now() - statSync(file).mtimeMs < maxAgeDays * 86_400_000) {
      return readFileSync(file, 'utf8');
    }
    const text = await fetchText(url);
    writeFileSync(file, text);
    return text;
  };
}

export async function mapLimit<T>(items: T[], limit: number, fn: (item: T, index: number) => Promise<void>) {
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

/** Labels are stored as pipeline-data/labels/ab/abcdef….json to keep folders small. */
export const labelFile = (setid: string) => join(LABELS_DIR, setid.slice(0, 2), `${setid}.json`);

export interface MappingFile {
  builtAt: string;
  setVersions: Record<string, string>; // setid → SPL version
  rxcuiSetids: Record<string, string[]>; // SCD/SBD rxcui → setids
  scdNames: Record<string, string>; // SCD rxcui → RxNorm name
}

export const MAPPING_JSON = join(DATA, 'mapping.json');
export const RXNORM_JSON = join(DATA, 'rxnorm.json');

export interface RxnormFile {
  builtAt: string;
  scd: Record<string, { name: string; codes: string[]; brands: { rxcui: string; name: string }[] }>;
}

export function progress(label: string, done: number, total: number, started: number) {
  const secs = (Date.now() - started) / 1000;
  const rate = done / Math.max(secs, 1);
  const eta = rate > 0 ? Math.round((total - done) / rate / 60) : 0;
  console.log(`${label}: ${done}/${total} (${rate.toFixed(1)}/s, ~${eta} min left)`);
}
