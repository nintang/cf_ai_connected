export interface Env {
  // Bindings
  AI: Ai;
  INVESTIGATION_WORKFLOW: Workflow;
  
  // Environment variables
  AWS_REGION: string;
  GOOGLE_API_KEY: string;
  GOOGLE_CX: string;
  AWS_ACCESS_KEY_ID: string;
  AWS_SECRET_ACCESS_KEY: string;
  GEMINI_API_KEY: string;
  GEMINI_GATEWAY_URL?: string;
}

export default {};

