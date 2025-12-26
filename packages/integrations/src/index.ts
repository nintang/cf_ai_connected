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

