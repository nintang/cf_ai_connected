// Confidence scoring
export {
  normalizeName,
  namesMatch,
  findCelebrity,
  isValidEvidence,
  calculateImageScore,
  createEvidenceRecord,
  calculateEdgeConfidence,
  createVerifiedEdge,
  calculatePathConfidence,
  getCoAppearingCelebrities,
} from "./confidence.js";

// Query templates
export {
  directQuery,
  discoveryQueries,
  verificationQueries,
  bridgeQueries,
} from "./query-templates.js";

