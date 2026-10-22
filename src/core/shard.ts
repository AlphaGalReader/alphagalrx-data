// Profile-independent drug data ("shards"): one drug strength's products grouped
// into distinct formulations. Contains no clinical rules, so the public data
// pipeline can use it without the app's ingredient rules.

import type { Ingredient, Label } from './types';

/** One distinct formulation, as stored in a precomputed shard. */
export interface ShardFormulation {
  form: string;
  ingredients: Ingredient[]; // actives + inactives of one representative product
  labelers: string[]; // distinct company names on the labels
  labelCount: number;
  setid: string; // example DailyMed label
  /** NDC product code ("00093-5057") → company on that label, for matching a scanned bottle. */
  codes?: Record<string, string>;
}

export interface DrugShard {
  v: 1;
  rxcui: string;
  name: string;
  builtAt: string; // ISO date
  labelsFound: number;
  labelsMatched: number; // labels with at least one product of this exact strength/form
  labelsFailed: number;
  formulations: ShardFormulation[];
}

export const inactiveNames = (ingredients: Ingredient[]) =>
  [...new Set(ingredients.filter((i) => i.role === 'inactive').map((i) => i.name))].sort();

/**
 * Group the products of one drug concept (identified by its NDC product codes)
 * into distinct formulations. Pure: used by buildShard and the full-index pipeline.
 */
export function shardFromLabels(
  rxcui: string,
  name: string,
  labels: (Label | null)[],
  codes: Set<string>,
  stats: { labelsFound: number; labelsFailed: number },
): DrugShard {
  const groups = new Map<string, ShardFormulation>();
  const labelsPerGroup = new Map<string, Set<string>>();
  let matched = 0;

  for (const label of labels) {
    if (!label) continue;
    const products = label.products.filter((p) => codes.has(p.ndcProduct));
    if (products.length === 0) continue;
    matched++;
    // A label's "own" labeler code: the one most of its products use (repackagers sometimes list the source NDC too).
    const prefixCounts = new Map<string, number>();
    for (const p of label.products) prefixCounts.set(p.ndcProduct.slice(0, 5), (prefixCounts.get(p.ndcProduct.slice(0, 5)) ?? 0) + 1);
    const ownPrefix = [...prefixCounts].sort((x, y) => y[1] - x[1])[0]?.[0];

    for (const product of products) {
      const signature = `${product.form}|${inactiveNames(product.ingredients).join('; ')}`;
      let group = groups.get(signature);
      if (!group) {
        group = { form: product.form, ingredients: product.ingredients, labelers: [], labelCount: 0, setid: label.setid, codes: {} };
        groups.set(signature, group);
      }
      if (label.labeler && !group.labelers.includes(label.labeler)) group.labelers.push(label.labeler);
      // Prefer the label filed by the code's own labeler when several labels list the same code.
      if (!(product.ndcProduct in group.codes!) || product.ndcProduct.startsWith(ownPrefix ?? '-')) {
        group.codes![product.ndcProduct] = label.labeler ?? '';
      }
      const seen = labelsPerGroup.get(signature) ?? new Set<string>();
      seen.add(label.setid);
      labelsPerGroup.set(signature, seen);
      group.labelCount = seen.size;
    }
  }

  return {
    v: 1,
    rxcui,
    name,
    builtAt: new Date().toISOString().slice(0, 10),
    labelsFound: stats.labelsFound,
    labelsMatched: matched,
    labelsFailed: stats.labelsFailed,
    formulations: [...groups.values()],
  };
}

/** Searchable list of drugs → strengths (catalog.json). */
export interface CatalogStrength {
  rxcui: string;
  name: string; // RxNorm name, e.g. "atorvastatin 20 MG Oral Tablet"
  label?: string; // display override, e.g. to tell same-strength auto-injectors apart
}

export interface CatalogDrug {
  name: string; // display name, e.g. "Atorvastatin"
  brands: string[];
  strengths: CatalogStrength[];
}

export interface DrugCatalog {
  v: 1;
  builtAt: string;
  drugs: CatalogDrug[];
}
