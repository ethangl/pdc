import { stripHtml } from "./punchdrink-cache.js";

export interface PreprocessedIngredient {
  raw: string;
  core: string;
  alternatives?: string[];
  preferred?: string;
  flags: {
    houseMade: boolean;
    optional: boolean;
    infused: boolean;
    garnishLike: boolean;
  };
  removed: string[];
}

// Ported from PD2's punchdrink-cache.ts extractPreferred: brand recommendations
// trail as "..., preferably X" / "(such as X)" / "..., ideally X".
const PREFERRED_RE = /\b(?:preferably|such as|ideally)\b\s+(.+)$/i;

// Punchdrink ingredient descriptions carry the same brand recommendations as
// a trailing clause. Pull the brand back out of the description when the
// ingredient field itself did not carry one.
export function extractPreferred(rawDescription: string): string | undefined {
  const cleaned = stripHtml(rawDescription)
    .replace(/^\(|\)$/g, "")
    .replace(/^[\s,;]+/, "")
    .trim();
  if (!cleaned) return undefined;

  const match = cleaned.match(PREFERRED_RE);
  if (!match) return undefined;

  return match[1].replace(/[\s).,;]+$/, "").trim() || undefined;
}

// The opening "(" is required, but some source data closes it with "}"
// instead of ")" ("(see editor's note}"), and some descriptions carry the
// phrase with no brackets at all ("see Editor's Note"). Tolerate both.
const HOUSE_MADE_RE = /\(?\s*see\s+editor'?s?'?\s+note\s*[)}]?/i;

export function mentionsEditorsNote(text: string): boolean {
  // Descriptions arrive raw; the site writes "Editor’s" with a curly apostrophe.
  return HOUSE_MADE_RE.test(text.replace(/[‘’]/g, "'"));
}

const OPTIONAL_RES: RegExp[] = [
  /\(\s*optional\s*\)/i,
  /(,\s*)?\bto top\b/i,
  /(,\s*)?\bto float\b/i,
  /(,\s*)?\bto rinse\b/i,
  /\bfor rinsing\b/i,
  /\bas needed\b/i,
];

// Trailing single-word descriptor parentheticals that carry no brand/amount
// information and are safe to drop outright ("(optional)" is handled above
// since it also sets the optional flag).
const TRAILING_DESCRIPTOR_PAREN_RE = /\(\s*(chilled|crushed|cold|hot)\s*\)\s*$/i;

const LEADING_RATIO_RES: RegExp[] = [
  /^\d+(?:\.\d+)?\s*:\s*\d+\s+/,
  /^\d+(?:\.\d+)?\s*%\s+/,
  /^\d+\s+percent\s+/i,
];

const LEADING_PAREN_AMOUNT_RE = /^\([^()]*\)\s*/;
const TRAILING_PROOF_PAREN_RE = /\s*\(\d+\s*proof\)\s*$/i;
const LEADING_COUNT_UNIT_RE =
  /^\d+(?:\s+\d+\/\d+)?\s+(?:dash|dashes|drop|drops|ounce|ounces|oz|teaspoon|teaspoons|tsp|tablespoon|tablespoons|tbsp|barspoon|barspoons|cup|cups|bottle|bottles|piece|pieces|sprig|sprigs|slice|slices)\s+(?:of\s+)?/i;

// "juice of 1 lime" -> "lime juice"; "juice and zest of 3 lemons, separated"
// -> "lemon juice" (the trailing clause is swallowed by the ".*$" tail).
const JUICE_OF_RE = /^juice (?:and zest )?of (?:\d+(?:\/\d+)?|half a|a|one) (\w+?)s?\b.*$/i;

// "zest of 1 orange" -> "orange zest"; "peels of 2 grapefruits" -> "grapefruit peel".
const ZEST_OF_RE = /^(zest|peel|peels|rind) of (?:\d+(?:\/\d+)?|half a|a|one) (\w+?)s?\b.*$/i;

const RATIO_PAREN_RE = /\([^()]*\d+\s*:\s*\d+[^()]*\)/gi;

