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

interface ClassificationBase {
  core: string;
  count: number;
}

/** Resolved by curated/overrides.json. `node` null means "not an ingredient". */
export interface OverrideClassification extends ClassificationBase {
  status: "override";
  node: string | null;
  root: string | null;
}

/** The API call failed; nothing is known. */
export interface ErrorClassification extends ClassificationBase {
  status: "error";
}

/** Answered by Jev. Node-question fields are null when the root answer was
 * "none" and the second request was skipped. */
export interface JevClassification extends ClassificationBase {
  status: "accepted" | "review" | "none" | "fallback";
  root: string;
  rootConfidence: number;
  rootTop3: Record<string, number>;
  node: string | null;
  nodeConfidence: number | null;
  nodeTop3: Record<string, number> | null;
  nodeProbabilities: Record<string, number> | null;
  rawNodeChoice: string | null;
  collapsed: boolean;
  /** Probability of "yes", from the SDK's NoulResponse.noul. */
  isBrand: number;
  isHousePrep: number;
  isGarnish: number;
}

/** One record in the committed classifications file. */
export type ClassificationItem = OverrideClassification | ErrorClassification | JevClassification;

export type ClassificationStatus = ClassificationItem["status"];

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
