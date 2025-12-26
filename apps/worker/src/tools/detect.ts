import { Env } from "../env";
import { CelebrityRekognitionClient } from "@visual-degrees/integrations";

export const detectCelebrities = (env: Env) => async ({ imageUrl }: { imageUrl: string }) => {
  if (!env.AWS_ACCESS_KEY_ID || !env.AWS_SECRET_ACCESS_KEY) {
    throw new Error("Missing AWS configuration");
  }

  const client = new CelebrityRekognitionClient({
    region: env.AWS_REGION || "us-east-1",
    accessKeyId: env.AWS_ACCESS_KEY_ID,
    secretAccessKey: env.AWS_SECRET_ACCESS_KEY
  });
  
  return await client.detectCelebrities(imageUrl);
};