// The keyword must be attached with a hyphen or directly preceded by a word;
// a comma before it ("Bing cherries, washed and pitted") means it belongs to
// a trailing clause, not an infusion base, so commas are excluded from the
// leading capture.
const INFUSION_RE = /^([^,]+?)[- ](infused|washed|fat-washed|macerated)\s+(.+)$/i;

// Phrases whose first word looks like a strippable leading modifier (cold,
// hot, dry, small, large) but is actually part of the term itself.
const PROTECTED_LEADING_PHRASES = [
  "cold brew",
  "cold-brew",
  "hot sauce",
  "hot chocolate",
  "hot toddy",
  "dry ice",
  "small batch",
  "large format",
];

// Longest phrases first so multi-word modifiers match before their
// single-word substrings could.
const LEADING_MODIFIERS = [
  "freshly squeezed",
  "fresh-squeezed",
  "freshly-squeezed",
  "good-quality",
  "high-quality",
  "house-made",
  "cold-pressed",
  "housemade",
  "homemade",
  "organic",
  "chilled",
  "muddled",
  "crushed",
  "strained",
  "lightly",
  "quality",
  "sliced",
  "diced",
  "whole",
  "large",
  "small",
  "ripe",
  "cold",
  "hot",
  "warm",
  "good",
  "very",
  "fresh",
  "minced",
  "chopped",
].sort((a, b) => b.length - a.length);

// Standalone base spirits/ingredients that should never have a second
// alternative's trailing word glued onto them (see STANDALONE_INGREDIENT_WORDS).
const STANDALONE_INGREDIENT_WORDS = new Set([
  "bourbon",
  "rye",
  "gin",
  "vodka",
  "rum",
  "tequila",
  "mezcal",
  "cognac",
  "brandy",
  "whiskey",
  "whisky",
  "scotch",
  "campari",
  "aperol",
  "cynar",
  "champagne",
  "prosecco",
  "cava",
  "cointreau",
  "curaçao",
  "absinthe",
  "pisco",
  "cachaça",
  "sherry",
  "port",
  "madeira",
  "vermouth",
  "beer",
  "cider",
  "honey",
  "sugar",
  "water",
  "milk",
  "cream",
]);

const PROOF_AGE_RES: RegExp[] = [/^\d+[- ]proof\s+/i, /^\d+[- ]year(?:-old)?\s+/i];

const TRAILING_CLAUSE_RE =
  /,\s*(chilled|to taste|divided|washed|pitted|peeled|halved|quartered|cut|sliced|separated|roughly|approximately|plus|more|about|frozen|hand squeezed)\b.*$/i;

const BERRY_SUFFIX_RE = /berries$/;

const PLURAL_MAP: Record<string, string> = {
  leaves: "leaf",
  cherries: "cherry",
  berries: "berry",
  olives: "olive",
  cubes: "cube",
  wheels: "wheel",
  slices: "slice",
  dashes: "dash",
  drops: "drop",
};

// Plain "drop the trailing s" nouns. "cloves" and "leaves"/"wheels" (irregular,
// handled above) are deliberately excluded.
const S_PLURAL_WORDS = new Set([
  "lemons",
  "limes",
  "oranges",
  "peaches",
  "grapes",
  "eggs",
  "pineapples",
  "peels",
  "apples",
  "pears",
  "bananas",
  "apricots",
  "plums",
  "figs",
  "cucumbers",
  "clementines",
  "twists",
  "wedges",
  "sprigs",
  "sticks",
  "pods",
  "seeds",
  "peppercorns",
  "chips",
  "chunks",
  "beans",
  "coins",
]);

const SINGULARIZE_EXCLUDE = new Set([
  "bitters",
  "citrus",
  "hibiscus",
  "molasses",
  "schnapps",
  "angostura",
  "cassis",
]);

const GARNISH_WORDS = new Set([
  "twist",
  "peel",
  "rind",
  "wheel",
  "wedge",
  "disk",
  "slice",
  "sprig",
  "leaf",
  "leaves",
  "zest",
]);

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function trimPunctuation(value: string): string {
  return value.trim().replace(/^[\s,;]+/, "").replace(/[\s,;]+$/, "").trim();
}

/** Removes the first match of `re` from `text`, records the trimmed
 * fragment in `removed`, and returns the resulting (trimmed) text - or null
 * when `re` did not match. Shared by preprocessIngredient's own `strip` and
 * finishCore's, so there is one place that knows how a strip step records
 * what it removed. */
