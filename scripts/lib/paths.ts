// Central path constants for every file scripts/ reads or writes. Committed
// inputs live under curated/; everything else lives under data/, is
// generated, and is gitignored. See AGENTS.md's policy and README.md's Data
// section.

// --- repo root ---

export const ENV_LOCAL_PATH = ".env.local";

// --- curated/ (committed, hand-edited or classifier output) ---

export const TAXONOMY_PATH = "curated/taxonomy.json";
export const OVERRIDES_PATH = "curated/overrides.json";
export const CLASSIFICATIONS_PATH = "curated/classifications.json";

// --- data/ (generated, gitignored) ---

export const RAW_CACHE_DIR = "data/source/punchdrink";
export const JEV_CACHE_DIR = "data/cache/jev";
export const REVIEW_DIR = "data/cache";
export const INGREDIENTS_RAW_PATH = "data/ingredients-raw.json";
export const INGREDIENTS_PREPROCESSED_PATH = "data/ingredients-preprocessed.json";
export const RECIPES_PATH = "data/recipes.json";
