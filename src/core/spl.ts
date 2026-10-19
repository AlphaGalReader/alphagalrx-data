// Minimal parser for FDA Structured Product Labeling (SPL) XML from DailyMed.
// Regex-based on purpose: labels follow a fixed HL7 structure, and this avoids
// pulling an XML library into the app bundle.

import type { Ingredient, Label, Product } from './types';

const NDC_SYSTEM = '2.16.840.1.113883.6.69';
const UNII_SYSTEM = '2.16.840.1.113883.4.9';

const ACTIVE_CLASSES = new Set(['ACTIM', 'ACTIB', 'ACTIR']);
const INACTIVE_CLASSES = new Set(['IACT']);

function decode(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Normalize an NDC labeler-product code to 5-4 digits so SPL codes
 * ("0093-5057", "12345-678") line up with RxNorm's 11-digit NDCs.
 */
export function normalizeProductCode(code: string): string | null {
  const parts = code.split('-');
  if (parts.length < 2) return null;
  return `${parts[0].padStart(5, '0')}-${parts[1].padStart(4, '0')}`;
}

/** "00093505705" (NDC-11) → "00093-5057" */
export function productCodeFromNdc11(ndc11: string): string | null {
  if (!/^\d{11}$/.test(ndc11)) return null;
  return `${ndc11.slice(0, 5)}-${ndc11.slice(5, 9)}`;
}

function parseIngredients(block: string): Ingredient[] {
  const out: Ingredient[] = [];
  const re = /<ingredient classCode="(\w+)">([\s\S]*?)<\/ingredient>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(block))) {
    const cls = m[1];
    const role = ACTIVE_CLASSES.has(cls) ? 'active' : INACTIVE_CLASSES.has(cls) ? 'inactive' : null;
    if (!role) continue;
    const substance = m[2].match(/<ingredientSubstance>([\s\S]*?)(?:<activeMoiety>|<\/ingredientSubstance>)/);
    if (!substance) continue;
    const unii = substance[1].match(new RegExp(`code="([^"]+)" codeSystem="${UNII_SYSTEM.replace(/\./g, '\\.')}"`));
    const name = substance[1].match(/<name>([\s\S]*?)<\/name>/);
    if (!name) continue;
    out.push({ role, unii: unii ? unii[1] : null, name: decode(name[1]).toUpperCase() });
  }
  return out.length ? out : parseLegacyIngredients(block);
}

/**
 * Labels from before ~2009 use an older layout: <activeIngredient> and
 * <inactiveIngredient> elements instead of <ingredient classCode="…">, and often
 * free-text names without UNII codes.
 */
function parseLegacyIngredients(block: string): Ingredient[] {
  const out: Ingredient[] = [];
  const re = /<(activeIngredient|inactiveIngredient)>([\s\S]*?)<\/\1>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(block))) {
    const role = m[1] === 'activeIngredient' ? 'active' : 'inactive';
    const substance = m[2].match(/IngredientSubstance>([\s\S]*?)(?:<activeMoiety>|<\/\w+IngredientSubstance>)/);
    if (!substance) continue;
    const unii = substance[1].match(new RegExp(`code="([^"]+)" codeSystem="${UNII_SYSTEM.replace(/\./g, '\\.')}"`));
    const name = substance[1].match(/<name>([\s\S]*?)<\/name>/);
    if (!name) continue;
    out.push({ role, unii: unii ? unii[1] : null, name: decode(name[1]).toUpperCase() });
  }
  return out;
}

// Sentences in the label text that introduce an ingredient list, e.g.
// "Inactive ingredients: …" or "The capsule shells contain: gelatin, …".
const TEXT_LIST_START =
  /(?:inactive ingredients?[^:;.]{0,60}[:;]|capsule shells?[^:;.]{0,60}?(?:contains?|consists? of|composed of|made (?:of|from))\s*:?)/gi;
// A list ends at a sentence break. "No. 6" (dye names) isn't one, since a digit follows.
const SENTENCE_END = /\.\s+(?=[A-Z])/;

/**
 * Backup for labels without a structured ingredient list: read the ingredient
 * lists written in the label text. One paragraph may cover several strengths,
 * so every list found is returned together (conservative: flags anything mentioned).
 */
export function extractTextIngredients(xml: string): string[] {
  const text = decode(xml.replace(/<[^>]+>/g, ' '));
  const names = new Set<string>();
  for (const m of text.matchAll(TEXT_LIST_START)) {
    const rest = text.slice((m.index ?? 0) + m[0].length, (m.index ?? 0) + m[0].length + 700);
    const list = rest.split(SENTENCE_END)[0];
    for (const raw of list.split(/,|;|\band\b/i)) {
      const name = raw.replace(/^\s*(and|or)\s+/i, '').replace(/[.\s]+$/, '').trim();
      if (name.length >= 3 && name.length <= 60 && /[a-z]/i.test(name)) names.add(name.toUpperCase());
    }
  }
  return [...names];
}

export function parseSpl(xml: string, meta: { setid: string; title: string; publishedDate: string }): Label {
  const labelerMatch = xml.match(/<author>[\s\S]*?<representedOrganization>[\s\S]*?<name>([\s\S]*?)<\/name>/);
  const products: Product[] = [];

  // Each product sits in its own <subject><manufacturedProduct> block. Kits nest
  // their parts inside one block, so ingredients of all parts are combined.
  const subjects = xml.split(/<subject>\s*<manufacturedProduct>/).slice(1);
  for (const raw of subjects) {
    const block = raw.split(/<\/manufacturedProduct>\s*<\/subject>/)[0];
    const code = block.match(new RegExp(`<code code="([^"]+)" codeSystem="${NDC_SYSTEM.replace(/\./g, '\\.')}"`));
    const ndcProduct = code ? normalizeProductCode(code[1]) : null;
    if (!ndcProduct) continue;
    const name = block.match(/<name>([\s\S]*?)<\/name>/);
    const form = block.match(/<formCode [^>]*displayName="([^"]+)"/);
    products.push({
      ndcProduct,
      name: name ? decode(name[1]) : '',
      form: form ? decode(form[1]) : '',
      ingredients: parseIngredients(block),
    });
  }

  // Products whose structured list has no inactive ingredients fall back to the label text.
  const missing = products.filter((p) => !p.ingredients.some((i) => i.role === 'inactive'));
  if (missing.length) {
    const fromText = extractTextIngredients(xml);
    for (const p of missing) {
      p.ingredients.push(...fromText.map((name) => ({ role: 'inactive' as const, unii: null, name, fromText: true })));
    }
  }

  return {
    setid: meta.setid,
    title: meta.title,
    publishedDate: meta.publishedDate,
    labeler: labelerMatch ? decode(labelerMatch[1]) : '',
    products,
  };
}
