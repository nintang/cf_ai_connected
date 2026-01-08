import type {
  DetectedCelebrity,
  EvidenceRecord,
  VerifiedEdge,
  PathConfidence,
  ImageSearchResult,
  ImageAnalysisResult,
  Candidate,
} from "@visual-degrees/contracts";

/**
 * Common name suffixes to strip for comparison
 */
const NAME_SUFFIXES = /\s+(jr\.?|sr\.?|ii+|iii|iv|v|vi|vii|viii|ix|x|phd\.?|md\.?|esq\.?|jd\.?)$/i;

/**
 * Normalize a name for comparison:
 * - Trim whitespace
 * - Collapse multiple spaces
 * - Convert to lowercase
 * - Normalize Unicode (remove diacritics like é → e)
 * - Strip common suffixes (Jr., III, etc.)
 */
export function normalizeName(name: string): string {
  return name
    .trim()
    .normalize("NFD")                           // Decompose Unicode characters
    .replace(/[\u0300-\u036f]/g, "")            // Remove diacritical marks
    .replace(/\s+/g, " ")                       // Collapse whitespace
    .toLowerCase()
    .replace(NAME_SUFFIXES, "")                 // Strip suffixes
    .trim();                                    // Trim again after suffix removal
}

/**
 * Known celebrity aliases - maps aliases to canonical names
 * This helps match "Ye" to "Kanye West", "P. Diddy" to "Sean Combs", etc.
 */
const CELEBRITY_ALIASES: Record<string, string[]> = {
  "kanye west": ["ye", "kanye"],
  "sean combs": ["p. diddy", "puff daddy", "diddy", "puffy"],
  "dwayne johnson": ["the rock", "rock"],
  "stefani germanotta": ["lady gaga", "gaga"],
  "marshall mathers": ["eminem", "slim shady"],
  "curtis jackson": ["50 cent", "50cent", "fiddy"],
  "shawn carter": ["jay-z", "jay z", "jayz", "hov", "hova"],
  "beyoncé knowles": ["beyonce", "beyoncé", "queen bey"],
  "robyn fenty": ["rihanna", "riri"],
  "onika maraj": ["nicki minaj", "nicki"],
  "aubrey graham": ["drake", "drizzy", "champagnepapi"],
  "abel tesfaye": ["the weeknd", "weeknd"],
  "calvin broadus": ["snoop dogg", "snoop", "snoop lion"],
  "william adams": ["will.i.am", "william"],
  "cordozar broadus": ["snoop dogg", "snoop"],
  "belcalis almanzar": ["cardi b", "cardi"],
  "melissa jefferson": ["lizzo"],
  "donald glover": ["childish gambino", "gambino"],
  "o'shea jackson": ["ice cube", "cube"],
  "andre young": ["dr. dre", "dr dre", "dre"],
  "alicia cook": ["alicia keys", "keys"],
  "prince rogers nelson": ["prince"],
  "michael jackson": ["mj", "king of pop"],
  "elvis presley": ["elvis", "the king"],
  "reginald dwight": ["elton john", "elton"],
  "farrokh bulsara": ["freddie mercury", "freddie"],
  "paul hewson": ["bono"],
  "david bowie": ["ziggy stardust", "bowie"],
};

/**
 * Check if two names might be aliases of the same person
 */
function areAliases(name1: string, name2: string): boolean {
  const n1 = normalizeName(name1);
  const n2 = normalizeName(name2);

  // Check if both names map to the same canonical name
  for (const [canonical, aliases] of Object.entries(CELEBRITY_ALIASES)) {
    const allNames = [canonical, ...aliases];
    const n1Match = allNames.some(a => n1.includes(a) || a.includes(n1));
    const n2Match = allNames.some(a => n2.includes(a) || a.includes(n2));
    if (n1Match && n2Match) {
      return true;
    }
  }

  return false;
}

/**
 * Extract the last word (surname) from a name
 */
export function extractSurname(name: string): string {
  const parts = normalizeName(name).split(" ");
  return parts[parts.length - 1];
}

/**
 * Extract the first word (first name) from a name
 */
export function extractFirstName(name: string): string {
  const parts = normalizeName(name).split(" ");
  return parts[0];
}

/**
 * Check if all words in the shorter name appear in the longer name
 * This is safer than simple substring matching - prevents "Chris" from matching "Chris Evans"
 */
function wordsContainedIn(shorter: string, longer: string): boolean {
  const shorterWords = shorter.split(" ");
  const longerWords = new Set(longer.split(" "));

  // All words in shorter must appear in longer
  return shorterWords.every(word => longerWords.has(word));
}

/**
 * Check if two names match using flexible matching:
 * 1. Exact match (after normalization)
 * 2. Known celebrity aliases (e.g., "Kanye West" vs "Ye")
 * 3. Reversed name order (e.g., "Obama Barack" vs "Barack Obama")
 * 4. Word containment (e.g., "Donald Trump" contains all words in "Trump")
 * 5. Surname + first name match (e.g., "Donald Trump" vs "Donald J. Trump")
 */
