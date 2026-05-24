// Keyword-based expense category matcher for Plaid transactions.
// Returns the best-guess EXPENSE_CATEGORIES key (RENT, EQUIPMENT, …) for a
// transaction's merchant name + description, or null if nothing matches.
//
// Intentionally simple substring matching — owners always see the suggestion
// as a hint and can override before saving. Add to KEYWORDS as needed.

const KEYWORDS: Array<{ category: string; words: string[] }> = [
  { category: "RENT",         words: ["rent", "lease", "landlord", "wework", "regus", "property mgmt"] },
  { category: "PAYROLL",      words: ["gusto", "rippling", "adp", "paychex", "quickbooks payroll", "onpay", "justworks"] },
  { category: "CONTRACTOR",   words: ["upwork", "fiverr", "freelancer", "1099", "venmo coach"] },
  { category: "EQUIPMENT",    words: ["amazon", "rogue", "sportsauthority", "dick's", "dicks sporting", "academy sports", "walmart", "target", "home depot", "lowes"] },
  { category: "SOFTWARE",     words: ["athletixos", "clubos", "stripe", "zoom", "google", "microsoft", "notion", "slack", "github", "figma", "canva", "openai", "anthropic", "cloudflare", "vercel", "netlify", "aws", "digitalocean"] },
  { category: "MARKETING",    words: ["meta", "facebook ads", "instagram ads", "google ads", "tiktok ads", "mailchimp", "klaviyo", "hubspot", "buffer", "hootsuite"] },
  { category: "TRAVEL",       words: ["uber", "lyft", "delta", "united", "southwest", "american airlines", "hotel", "marriott", "hilton", "airbnb", "expedia", "hertz", "enterprise rent"] },
  { category: "MEALS",        words: ["starbucks", "chipotle", "doordash", "ubereats", "grubhub", "panera", "subway", "mcdonald", "restaurant", "cafe", "coffee"] },
  { category: "INSURANCE",    words: ["insurance", "state farm", "geico", "progressive", "allstate", "the hartford", "next insurance"] },
  { category: "MAINTENANCE",  words: ["repair", "hvac", "plumbing", "electric", "cleaning", "janitor"] },
  { category: "UTILITIES",    words: ["comcast", "xfinity", "verizon", "at&t", "spectrum", "t-mobile", "pge", "con edison", "duke energy", "electric co", "gas co", "water dept"] },
  { category: "PROFESSIONAL", words: ["lawyer", "attorney", "legal", "accountant", "cpa", "consultant"] },
  { category: "FEES",         words: ["bank fee", "wire fee", "atm", "overdraft", "service charge", "stripe fee", "processing fee"] },
];

export function suggestExpenseCategory(
  merchantName?: string | null,
  description?: string | null,
): string | null {
  const haystack = `${merchantName ?? ""} ${description ?? ""}`.toLowerCase();
  if (!haystack.trim()) return null;
  for (const { category, words } of KEYWORDS) {
    for (const w of words) {
      if (haystack.includes(w)) return category;
    }
  }
  return null;
}
