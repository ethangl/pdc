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
    for (const mod of LEADING_MODIFIERS) {
      const re = new RegExp(`^${escapeRegex(mod)}\\s+`, "i");
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

export function preprocessIngredient(raw: string): PreprocessedIngredient {
  const removed: string[] = [];

  // Step 1: normalize Unicode to NFC (some source strings use decomposed
  // accents, e.g. "curac + combining cedilla", which otherwise miss taxonomy
  // aliases written in precomposed form), strip HTML, strip trademark/footnote
  // marks and quoted-word wrapping, trim, collapse whitespace, normalize
  // quotes/dashes.
  let stageA = stripHtml(raw.normalize("NFC"))
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[®™]/g, "")
    .replace(/"([^"]*)"/g, "$1")
    .replace(/\s*[–—]\s*/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\*+$/, "")
    .trim();

  const fallback = stageA.toLowerCase();

  // Step 2: house-made editor's-note marker. Extracted case-sensitively so
  // preferred-brand casing (step 6) survives; everything lowercases after.
  let houseMade = false;
  const houseMadeMatch = stageA.match(HOUSE_MADE_RE);
  if (houseMadeMatch) {
    houseMade = true;
    removed.push(houseMadeMatch[0]);
    stageA = trimPunctuation(stageA.replace(HOUSE_MADE_RE, " "));
  }

  // Step 3: optional markers, including single-word trailing descriptor
  // parentheticals ("(chilled)", "(crushed)", "(cold)", "(hot)"). Runs before
  // the preferred-brand step (step 6) so trailing "to top"/"(optional)"
  // markers aren't swallowed into the preferred text.
  let optional = false;
  for (const re of OPTIONAL_RES) {
    const match = stageA.match(re);
    if (match) {
      optional = true;
      removed.push(match[0].trim());
      stageA = trimPunctuation(stageA.replace(re, " "));
    }
  }
  const descriptorParenMatch = stageA.match(TRAILING_DESCRIPTOR_PAREN_RE);
  if (descriptorParenMatch) {
    removed.push(descriptorParenMatch[0].trim());
    stageA = trimPunctuation(stageA.replace(TRAILING_DESCRIPTOR_PAREN_RE, " "));
  }

  // Step 4: leading ratio or percentage ("2:1 honey syrup", "20% saline
  // solution", "20 percent saline solution").
  for (const re of LEADING_RATIO_RES) {
    const match = stageA.match(re);
    if (match) {
      removed.push(match[0].trim());
      stageA = trimPunctuation(stageA.replace(re, ""));
      break;
    }
  }

  // Step 5: leaked amounts. Leading parenthetical amount ("(750 ml) vodka"),
  // trailing "(N proof)", leading count+unit ("1 dash vanilla extract"), and
  // "juice of"/"zest of"/"peel of"/"rind of" transforms.
  const leadingParenMatch = stageA.match(LEADING_PAREN_AMOUNT_RE);
  if (leadingParenMatch) {
    removed.push(leadingParenMatch[0].trim());
    stageA = trimPunctuation(stageA.replace(LEADING_PAREN_AMOUNT_RE, ""));
  }
  const trailingProofMatch = stageA.match(TRAILING_PROOF_PAREN_RE);
  if (trailingProofMatch) {
    removed.push(trailingProofMatch[0].trim());
    stageA = trimPunctuation(stageA.replace(TRAILING_PROOF_PAREN_RE, ""));
  }
  const countUnitMatch = stageA.match(LEADING_COUNT_UNIT_RE);
  if (countUnitMatch) {
    removed.push(countUnitMatch[0].trim());
    stageA = trimPunctuation(stageA.replace(LEADING_COUNT_UNIT_RE, ""));
  }
  let garnishLikeFromAmount = false;
  const juiceOfMatch = stageA.match(JUICE_OF_RE);
  if (juiceOfMatch) {
    removed.push(stageA);
    stageA = `${juiceOfMatch[1]} juice`;
  } else {
    const zestOfMatch = stageA.match(ZEST_OF_RE);
    if (zestOfMatch) {
      const kind = zestOfMatch[1]?.toLowerCase() === "peels" ? "peel" : zestOfMatch[1]?.toLowerCase();
      removed.push(stageA);
      stageA = `${zestOfMatch[2]} ${kind}`;
      garnishLikeFromAmount = true;
    }
  }

  // Step 6: preferred brand.
  let preferred: string | undefined;
  const preferredMatch = stageA.match(PREFERRED_RE);
  if (preferredMatch && preferredMatch.index !== undefined) {
    preferred = preferredMatch[1].replace(/[\s).,;]+$/, "").trim() || undefined;
    removed.push(stageA.slice(preferredMatch.index).trim());
    stageA = trimPunctuation(stageA.slice(0, preferredMatch.index).replace(/[\s(]+$/, ""));
  }

  // Step 7: a "(" left dangling by step 6, or a stray trailing ")"/"}".
  stageA = stripUnbalancedParens(stageA, removed);

  // From here on we work lowercase.
  let working = stageA.toLowerCase();

  // Step 8: ratio parentheticals, then any remaining long parenthetical (>25 chars).
  working = working.replace(RATIO_PAREN_RE, (match) => {
    removed.push(match);
    return " ";
  });
  working = trimPunctuation(working);
  working = working.replace(/\([^()]*\)/g, (match) => {
    if (match.length > 25) {
      removed.push(match);
      return " ";
    }
    return match;
  });
  working = trimPunctuation(working);

  // Step 9: alternatives ("a or b", "a (or b)", "a, or b"). Split at most
  // once. When the first option is a lone adjective missing the shared noun
  // ("fino or manzanilla sherry"), borrow the second option's last word,
  // unless the first option already stands alone (STANDALONE_INGREDIENT_WORDS).
  // Leading-modifier stripping (step 11) runs on every alternative, not just
  // the core, so it happens here too, before that borrowing decision.
  let alternatives: string[] | undefined;
  let alt1: string | undefined;
  let alt2: string | undefined;
  const orParenMatch = working.match(/^(.*?)\s*\(\s*or\s+([^)]+?)\s*\)\s*(.*)$/i);
  if (orParenMatch) {
    const prefix = orParenMatch[1].trim();
    const altWord = orParenMatch[2].trim();
    const suffix = orParenMatch[3].trim();
    alt1 = suffix ? `${prefix} ${suffix}`.trim() : prefix;
    alt2 = suffix ? `${altWord} ${suffix}`.trim() : altWord;
    removed.push(orParenMatch[0].trim());
  } else {
    const orMatch = working.match(/^(.+?),?\s+\bor\b\s+(.+)$/i);
    if (orMatch) {
      alt1 = orMatch[1].trim();
      alt2 = orMatch[2].trim();
      removed.push(orMatch[0].trim());
    }
  }
  if (alt1 !== undefined && alt2 !== undefined) {
    const alt1Stripped = stripLeadingModifiers(alt1, removed);
    const alt2Stripped = stripLeadingModifiers(alt2, removed);
    const alt1Words = alt1Stripped.split(" ").filter(Boolean);
    const alt2Words = alt2Stripped.split(" ").filter(Boolean);
    let finalAlt1 = alt1Stripped;
    if (
      alt1Words.length === 1 &&
      alt2Words.length >= 2 &&
      !STANDALONE_INGREDIENT_WORDS.has(alt1Words[0] as string)
    ) {
      finalAlt1 = `${alt1Stripped} ${alt2Words[alt2Words.length - 1]}`;
    }
    alternatives = [finalAlt1, alt2Stripped];
    working = finalAlt1;
  }
  const hadAlternatives = alternatives !== undefined;

  // Step 10: infusion / wash.
  let infused = false;
  const infusionMatch = working.match(INFUSION_RE);
  if (infusionMatch) {
    infused = true;
    removed.push(`${infusionMatch[1]}-${infusionMatch[2]}`);
    working = infusionMatch[3].trim();
  }

  // Step 11: strip leading modifiers, repeatedly (protected phrases block
  // this). Alternatives already ran this per-branch above (step 9); running
  // it again here on an alt1 that borrowed a trailing noun (e.g. "crushed
  // ice") would wrongly re-strip a modifier word now that it has a noun
  // after it.
  if (!hadAlternatives) {
    working = stripLeadingModifiers(working, removed);
  }

  // Step 12: proof/age qualifiers ("overproof" is a style word, not stripped).
  let changed = true;
  while (changed) {
    changed = false;
    for (const re of PROOF_AGE_RES) {
      const match = working.match(re);
      if (match) {
        removed.push(match[0].trim());
        working = working.replace(re, "");
        changed = true;
      }
    }
  }

  // Step 13: trailing clauses ("chilled", "to taste", "divided", and prep
  // notes after a comma like ", washed and pitted").
  const trailingMatch = working.match(TRAILING_CLAUSE_RE);
  if (trailingMatch) {
    removed.push(trailingMatch[0].trim());
    working = working.replace(TRAILING_CLAUSE_RE, "");
  }
  working = trimPunctuation(working);

  // Step 14: singularize the last word for a small, safe set of plural nouns.
  const words = working.split(" ").filter(Boolean);
  if (words.length > 0) {
    const last = words[words.length - 1] as string;
    if (!SINGULARIZE_EXCLUDE.has(last) && !last.endsWith("ss")) {
      let singular: string | undefined;
      if (BERRY_SUFFIX_RE.test(last)) {
        singular = last.replace(BERRY_SUFFIX_RE, "berry");
      } else if (PLURAL_MAP[last]) {
        singular = PLURAL_MAP[last];
      } else if (S_PLURAL_WORDS.has(last)) {
        singular = last.slice(0, -1);
      }
      if (singular) {
        removed.push(`${last}→${singular}`);
        words[words.length - 1] = singular;
        working = words.join(" ");
      }
    }
  }

  // Step 15: garnish-like. Strip a trailing "for garnish" note once flagged.
  let garnishLike = garnishLikeFromAmount;
  if (/\bfor garnish$/i.test(working)) {
    garnishLike = true;
    removed.push("for garnish");
    working = trimPunctuation(working.replace(/\bfor garnish$/i, ""));
  }
  const lastWord = working.split(" ").filter(Boolean).pop();
  if (lastWord && GARNISH_WORDS.has(lastWord)) {
    garnishLike = true;
  }

  // Step 16: final trim; fall back to the step-1 string if core is empty.
  let core = working.trim();
  if (!core) {
    core = fallback;
  }

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
