import { Env } from "../env";
import { GooglePSEClient } from "@visual-degrees/integrations";

export const searchImages = (env: Env) => async ({ query }: { query: string }) => {
  if (!env.GOOGLE_API_KEY || !env.GOOGLE_CX) {
    throw new Error("Missing Google API configuration");
  }
  
  const client = new GooglePSEClient({
    apiKey: env.GOOGLE_API_KEY,
    searchEngineId: env.GOOGLE_CX,
    numResults: 5
  });
  
  return await client.searchImages(query);
};

