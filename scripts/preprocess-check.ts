#!/usr/bin/env tsx
// Plain-script checks for scripts/lib/preprocess.ts. No test framework: run
// with `pnpm check`, exits non-zero if any case fails.

import { preprocessIngredient, mentionsEditorsNote, type PreprocessedIngredient } from "./lib/preprocess.js";

interface Case {
  raw: string;
  core: string;
  alternatives?: string[];
  preferred?: string;
  flags?: Partial<PreprocessedIngredient["flags"]>;
}

const cases: Case[] = [
  { raw: "fresh lime juice", core: "lime juice" },
  { raw: "Absinthe, preferably Lucid", core: "absinthe", preferred: "Lucid" },
  {
    raw: "vanilla syrup (see Editor’s Note)",
    core: "vanilla syrup",
    flags: { houseMade: true },
  },
  {
    // Alt1 is a lone adjective missing the shared noun "sherry"; fix 9
    // borrows it from alt2. (This case previously encoded the bug fix 9
    // corrects: it used to yield core "manzanilla".)
    raw: "manzanilla or fino sherry",
    core: "manzanilla sherry",
    alternatives: ["manzanilla sherry", "fino sherry"],
  },
  {
    raw: "soursop (or pineapple) juice",
    core: "soursop juice",
    alternatives: ["soursop juice", "pineapple juice"],
  },
  { raw: "chamomile-infused rye", core: "rye", flags: { infused: true } },
  {
    raw: "kelp- and tahini-washed reposado tequila (see editor’s note)",
    core: "reposado tequila",
    flags: { infused: true, houseMade: true },
  },
  { raw: "rich demerara simple syrup, (2:1, sugar:water)", core: "rich demerara simple syrup" },
  { raw: "tonic water, to top", core: "tonic water", flags: { optional: true } },
  { raw: "101-proof bourbon", core: "bourbon" },
  { raw: "mint leaves", core: "mint leaf", flags: { garnishLike: true } },
  { raw: "dry vermouth", core: "dry vermouth" },
  { raw: "orange peel–infused vodka", core: "vodka", flags: { infused: true } },
  { raw: "angostura bitters", core: "angostura bitters" },

  // Additional coverage beyond the required minimum.
  { raw: "maraschino cherries", core: "maraschino cherry" },
  { raw: "lemon wedge, for garnish", core: "lemon wedge", flags: { garnishLike: true } },
  { raw: "grapefruit twist", core: "grapefruit twist", flags: { garnishLike: true } },
  {
    raw: "mezcal, such as Del Maguey Vida",
    core: "mezcal",
    preferred: "Del Maguey Vida",
  },
  { raw: "20-year-old rum", core: "rum" },
  { raw: "club soda, chilled", core: "club soda" },
  { raw: "sugar, to taste", core: "sugar" },
  { raw: "egg white, divided", core: "egg white" },
  { raw: "kosher salt, as needed", core: "kosher salt", flags: { optional: true } },
  { raw: "club soda for rinsing", core: "club soda", flags: { optional: true } },
  { raw: "orange bitters", core: "orange bitters" },
  { raw: "unsweetened cranberry juice", core: "unsweetened cranberry juice" },
  { raw: "muddled mint leaves", core: "mint leaf", flags: { garnishLike: true } },
  { raw: "gin, or vodka", core: "gin", alternatives: ["gin", "vodka"] },
  { raw: "ginger syrup (1:1, ginger to sugar)", core: "ginger syrup" },
  {
    raw: "simple syrup (this is a fairly long descriptive note here)",
    core: "simple syrup",
  },
  {
    raw: "creme de violette (small amount)",
    core: "creme de violette (small amount)",
  },

  // --- Defect fixes below ---

  // 1. Compound words losing their first word to leading-modifier stripping.
  { raw: "cold brew coffee", core: "cold brew coffee" },
  { raw: "hot sauce", core: "hot sauce" },
  { raw: "cold brew concentrate", core: "cold brew concentrate" },
  { raw: "hot water", core: "water" },

  // 2. Infusion regex firing on ", washed" trailing clauses.
  { raw: "Bing cherries, washed and pitted", core: "bing cherry" },
  { raw: "bacon fat-washed bourbon", core: "bourbon", flags: { infused: true } },

  // 3. Preferred-brand extraction running before optional markers.
  {
    raw: "soda water, preferably Fever-Tree, to top",
    core: "soda water",
    preferred: "Fever-Tree",
    flags: { optional: true },
  },
  {
    raw: "dry rum, such as Don Q or Flor de Caña (optional)",
    core: "dry rum",
    preferred: "Don Q or Flor de Caña",
    flags: { optional: true },
  },

  // 4. Unbalanced "(" left by preferred extraction, and stray trailing ")"/"}".
  {
    raw:
      "cold-pressed pineapple juice (any quality, not-from-concentrate pineapple juice, such as Trader Joe's brand, will do)",
    core: "pineapple juice",
  },
  { raw: "rich cane sugar syrup  )", core: "rich cane sugar syrup" },

  // 5. Trademark/footnote symbols and quoted-word unwrapping.
  { raw: "Knob Creek® Rye", core: "knob creek rye" },
  { raw: "red currant syrup*", core: "red currant syrup" },
  { raw: "Peychaud's® bitters", core: "peychaud's bitters" },
  { raw: "“Chartreuse” blend", core: "chartreuse blend" },

  // 6. Leading ratio or percentage.
  { raw: "2:1 honey syrup", core: "honey syrup" },
  { raw: "20% saline solution", core: "saline solution" },
  { raw: "20 percent saline solution", core: "saline solution" },
  { raw: "10% salt solution", core: "salt solution" },

  // 7. Amounts leaked into the ingredient field.
  { raw: "(750 ml) high proof vodka", core: "high proof vodka" },
  { raw: "(about 3 3/4 ounces) Everclear (190 proof)", core: "everclear" },
  { raw: "1 dash vanilla extract", core: "vanilla extract" },
  { raw: "juice of 1 lime", core: "lime juice" },
  { raw: "juice of 4 limes", core: "lime juice" },
  { raw: "juice of 1/2 lime", core: "lime juice" },
  { raw: "juice and zest of 3 lemons, separated", core: "lemon juice" },
  { raw: "zest of 1 orange", core: "orange zest", flags: { garnishLike: true } },
  { raw: "peels of 2 grapefruits", core: "grapefruit peel", flags: { garnishLike: true } },

  // 8. Plurals: generic "berries" suffix and the explicit s-plural list.
  { raw: "raspberries", core: "raspberry" },
  { raw: "strawberries", core: "strawberry" },
  { raw: "lemons", core: "lemon" },
  { raw: "cloves", core: "cloves" },

  // 9/10. Alternatives where the first option is a lone adjective, and
  // modifier stripping running on every alternative (not just core).
  {
    raw: "fino or manzanilla sherry",
    core: "fino sherry",
    alternatives: ["fino sherry", "manzanilla sherry"],
  },
  {
    raw: "Creole or Peychaud’s bitters",
    core: "creole bitters",
    alternatives: ["creole bitters", "peychaud's bitters"],
  },
  {
    raw: "crushed or cracked ice",
    core: "crushed ice",
    alternatives: ["crushed ice", "cracked ice"],
  },
  {
    raw: "unaged or lightly aged rum",
    core: "unaged rum",
    alternatives: ["unaged rum", "aged rum"],
  },
  {
    raw: "Champagne or sparkling wine",
    core: "champagne",
    alternatives: ["champagne", "sparkling wine"],
  },
  {
    raw: "lightly aged or filtered rum, preferably Real McCoy 3",
    core: "aged rum",
    alternatives: ["aged rum", "filtered rum"],
    preferred: "Real McCoy 3",
  },

  // Also: HOUSE_MADE_RE tolerating "}" as a closing bracket.
  {
    raw: "Fernet Branca Menta cream (see Editor’s Note}",
    core: "fernet branca menta cream",
    flags: { houseMade: true },
  },

  // Unicode normalization: decomposed accents (combining cedilla) must
  // normalize to precomposed form so taxonomy aliases still match.
  { raw: "orange curaçao", core: "orange curaçao" },
];