export function namesMatch(name1: string, name2: string): boolean {
  const n1 = normalizeName(name1);
  const n2 = normalizeName(name2);

  // Exact match
  if (n1 === n2) return true;

  // Known celebrity aliases (e.g., "Kanye West" vs "Ye")
  if (areAliases(name1, name2)) return true;

  // Reversed name order (e.g., "Obama Barack" vs "Barack Obama")
  const parts1 = n1.split(" ");
  const parts2 = n2.split(" ");
  if (parts1.length === 2 && parts2.length === 2) {
    if (parts1[0] === parts2[1] && parts1[1] === parts2[0]) return true;
  }

  // Word containment - all words in shorter name must appear in longer name
  // This handles "Trump" matching "Donald Trump" but prevents "Chris" matching "Chris Evans"
  // because "Chris" (1 word) would need to match ALL of ["chris", "evans"] which it doesn't
  const [shorter, longer] = n1.length < n2.length ? [n1, n2] : [n2, n1];
  if (wordsContainedIn(shorter, longer)) return true;

  // Surname + first name match (handles middle names/initials)
  const surname1 = extractSurname(name1);
  const surname2 = extractSurname(name2);
  const firstName1 = extractFirstName(name1);
  const firstName2 = extractFirstName(name2);

  if (surname1 === surname2 && firstName1 === firstName2) return true;

  // Surname match only (for cases like just "Trump" or "Obama")
  // Only if one name is a single word (likely a mononym or surname-only reference)
  if (surname1 === surname2 && (parts1.length === 1 || parts2.length === 1)) {
    return true;
  }

  return false;
}

/**
 * Find a celebrity in a detection list by name (flexible matching)
 */
export function findCelebrity(
  celebrities: DetectedCelebrity[],
  targetName: string
): DetectedCelebrity | undefined {
  // First try exact match
  const exactMatch = celebrities.find(
    (c) => normalizeName(c.name) === normalizeName(targetName)
  );
  if (exactMatch) return exactMatch;

  // Then try flexible matching
  return celebrities.find((c) => namesMatch(c.name, targetName));
}

/**
 * Check if an image contains valid evidence for an edge (P, Q)
 * Both P and Q must be detected at >= confidenceThreshold
 */
export function isValidEvidence(
  celebrities: DetectedCelebrity[],
  personP: string,
  personQ: string,
  confidenceThreshold: number = 80
): boolean {
  const celebP = findCelebrity(celebrities, personP);
  const celebQ = findCelebrity(celebrities, personQ);

  if (!celebP || !celebQ) {
    return false;
  }

  return (
    celebP.confidence >= confidenceThreshold &&
    celebQ.confidence >= confidenceThreshold
  );
}

/**
 * Calculate per-image evidence score: min(confP, confQ)
 */
export function calculateImageScore(
  celebrities: DetectedCelebrity[],
  personP: string,
  personQ: string
): number | null {
  const celebP = findCelebrity(celebrities, personP);
  const celebQ = findCelebrity(celebrities, personQ);

  if (!celebP || !celebQ) {
    return null;
  }

  return Math.min(celebP.confidence, celebQ.confidence);
}

/**
 * Create an evidence record from search result and analysis
 */
export function createEvidenceRecord(
  searchResult: ImageSearchResult,
  analysis: ImageAnalysisResult,
  personP: string,
  personQ: string
): EvidenceRecord | null {
  const imageScore = calculateImageScore(analysis.celebrities, personP, personQ);

  if (imageScore === null) {
    return null;
  }

  const celebP = findCelebrity(analysis.celebrities, personP);
  const celebQ = findCelebrity(analysis.celebrities, personQ);

  if (!celebP || !celebQ) {
    return null;
  }

  return {
    from: personP,
    to: personQ,
    imageUrl: searchResult.imageUrl,
    thumbnailUrl: searchResult.thumbnailUrl,
    contextUrl: searchResult.contextUrl,
    title: searchResult.title,
    detectedCelebs: [
      { name: celebP.name, confidence: celebP.confidence },
      { name: celebQ.name, confidence: celebQ.confidence },
    ],
    imageScore,
  };
}

/**
 * Calculate edge confidence: max(imageScore) over all valid evidence images
 */
export function calculateEdgeConfidence(evidence: EvidenceRecord[]): number {
  if (evidence.length === 0) {
    return 0;
  }

  return Math.max(...evidence.map((e) => e.imageScore));
}

/**
 * Create a verified edge from evidence records
 */
