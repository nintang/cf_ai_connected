// Google PSE
export { GooglePSEClient, createGooglePSEClient } from "./google-pse/client.js";
export type { GooglePSEConfig } from "./google-pse/client.js";

// Amazon Rekognition
export {
  CelebrityRekognitionClient,
  createRekognitionClient,
} from "./rekognition/client.js";
export type { RekognitionConfig } from "./rekognition/client.js";

// Gemini Visual Filter
export {
  GeminiVisualFilterClient,
  createGeminiClient,
} from "./gemini/client.js";
export type { GeminiConfig, VisualVerificationResult } from "./gemini/client.js";

// Gemini LLM Planner
export {
  GeminiPlannerClient,
  createGeminiPlannerClient,
} from "./gemini/client.js";
export type {
  ConnectionResearch,
  RankedCandidate,
  StrategicRanking,
} from "./gemini/client.js";

// Workers AI Planner
export { WorkersAIPlannerClient } from "./workers-ai/client.js";

