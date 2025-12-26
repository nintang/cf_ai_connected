import type {
  DetectedCelebrity,
  EvidenceRecord,
  VerifiedEdge,
  PathConfidence,
  ImageSearchResult,
  ImageAnalysisResult,
} from "@visual-degrees/contracts";

/**
 * Normalize a name for comparison (case-insensitive, trimmed, collapsed spaces)
 */
export function normalizeName(name: string): string {
  return name.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * Check if two names match (case-insensitive)
 */
export function namesMatch(name1: string, name2: string): boolean {
  return normalizeName(name1) === normalizeName(name2);
}

/**
 * Find a celebrity in a detection list by name
 */
export function findCelebrity(
  celebrities: DetectedCelebrity[],
  targetName: string
): DetectedCelebrity | undefined {
  const normalizedTarget = normalizeName(targetName);
  return celebrities.find((c) => normalizeName(c.name) === normalizedTarget);
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

