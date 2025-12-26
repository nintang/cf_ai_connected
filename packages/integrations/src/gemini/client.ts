import { GoogleGenerativeAI } from "@google/generative-ai";

/**
 * Configuration for Gemini client
 */
export interface GeminiConfig {
  apiKey: string;
  model?: string;
}

/**
 * Result of visual co-presence verification
 */
export interface VisualVerificationResult {
  /** Whether the image passes the co-presence check */
  isValidScene: boolean;
  /** Reason for the decision */
  reason: string;
  /** Raw response from the model */
  rawResponse: string;
}

/**
 * Gemini Flash client for visual verification
 * Filters out collages, photogrids, and split-screen images
 */
export class GeminiVisualFilterClient {
  private readonly genAI: GoogleGenerativeAI;
  private readonly modelName: string;

  private static readonly SYSTEM_PROMPT = `You are an image analysis expert. Your task is to determine if an image shows people physically together in a SINGLE, REAL-WORLD scene, or if it is a COMPOSITE image (collage, photogrid, split-screen, side-by-side comparison, before/after, meme with multiple panels, etc.).

RESPOND WITH ONLY A JSON OBJECT in this exact format:
{
  "isValidScene": true or false,
  "reason": "brief explanation"
}

Rules:
- isValidScene = true: Single photograph where all people are physically present together in the same moment and space
- isValidScene = false: Any composite, collage, split-screen, photogrid, side-by-side, meme, or edited image combining multiple separate photos

Be strict. If there's any visual indication of image boundaries, panels, or editing that combines separate photos, mark it as invalid.`;

  constructor(config: GeminiConfig) {
    this.genAI = new GoogleGenerativeAI(config.apiKey);
    this.modelName = config.model ?? "gemini-2.0-flash";
  }

  /**
   * Fetch image bytes from a URL and convert to base64
   */
  private async fetchImageAsBase64(imageUrl: string): Promise<{ data: string; mimeType: string }> {
    const response = await fetch(imageUrl);

    if (!response.ok) {
      throw new Error(`Failed to fetch image (${response.status}): ${imageUrl}`);
    }

    const contentType = response.headers.get("content-type") ?? "image/jpeg";
    const arrayBuffer = await response.arrayBuffer();
    const base64 = Buffer.from(arrayBuffer).toString("base64");

    return {
      data: base64,
      mimeType: contentType.split(";")[0], // Remove charset if present
    };
  }

  /**
   * Verify if an image shows real visual co-presence (not a collage/grid)
   * @param imageUrl - URL of the image to analyze
   * @returns Verification result with pass/fail and reason
   */
  async verifyVisualCopresence(imageUrl: string): Promise<VisualVerificationResult> {
    const model = this.genAI.getGenerativeModel({ model: this.modelName });

    const imageData = await this.fetchImageAsBase64(imageUrl);

    const result = await model.generateContent([
      GeminiVisualFilterClient.SYSTEM_PROMPT,
      {
        inlineData: {
          mimeType: imageData.mimeType,
          data: imageData.data,
        },
      },
      "Analyze this image. Is it a single real-world scene with people physically together, or a composite/collage?",
    ]);

    const responseText = result.response.text();

    try {
      // Extract JSON from the response (handle markdown code blocks)
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error("No JSON found in response");
      }

      const parsed = JSON.parse(jsonMatch[0]);

      return {
        isValidScene: Boolean(parsed.isValidScene),
        reason: String(parsed.reason ?? "No reason provided"),
        rawResponse: responseText,
      };
    } catch {
      // If parsing fails, try to infer from the response
      const isValid = responseText.toLowerCase().includes('"isvalidscene": true') ||
                      responseText.toLowerCase().includes('"isvalidscene":true');

      return {
        isValidScene: isValid,
        reason: "Failed to parse structured response",
        rawResponse: responseText,
      };
    }
  }
}

/**
 * Create a GeminiVisualFilterClient from environment variables
 */
export function createGeminiClient(): GeminiVisualFilterClient {
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    throw new Error("GEMINI_API_KEY environment variable is required");
  }

  return new GeminiVisualFilterClient({
    apiKey,
    model: process.env.GEMINI_MODEL ?? "gemini-2.0-flash",
  });
}

