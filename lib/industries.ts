/**
 * Trades industries supported by IronBooks.
 *
 * Each industry has its own master COA template (set up by Migration 7).
 * The bookkeeper picks the industry when starting a new COA cleanup; the AI
 * suggests one based on the client's name and the bookkeeper confirms.
 */

export type IndustryKey =
  | "painters"
  | "hvac"
  | "plumbers"
  | "roofers"
  | "electricians"
  | "remodelers"
  | "landscapers"
  | "general_contractors"
  | "chimney_sweepers";

export interface Industry {
  key: IndustryKey;
  label: string;
  /** Short descriptor shown under the label in the picker */
  description: string;
  /** Emoji/icon hint for the card */
  emoji: string;
  /** Keywords matched against the client name to suggest this industry */
  keywords: string[];
}

export const INDUSTRIES: Industry[] = [
  {
    key: "painters",
    label: "Painters",
    description: "Residential & commercial painting contractors",
    emoji: "🎨",
    keywords: ["paint", "painter", "painting", "coatings", "refinishing", "redo"],
  },
  {
    key: "hvac",
    label: "HVAC Contractors",
    description: "Heating, ventilation, AC, refrigeration",
    emoji: "❄️",
    keywords: ["hvac", "heating", "cooling", "air conditioning", "a/c", "ac repair", "furnace", "refrigeration", "heat pump", "duct"],
  },
  {
    key: "plumbers",
    label: "Plumbers",
    description: "Plumbing services, drains, water heaters",
    emoji: "🔧",
    keywords: ["plumb", "plumber", "plumbing", "drain", "pipe", "septic", "water heater"],
  },
  {
    key: "roofers",
    label: "Roofers",
    description: "Roofing, shingles, repairs, replacement",
    emoji: "🏠",
    keywords: ["roof", "roofer", "roofing", "shingle", "gutter", "siding"],
  },
  {
    key: "electricians",
    label: "Electricians",
    description: "Electrical contractors, wiring, panels",
    emoji: "⚡",
    keywords: ["electric", "electrician", "electrical", "wiring", "voltage"],
  },
  {
    key: "remodelers",
    label: "Remodelers",
    description: "Kitchen, bath, whole-home renovations",
    emoji: "🔨",
    keywords: ["remodel", "renovation", "renovate", "kitchen and bath", "reno"],
  },
  {
    key: "landscapers",
    label: "Landscapers",
    description: "Lawn, garden, hardscape, snow removal",
    emoji: "🌳",
    keywords: ["landscape", "landscaping", "lawn", "garden", "hardscape", "yard", "snow removal", "irrigation"],
  },
  {
    key: "general_contractors",
    label: "General Contractors",
    description: "Multi-trade construction & remodeling",
    emoji: "🏗️",
    keywords: ["general contractor", "construction", "builders", "build", "gc", "contractors"],
  },
  {
    key: "chimney_sweepers",
    label: "Chimney Sweepers",
    description: "Chimney cleaning, inspection, repair",
    emoji: "🧹",
    keywords: ["chimney", "sweep", "fireplace"],
  },
];

export function getIndustry(key: string | null | undefined): Industry | undefined {
  if (!key) return undefined;
  return INDUSTRIES.find((i) => i.key === key);
}

/**
 * Guess the industry from a client name using keyword matching.
 * Returns the best-matching industry key, or null if no clear match.
 *
 * Bookkeeper can always override the suggestion — this is just to save typing
 * on common cases ("Edmonton HVAC LTD" → 'hvac').
 */
export function suggestIndustryFromName(clientName: string | null | undefined): IndustryKey | null {
  if (!clientName) return null;
  const lower = clientName.toLowerCase();

  let bestMatch: { key: IndustryKey; score: number } | null = null;

  for (const industry of INDUSTRIES) {
    let score = 0;
    for (const keyword of industry.keywords) {
      if (lower.includes(keyword)) {
        // Longer keyword matches are stronger signals
        score += keyword.length;
      }
    }
    if (score > 0 && (!bestMatch || score > bestMatch.score)) {
      bestMatch = { key: industry.key, score };
    }
  }

  return bestMatch?.key || null;
}
