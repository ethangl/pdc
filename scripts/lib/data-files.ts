// The TypeScript shape of every JSON file the scripts exchange, plus a
// reader per file and one JSON writer. See AGENTS.md and paths.ts: committed
// files live in curated/, generated files in data/.

import * as fs from "node:fs";
import type { Taxonomy } from "./taxonomy.js";
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
  /** Null when the node question was skipped (root none) or answered none;
   * `rawNodeChoice` tells which. */
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

/** Removes records whose `node` names a taxonomy node id the tree no longer
 * has. Applies to every status: an override record can name a removed node
 * too. Pure, so it is tested directly rather than through a file on disk. */
export function dropRemovedNodes(
  items: ClassificationItem[],
  taxonomy: Taxonomy,
): { items: ClassificationItem[]; droppedCores: string[] } {
  const kept: ClassificationItem[] = [];
  const droppedCores: string[] = [];
  for (const item of items) {
    if ("node" in item && item.node !== null && !taxonomy.nodes.has(item.node)) {
      droppedCores.push(item.core);
      continue;
    }
    kept.push(item);
  }
  return { items: kept, droppedCores };
}

/** Reads the committed classifications file, dropping any record that names
 * a node the current taxonomy no longer has (see `dropRemovedNodes`). This
 * is the one place that check runs; callers get an already-clean file. */
export function readClassifications(taxonomy: Taxonomy): { file: ClassificationsFile | null; droppedCores: string[] } {
  if (!fs.existsSync(CLASSIFICATIONS_PATH)) return { file: null, droppedCores: [] };
  const raw = JSON.parse(fs.readFileSync(CLASSIFICATIONS_PATH, "utf8")) as ClassificationsFile;
  const { items, droppedCores } = dropRemovedNodes(raw.items, taxonomy);
  return { file: { ...raw, items }, droppedCores };
}

// --- curated/overrides.json ---

export type Overrides = Record<string, string | null>;

/** Overrides whose non-null value names a node the taxonomy lacks, or names
 * a category node (an override must resolve to a concrete ingredient, not a
 * generic bucket). Returns each bad entry as "core -> node". */
export function invalidOverrides(overrides: Overrides, taxonomy: Taxonomy): string[] {
  const problems: string[] = [];
  for (const [core, node] of Object.entries(overrides)) {
    if (node === null) continue;
    const target = taxonomy.nodes.get(node);
    if (!target || taxonomy.isCategory(node)) {
      problems.push(`${core} -> ${node}`);
    }
  }
  return problems;
}

/** Reads curated/overrides.json. This file is hand-edited, so a target that
 * does not name an existing non-category node is not silently dropped: it
 * fails loudly. */
export function readOverrides(taxonomy: Taxonomy): Overrides {
  if (!fs.existsSync(OVERRIDES_PATH)) return {};
  const overrides = JSON.parse(fs.readFileSync(OVERRIDES_PATH, "utf8")) as Overrides;
  const problems = invalidOverrides(overrides, taxonomy);
  if (problems.length > 0) {
    throw new Error(`curated/overrides.json has ${problems.length} invalid entr${problems.length === 1 ? "y" : "ies"}:\n${problems.join("\n")}`);
  }
  return overrides;
}
