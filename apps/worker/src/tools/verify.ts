import { Env } from "../env";
import { GeminiVisualFilterClient } from "@visual-degrees/integrations";

export const verifyCopresence = (env: Env) => async ({ imageUrl }: { imageUrl: string }) => {
  if (!env.GEMINI_API_KEY) {
    throw new Error("Missing Gemini API key");
  }

  const client = new GeminiVisualFilterClient({
    apiKey: env.GEMINI_API_KEY,
    gatewayUrl: env.GEMINI_GATEWAY_URL,
  });
  
  return await client.verifyVisualCopresence(imageUrl);
};

