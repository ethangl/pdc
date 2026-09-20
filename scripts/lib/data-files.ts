// The TypeScript shape of every JSON file the scripts exchange, plus a
// reader per file and one JSON writer. See AGENTS.md and paths.ts: committed
// files live in curated/, generated files in data/.

import * as fs from "node:fs";
import {
  INGREDIENTS_PREPROCESSED_PATH,
  CLASSIFICATIONS_PATH,
  OVERRIDES_PATH,
} from "./paths.js";

export function writeJson(path: string, value: unknown): void {
  fs.writeFileSync(path, JSON.stringify(value, null, 2) + "\n", "utf8");
}

// --- data/ingredients-raw.json ---

export interface RawIngredientItem {
  raw: string;
  count: number;
  slugs: string[];
}

export interface RawIngredientsFile {
  generatedAt: string;
  recipes: number;
  lines: number;
  distinct: number;
  items: RawIngredientItem[];
}

// --- data/ingredients-preprocessed.json ---

export interface PreprocessedItem {
  core: string;
  count: number;
  rawVariants: string[];
  flags: {
    houseMade: number;
    optional: number;
    infused: number;
    garnishLike: number;
  };
  preferred?: string[];
  slugs: string[];
}

export interface PreprocessedFile {
  generatedAt: string;
  distinctCores: number;
  items: PreprocessedItem[];
}

export function readPreprocessed(): PreprocessedFile {
  return JSON.parse(fs.readFileSync(INGREDIENTS_PREPROCESSED_PATH, "utf8"));
}

// --- curated/classifications.json ---

export type ClassificationStatus = "accepted" | "review" | "none" | "error" | "override" | "fallback";

/** One record in the committed classifications file. */
export interface ClassificationItem {
  core: string;
  count: number;
  status: ClassificationStatus;
  root: string | null;
  rootConfidence: number | null;
  node: string | null;
  nodeConfidence: number | null;
  rawNodeChoice: string | null;
  collapsed: boolean;
  isBrand: number | null;
  isHousePrep: number | null;
  isGarnish: number | null;
  rootTop3: Record<string, number> | null;
  nodeTop3: Record<string, number> | null;
  nodeProbabilities: Record<string, number> | null;
  fallbackApplied?: boolean;
}

export interface ClassificationsFile {
  generatedAt: string;
  taxonomyVersion: number;
  promptVersion: string;
  model: string;
  items: ClassificationItem[];
}

export function readClassifications(): ClassificationsFile | null {
  if (!fs.existsSync(CLASSIFICATIONS_PATH)) return null;
  return JSON.parse(fs.readFileSync(CLASSIFICATIONS_PATH, "utf8"));
}

// --- curated/overrides.json ---

export type Overrides = Record<string, string | null>;

export function readOverrides(): Overrides {
  if (!fs.existsSync(OVERRIDES_PATH)) return {};
  return JSON.parse(fs.readFileSync(OVERRIDES_PATH, "utf8"));
}
