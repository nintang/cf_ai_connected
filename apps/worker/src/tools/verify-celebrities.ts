import { Env } from "../env";
import { OpenRouterClient } from "@visual-degrees/integrations";

/**
 * AI-based celebrity verification - use when Rekognition doesn't recognize someone
 */
export const verifyCelebritiesWithAI = (env: Env) => async ({
  imageUrl,
  personA,
  personB,
}: {
  imageUrl: string;
  personA: string;
  personB: string;
}) => {
  if (!env.OPENROUTER_API_KEY) {
    throw new Error("Missing OPENROUTER_API_KEY");
  }

  const client = new OpenRouterClient({
    apiKey: env.OPENROUTER_API_KEY,
    model: "google/gemini-2.0-flash-001",
  });

  return await client.verifyCelebritiesInImage(imageUrl, personA, personB);
};
