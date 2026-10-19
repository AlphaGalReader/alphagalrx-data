// Shared types for the Alpha-Gal Rx medication engine.
// This folder must stay free of React Native and Node-only APIs so the same
// code runs in the app and in the command-line report scripts.

/** How concerning an ingredient is for a person with alpha-gal syndrome. */
export type Tier =
  | 'mammalian' // 🔴 mammal-derived, reactions reported
  | 'possible' // 🟠 may be mammal-derived; the label does not state the source
  | 'profile' // 🟡 mammal-derived but low alpha-gal risk for most; matters for some profiles
  | 'info' // ℹ️ common ingredient whose source isn't stated; usually plant or synthetic
  | 'unknown' // ⚪ nothing flagged, but the label's ingredient list is missing or incomplete
  | 'none'; // 🟢 nothing flagged in a complete-looking ingredient list

/** Patient sensitivity profile; controls how 'profile' ingredients are treated. */
export interface SensitivityProfile {
  dairy: boolean; // reacts to milk products
  gelatin: boolean; // known gelatin reactions
  highlySensitive: boolean; // reacts to trace exposures / fumes
}

export const DEFAULT_PROFILE: SensitivityProfile = {
  dairy: false,
  gelatin: false,
  highlySensitive: false,
};

export type IngredientRole = 'active' | 'inactive';

export interface Ingredient {
  role: IngredientRole;
  unii: string | null; // FDA Unique Ingredient Identifier
  name: string; // FDA standardized substance name, upper case
  /** Read from the label's written text because the structured list was empty. */
  fromText?: boolean;
}

export interface Product {
  ndcProduct: string; // normalized 5-4 labeler-product code, e.g. "60505-2578"
  name: string;
  form: string; // e.g. "TABLET, FILM COATED"
  ingredients: Ingredient[];
}

export interface Label {
  setid: string;
  title: string;
  labeler: string;
  publishedDate: string;
  products: Product[];
}

export interface RuleMatch {
  ruleId: string;
  tier: Exclude<Tier, 'none' | 'unknown'>;
  group: 'dairy' | 'gelatin' | 'lanolin' | 'other';
  title: string;
  note: string;
  citations: string[];
}

export interface FlaggedIngredient {
  ingredient: Ingredient;
  match: RuleMatch;
  /** Tier after applying the patient's sensitivity profile. */
  effectiveTier: Tier;
}
