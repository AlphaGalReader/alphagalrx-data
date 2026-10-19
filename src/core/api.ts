// Clients for the free public drug-data services:
//   RxNorm (National Library of Medicine) — drug names, strengths, NDC codes
//   DailyMed (National Library of Medicine) — FDA labels with ingredient lists
// Only drug names/codes are sent; no personal data ever leaves the device.

const RXNAV = 'https://rxnav.nlm.nih.gov/REST';
const DAILYMED = 'https://dailymed.nlm.nih.gov/dailymed/services/v2';

/** Injectable so scripts can add disk caching and the app can add memory caching. */
export type TextFetcher = (url: string) => Promise<string>;

export const defaultFetcher: TextFetcher = async (url) => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
};

export interface DrugConcept {
  rxcui: string;
  name: string;
  tty: 'SCD' | 'SBD' | string; // SCD = generic clinical drug, SBD = branded
}

/** Search RxNorm for specific drug products (name + strength + form). */
export async function searchDrugs(query: string, fetchText: TextFetcher = defaultFetcher): Promise<DrugConcept[]> {
  const json = JSON.parse(await fetchText(`${RXNAV}/drugs.json?name=${encodeURIComponent(query)}`));
  const groups: any[] = json?.drugGroup?.conceptGroup ?? [];
  const out: DrugConcept[] = [];
  for (const g of groups) {
    if (g.tty !== 'SCD' && g.tty !== 'SBD') continue;
    for (const c of g.conceptProperties ?? []) out.push({ rxcui: c.rxcui, name: c.name, tty: g.tty });
  }
  return out;
}

/** All NDC product codes (5-4) that RxNorm links to this drug concept. */
export async function productCodesForRxcui(rxcui: string, fetchText: TextFetcher = defaultFetcher): Promise<Set<string>> {
  const json = JSON.parse(await fetchText(`${RXNAV}/rxcui/${rxcui}/allhistoricalndcs.json`));
  const codes = new Set<string>();
  const concepts: any[] = json?.historicalNdcConcept?.historicalNdcTime ?? [];
  for (const t of concepts) {
    for (const n of t.ndcTime ?? []) {
      for (const ndc of n.ndc ?? []) {
        if (/^\d{11}$/.test(ndc)) codes.add(`${ndc.slice(0, 5)}-${ndc.slice(5, 9)}`);
      }
    }
  }
  return codes;
}

/** Branded concepts (SBD) for a generic one (SCD), e.g. atorvastatin 20 MG → [Lipitor] version. */
export async function brandRxcuis(rxcui: string, fetchText: TextFetcher = defaultFetcher): Promise<string[]> {
  const json = JSON.parse(await fetchText(`${RXNAV}/rxcui/${rxcui}/related.json?tty=SBD`));
  const groups: any[] = json?.relatedGroup?.conceptGroup ?? [];
  return groups.flatMap((g) => (g.conceptProperties ?? []).map((c: any) => c.rxcui as string));
}

export interface SplSummary {
  setid: string;
  title: string;
  publishedDate: string;
}

/** Every DailyMed label that contains this drug concept. */
export async function splsForRxcui(rxcui: string, fetchText: TextFetcher = defaultFetcher): Promise<SplSummary[]> {
  const out: SplSummary[] = [];
  let page = 1;
  for (;;) {
    const json = JSON.parse(await fetchText(`${DAILYMED}/spls.json?rxcui=${rxcui}&pagesize=100&page=${page}`));
    for (const s of json.data ?? []) out.push({ setid: s.setid, title: s.title, publishedDate: s.published_date });
    if (page >= (json.metadata?.total_pages ?? 1)) break;
    page++;
  }
  return out;
}

export function splXmlUrl(setid: string): string {
  return `${DAILYMED}/spls/${setid}.xml`;
}
