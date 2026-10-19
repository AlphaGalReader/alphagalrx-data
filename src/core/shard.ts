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

    for (const product of products) {
      const signature = `${product.form}|${inactiveNames(product.ingredients).join('; ')}`;
      let group = groups.get(signature);
      if (!group) {
        group = { form: product.form, ingredients: product.ingredients, labelers: [], labelCount: 0, setid: label.setid };
        groups.set(signature, group);
      }
      if (label.labeler && !group.labelers.includes(label.labeler)) group.labelers.push(label.labeler);
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
