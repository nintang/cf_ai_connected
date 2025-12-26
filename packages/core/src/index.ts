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
  aggregateCandidates,
} from "./confidence.js";
export type { AnalysisWithContext } from "./confidence.js";

// Query templates
export {
  directQuery,
  discoveryQueries,
  verificationQueries,
  bridgeQueries,
} from "./query-templates.js";

// Orchestrator (state machine)
export { InvestigationOrchestrator } from "./orchestrator.js";
export type {
  InvestigationEvent,
  InvestigationEventType,
  EventCallback,
  SearchClient,
  VisualFilterClient,
  CelebrityDetectionClient,
  PlannerClient,
  IntelligentPlannerClient,
  OrchestratorClients,
  ConnectionResearch,
  RankedCandidate,
  StrategicRanking,
} from "./orchestrator.js";