function stripMatch(text: string, re: RegExp, removed: string[], replacement = " "): string | null {
  const match = text.match(re);
  if (!match) return null;
  removed.push(match[0].trim());
  return trimPunctuation(text.replace(re, replacement));
}

// Built once at module load, longest modifier first (as LEADING_MODIFIERS
// already is), so stripLeadingModifiers doesn't recompile a regex per word
// per call.
const LEADING_MODIFIER_RES: { mod: string; re: RegExp }[] = LEADING_MODIFIERS.map((mod) => ({
  mod,
  re: new RegExp(`^${escapeRegex(mod)}\\s+`, "i"),
}));

// Strips leading modifiers (repeatedly), unless the text starts with a
// protected phrase whose first word only looks like a modifier ("cold brew",
// "dry ice", "small batch", ...).
function stripLeadingModifiers(text: string, removed: string[]): string {
  if (PROTECTED_LEADING_PHRASES.some((phrase) => text.startsWith(phrase))) {
    return text;
  }
  let result = text;
  let changed = true;
  while (changed) {
    changed = false;
    for (const { mod, re } of LEADING_MODIFIER_RES) {
      if (re.test(result)) {
        removed.push(mod);
        result = result.replace(re, "");
        changed = true;
        break;
      }
    }
  }
  return result;
}

// After the preferred-brand step removes a trailing clause, a "(" that
// opened a parenthetical the clause was inside of can be left dangling.
// Drop from that "(" onward. Separately, strip a stray unmatched ")" or "}"
// left at the very end (e.g. a doubled closing paren in the source data).
function stripUnbalancedParens(text: string, removed: string[]): string {
  let depth = 0;
  let openIdx = -1;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "(") {
      if (depth === 0) openIdx = i;
      depth++;
    } else if (text[i] === ")") {
      depth = Math.max(0, depth - 1);
      if (depth === 0) openIdx = -1;
    }
  }
  let result = text;
  if (depth > 0 && openIdx !== -1) {
    removed.push(result.slice(openIdx).trim());
    result = trimPunctuation(result.slice(0, openIdx));
  }

  const opens = (result.match(/\(/g) ?? []).length;
  const closes = (result.match(/\)/g) ?? []).length;
  const braceOpens = (result.match(/\{/g) ?? []).length;
  const braceCloses = (result.match(/\}/g) ?? []).length;
  if (closes > opens || braceCloses > braceOpens) {
    const stripped = result.replace(/[\s)}]+$/, "");
    if (stripped !== result) {
      removed.push(result.slice(stripped.length).trim());
      result = stripped;
    }
  }
  return trimPunctuation(result);
}

// Steps 10, 12, 13, 14, 15: infusion/wash transform, proof/age qualifiers,
// trailing clauses, singularizing the last word, and garnish-word detection
// - the tail normalization shared by the core and every alternative
// (resolveLine matches candidates against `alternatives`, so an
// unnormalized alternative would never resolve the way its core does).
function finishCore(s: string, removed: string[]): { text: string; infused: boolean; garnishLike: boolean } {
  let text = s;
  const strip = (re: RegExp, replacement = " "): boolean => {
    const next = stripMatch(text, re, removed, replacement);
    if (next === null) return false;
    text = next;
    return true;
  };
  // Step 10: infusion / wash transform.
  let infused = false;
  const infusionMatch = text.match(INFUSION_RE);
  if (infusionMatch) {
    infused = true;
    removed.push(`${infusionMatch[1]}-${infusionMatch[2]}`);
    text = infusionMatch[3].trim();
  }
  // Step 12: proof/age qualifiers ("overproof" is a style word, not stripped).
  let changed = true;
  while (changed) {
    changed = false;
    for (const re of PROOF_AGE_RES) if (strip(re, "")) changed = true;
  }
  // Step 13: trailing clauses ("chilled", "to taste", "divided", prep notes).
  strip(TRAILING_CLAUSE_RE, "");
  // Step 14: singularize the last word for a small, safe set of plural nouns.
  const words = text.split(" ").filter(Boolean);
  if (words.length > 0) {
    const last = words[words.length - 1] as string;
    if (!SINGULARIZE_EXCLUDE.has(last) && !last.endsWith("ss")) {
      const singular = BERRY_SUFFIX_RE.test(last)
        ? last.replace(BERRY_SUFFIX_RE, "berry")
        : PLURAL_MAP[last] ?? (S_PLURAL_WORDS.has(last) ? last.slice(0, -1) : undefined);
      if (singular) {
        removed.push(`${last}→${singular}`);
        words[words.length - 1] = singular;
        text = words.join(" ");
      }
    }
  }
  // Step 15: garnish-like, stripping a trailing "for garnish" note.
  let garnishLike = false;
  if (strip(/\bfor garnish$/i, "")) garnishLike = true;
  const lastWord = text.split(" ").filter(Boolean).pop();
  if (lastWord && GARNISH_WORDS.has(lastWord)) garnishLike = true;
  return { text, infused, garnishLike };
}