export function createVerifiedEdge(
  personP: string,
  personQ: string,
  evidence: EvidenceRecord[]
): VerifiedEdge | null {
  if (evidence.length === 0) {
    return null;
  }

  const edgeConfidence = calculateEdgeConfidence(evidence);

  // Find best evidence (highest imageScore)
  const bestEvidence = evidence.reduce((best, current) =>
    current.imageScore > best.imageScore ? current : best
  );

  return {
    from: personP,
    to: personQ,
    edgeConfidence,
    evidence,
    bestEvidence,
  };
}

/**
 * Calculate path confidence metrics
 * - pathBottleneck: min(edgeConfidence) across all edges
 * - pathCumulative: product(edgeConfidence / 100) as decimal 0-1
 */
export function calculatePathConfidence(edges: VerifiedEdge[]): PathConfidence {
  if (edges.length === 0) {
    return { pathBottleneck: 0, pathCumulative: 0 };
  }

  const confidences = edges.map((e) => e.edgeConfidence);

  const pathBottleneck = Math.min(...confidences);

  const pathCumulative = confidences.reduce(
    (product, conf) => product * (conf / 100),
    1
  );

  return {
    pathBottleneck,
    pathCumulative,
  };
}

/**
 * Get all other celebrities co-appearing with a target person at >= threshold
 * Useful for candidate discovery
 */
export function getCoAppearingCelebrities(
  analysis: ImageAnalysisResult,
  targetPerson: string,
  confidenceThreshold: number = 80
): DetectedCelebrity[] {
  const target = findCelebrity(analysis.celebrities, targetPerson);

  // Target must be present at threshold
  if (!target || target.confidence < confidenceThreshold) {
    return [];
  }

  // Return all other celebrities at threshold
  return analysis.celebrities.filter(
    (c) =>
      !namesMatch(c.name, targetPerson) && c.confidence >= confidenceThreshold
  );
}

/**
 * Result from analyzing an image with its search context
 */
export interface AnalysisWithContext {
  analysis: ImageAnalysisResult;
  contextUrl: string;
}

/**
 * Aggregate candidates from multiple image analyses
 * Merges co-appearing celebrities across images, tracking count and best confidence
 * Excludes the frontier person and any people already in the path
 *
 * @param analyses - Array of image analyses with their context URLs
 * @param frontier - The current frontier person being expanded
 * @param excludeNames - Names to exclude (e.g., people already in the path)
 * @param confidenceThreshold - Minimum confidence to consider (default: 80)
 * @returns Sorted array of candidates (highest confidence first)
 */
export function aggregateCandidates(
  analyses: AnalysisWithContext[],
  frontier: string,
  excludeNames: string[] = [],
  confidenceThreshold: number = 80
): Candidate[] {
  // Build a map of candidate name (normalized) -> aggregated data
  const candidateMap = new Map<
    string,
    {
      name: string; // Original name (first occurrence)
      coappearCount: number;
      bestCoappearConfidence: number;
      evidenceContextUrls: Set<string>;
    }
  >();

  // Names to exclude (normalized)
  const excludeSet = new Set([
    normalizeName(frontier),
    ...excludeNames.map(normalizeName),
  ]);

  for (const { analysis, contextUrl } of analyses) {
    // Get co-appearing celebrities from this image
    const coAppearing = getCoAppearingCelebrities(
      analysis,
      frontier,
      confidenceThreshold
    );

    for (const celeb of coAppearing) {
      const normalizedName = normalizeName(celeb.name);

      // Skip excluded names
      if (excludeSet.has(normalizedName)) {
        continue;
      }

      // Check if this matches an existing candidate (flexible matching)
      let matchedKey: string | null = null;
      for (const [key] of candidateMap) {
        if (namesMatch(celeb.name, key)) {
          matchedKey = key;
          break;
        }
      }

      if (matchedKey) {
        // Update existing candidate
        const existing = candidateMap.get(matchedKey)!;
        existing.coappearCount += 1;
        existing.bestCoappearConfidence = Math.max(
          existing.bestCoappearConfidence,
          celeb.confidence
        );
        existing.evidenceContextUrls.add(contextUrl);
      } else {
        // Add new candidate
        candidateMap.set(normalizedName, {
          name: celeb.name, // Keep original casing
          coappearCount: 1,
          bestCoappearConfidence: celeb.confidence,
          evidenceContextUrls: new Set([contextUrl]),
        });
      }
    }
  }

  // Convert to array and sort by confidence (desc), then count (desc)
  const candidates: Candidate[] = Array.from(candidateMap.values()).map(
    (data) => ({
      name: data.name,
      coappearCount: data.coappearCount,
      bestCoappearConfidence: data.bestCoappearConfidence,
      evidenceContextUrls: Array.from(data.evidenceContextUrls),
    })
  );

  candidates.sort((a, b) => {
    if (b.bestCoappearConfidence !== a.bestCoappearConfidence) {
      return b.bestCoappearConfidence - a.bestCoappearConfidence;
    }
    return b.coappearCount - a.coappearCount;
  });

  return candidates;
}