let failures = 0;

for (const testCase of cases) {
  const result = preprocessIngredient(testCase.raw);
  const problems: string[] = [];

  if (result.core !== testCase.core) {
    problems.push(`core: expected ${JSON.stringify(testCase.core)}, got ${JSON.stringify(result.core)}`);
  }
  if (testCase.alternatives) {
    const got = result.alternatives ?? [];
    if (JSON.stringify(got) !== JSON.stringify(testCase.alternatives)) {
      problems.push(
        `alternatives: expected ${JSON.stringify(testCase.alternatives)}, got ${JSON.stringify(got)}`
      );
    }
  }
  if (testCase.preferred !== undefined && result.preferred !== testCase.preferred) {
    problems.push(`preferred: expected ${JSON.stringify(testCase.preferred)}, got ${JSON.stringify(result.preferred)}`);
  }
  if (testCase.flags) {
    for (const [key, expected] of Object.entries(testCase.flags)) {
      const actual = result.flags[key as keyof PreprocessedIngredient["flags"]];
      if (actual !== expected) {
        problems.push(`flags.${key}: expected ${expected}, got ${actual}`);
      }
    }
  }

  if (problems.length > 0) {
    failures++;
    console.error(`FAIL: ${JSON.stringify(testCase.raw)}`);
    for (const problem of problems) {
      console.error(`  ${problem}`);
    }
  }
}

// Descriptions are checked raw, with the site's curly apostrophe.
const noteCases: Array<[string, boolean]> = [
  ["(see Editor\u2019s Note)", true],
  ["(see Editor's Note)", true],
  ["(1:1, sugar:water)", false],
];
let noteFailures = 0;
for (const [text, expected] of noteCases) {
  if (mentionsEditorsNote(text) !== expected) {
    noteFailures++;
    console.error(`FAIL: mentionsEditorsNote(${JSON.stringify(text)}) expected ${expected}`);
  }
}
failures += noteFailures;

console.log(`${cases.length + noteCases.length - failures}/${cases.length + noteCases.length} cases passed.`);

if (failures > 0) {
  process.exit(1);
}
