export interface Env {
  // Bindings
  AI: Ai;
  INVESTIGATION_WORKFLOW: Workflow;
  INVESTIGATION_EVENTS: KVNamespace;
  RATE_LIMIT: KVNamespace;
  GRAPH_DB: D1Database;

  // Environment variables
  AWS_REGION: string;
  GOOGLE_API_KEY: string;
  GOOGLE_CX: string;
  AWS_ACCESS_KEY_ID: string;
  AWS_SECRET_ACCESS_KEY: string;
  // OpenRouter (Gemini 3 Flash)
  OPENROUTER_API_KEY: string;
  OPENROUTER_MODEL?: string;
  // Legacy Gemini (optional, for fallback)
  GEMINI_API_KEY?: string;
  GEMINI_GATEWAY_URL?: string;
  // CORS - comma-separated list of allowed origins
  ALLOWED_ORIGINS?: string;
}

export default {};