export function preprocessIngredient(raw: string, description = ""): PreprocessedIngredient {
  const removed: string[] = [];
  // Step 1: normalize Unicode (NFC, so decomposed accents match taxonomy
  // aliases), strip HTML/trademark marks/quoted-word wrapping, tidy whitespace.
  let text = stripHtml(raw.normalize("NFC"))
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[®™]/g, "")
    .replace(/"([^"]*)"/g, "$1")
    .replace(/\s*[–—]\s*/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\*+$/, "")
    .trim();
  const fallback = text.toLowerCase();
  // True when `re` fired; mutates `text` via stripMatch.
  const strip = (re: RegExp, replacement = " "): boolean => {
    const next = stripMatch(text, re, removed, replacement);
    if (next === null) return false;
    text = next;
    return true;
  };
  // Step 2: house-made editor's-note marker (case-sensitive: step 6's brand
  // casing must survive; text lowercases at step 7).
  let houseMade = mentionsEditorsNote(description);
  if (strip(HOUSE_MADE_RE)) houseMade = true;
  // Step 3: optional markers and single-word descriptor parentheticals, run
  // before the preferred-brand step (6) so they aren't swallowed into it.
  const optional = OPTIONAL_RES.map((re) => strip(re)).includes(true);
  strip(TRAILING_DESCRIPTOR_PAREN_RE);
  // Step 4: leading ratio or percentage ("2:1 honey syrup", "20% saline solution").
  for (const re of LEADING_RATIO_RES) if (strip(re, "")) break;
  // Step 5: leaked amounts, and "juice of"/"zest of"/"peel of"/"rind of".
  strip(LEADING_PAREN_AMOUNT_RE, "");
  strip(TRAILING_PROOF_PAREN_RE, "");
  strip(LEADING_COUNT_UNIT_RE, "");
  let garnishLikeFromAmount = false;
  const juiceOfMatch = text.match(JUICE_OF_RE);
  if (juiceOfMatch) {
    removed.push(text);
    text = `${juiceOfMatch[1]} juice`;
  } else {
    const zestOfMatch = text.match(ZEST_OF_RE);
    if (zestOfMatch) {
      const kind = zestOfMatch[1]?.toLowerCase() === "peels" ? "peel" : zestOfMatch[1]?.toLowerCase();
      removed.push(text);
      text = `${zestOfMatch[2]} ${kind}`;
      garnishLikeFromAmount = true;
    }
  }
  // Step 6: preferred brand, falling back to the description's own.
  let preferred: string | undefined;
  const preferredMatch = text.match(PREFERRED_RE);
  if (preferredMatch && preferredMatch.index !== undefined) {
    preferred = preferredMatch[1].replace(/[\s).,;]+$/, "").trim() || undefined;
    removed.push(text.slice(preferredMatch.index).trim());
    text = trimPunctuation(text.slice(0, preferredMatch.index).replace(/[\s(]+$/, ""));
  }
  if (!preferred) preferred = extractPreferred(description);
  // Step 7: a "(" left dangling by step 6, or a stray trailing ")"/"}".
  text = stripUnbalancedParens(text, removed);
  text = text.toLowerCase(); // from here on we work lowercase
  // Step 8: ratio parentheticals, then any remaining long parenthetical (>25 chars).
  text = trimPunctuation(
    text.replace(RATIO_PAREN_RE, (match) => {
      removed.push(match);
      return " ";
    }),
  );
  text = trimPunctuation(
    text.replace(/\([^()]*\)/g, (match) => {
      if (match.length <= 25) return match;
      removed.push(match);
      return " ";
    }),
  );
  // Step 9: alternatives ("a or b", "a (or b)", "a, or b", "a, b, or c"). In
  // the plain `or` branch, the first side may itself be a comma list
  // ("scotch, bourbon, or brandy"): each comma-separated part becomes its
  // own alternative, not one combined string. (The parenthetical "(or x)"
  // branch never carries a comma list and always yields exactly two.) A
  // lone-adjective part ("fino" in "fino or manzanilla sherry") borrows the
  // last alternative's last word unless it stands alone
  // (STANDALONE_INGREDIENT_WORDS). Leading modifiers (step 11) strip from
  // each part here, before that decision.
  let alternatives: string[] | undefined;
  let alt1: string | undefined;
  let alt2: string | undefined;
  const orParenMatch = text.match(/^(.*?)\s*\(\s*or\s+([^)]+?)\s*\)\s*(.*)$/i);
  if (orParenMatch) {
    const prefix = orParenMatch[1].trim();
    const altWord = orParenMatch[2].trim();
    const suffix = orParenMatch[3].trim();
    alt1 = suffix ? `${prefix} ${suffix}`.trim() : prefix;
    alt2 = suffix ? `${altWord} ${suffix}`.trim() : altWord;
    removed.push(orParenMatch[0].trim());
  } else {
    const orMatch = text.match(/^(.+?),?\s+\bor\b\s+(.+)$/i);
    if (orMatch) {
      alt1 = orMatch[1].trim();
      alt2 = orMatch[2].trim();
      removed.push(orMatch[0].trim());
    }
  }
  if (alt1 !== undefined && alt2 !== undefined) {
    const leadParts = orParenMatch ? [alt1] : alt1.split(",").map((part) => part.trim()).filter(Boolean);
    const parts = [...leadParts, alt2].map((part) => stripLeadingModifiers(part, removed));
    const partWords = parts.map((part) => part.split(" ").filter(Boolean));
    const lastWords = partWords[partWords.length - 1] as string[];
    const finalParts = parts.map((part, i) => {
      if (i === parts.length - 1) return part;
      const words = partWords[i] as string[];
      return words.length === 1 && lastWords.length >= 2 && !STANDALONE_INGREDIENT_WORDS.has(words[0] as string)
        ? `${part} ${lastWords[lastWords.length - 1]}`
        : part;
    });
    alternatives = finalParts;
    text = finalParts[0] as string;
  }
  const hadAlternatives = alternatives !== undefined;
  // Step 11: strip leading modifiers repeatedly (protected phrases block
  // this); skipped when step 9 already ran it per-branch, since re-running
  // on a borrowed trailing noun would wrongly strip a word.
  if (!hadAlternatives) text = stripLeadingModifiers(text, removed);

  // Steps 10, 12, 13, 14, 15 (finishCore, above) run on every alternative,
  // not just `text` - resolveLine matches candidates against `alternatives`,
  // so an unnormalized alternative would never resolve the way its core does.
  let infused = false;
  let garnishLike = garnishLikeFromAmount;
  if (alternatives) {
    const finished = alternatives.map((alt) => finishCore(alt, removed));
    alternatives = finished.map((f) => f.text);
    for (const f of finished) {
      infused = infused || f.infused;
      garnishLike = garnishLike || f.garnishLike;
    }
    text = alternatives[0] as string;
  } else {
    const finished = finishCore(text, removed);
    text = finished.text;
    infused = finished.infused;
    garnishLike = garnishLike || finished.garnishLike;
  }
  // Step 16: final trim; fall back to the step-1 string if core is empty.
  const core = text.trim() || fallback;
  const result: PreprocessedIngredient = {
    raw,
    core,
    flags: { houseMade, optional, infused, garnishLike },
    removed,
  };
  if (alternatives) result.alternatives = alternatives;
  if (preferred) result.preferred = preferred;
  return result;
}
