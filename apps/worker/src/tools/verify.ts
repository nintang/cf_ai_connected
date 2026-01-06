import { Env } from "../env";
import { OpenRouterClient, GeminiVisualFilterClient } from "@visual-degrees/integrations";

export const verifyCopresence = (env: Env) => async ({ imageUrl }: { imageUrl: string }) => {
  // Use OpenRouter if available, otherwise fall back to direct Gemini
  if (env.OPENROUTER_API_KEY) {
    const client = new OpenRouterClient({
      apiKey: env.OPENROUTER_API_KEY,
      model: "google/gemini-2.0-flash-001",
    });
    return await client.verifyVisualCopresence(imageUrl);
  }

  // Fallback to direct Gemini
  if (!env.GEMINI_API_KEY) {
    throw new Error("Missing OPENROUTER_API_KEY or GEMINI_API_KEY");
  }

  const client = new GeminiVisualFilterClient({
    apiKey: env.GEMINI_API_KEY,
    gatewayUrl: env.GEMINI_GATEWAY_URL,
  });

  return await client.verifyVisualCopresence(imageUrl);
};

