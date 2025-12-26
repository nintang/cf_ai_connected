import { GoogleGenerativeAI } from "@google/generative-ai";

/**
 * Configuration for Gemini client
 */
export interface GeminiConfig {
  apiKey: string;
  model?: string;
  /** Timeout for image fetch in milliseconds (default: 10000) */
  fetchTimeout?: number;
  /** Maximum image size in bytes (default: 10MB) */
  maxImageSize?: number;
}

/** Supported image MIME types */
const SUPPORTED_IMAGE_TYPES = [
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/gif",
  "image/webp",
];

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
  private readonly fetchTimeout: number;
  private readonly maxImageSize: number;

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
    this.fetchTimeout = config.fetchTimeout ?? 10000; // 10 seconds
    this.maxImageSize = config.maxImageSize ?? 10 * 1024 * 1024; // 10MB
  }

  /**
   * Validate image URL format
   */
  private validateImageUrl(imageUrl: string): void {
    try {
      const url = new URL(imageUrl);
      if (!["http:", "https:"].includes(url.protocol)) {
        throw new Error("Invalid protocol - must be http or https");
      }
    } catch (e) {
      throw new Error(`Invalid image URL: ${e instanceof Error ? e.message : "malformed URL"}`);
    }
  }

  /**
   * Fetch image bytes from a URL and convert to base64 with timeout and validation
   */
  private async fetchImageAsBase64(imageUrl: string): Promise<{ data: string; mimeType: string }> {
    // Validate URL format first
    this.validateImageUrl(imageUrl);

    // Create abort controller for timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.fetchTimeout);

    try {
      const response = await fetch(imageUrl, {
        signal: controller.signal,
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; VisualDegrees/1.0)",
          "Accept": "image/*",
        },
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      // Validate content type
      const contentType = response.headers.get("content-type")?.split(";")[0]?.toLowerCase() ?? "";
      if (!SUPPORTED_IMAGE_TYPES.includes(contentType) && !contentType.startsWith("image/")) {
        throw new Error(`Unsupported content type: ${contentType || "unknown"}`);
      }

      // Check content length if available
      const contentLength = response.headers.get("content-length");
      if (contentLength && parseInt(contentLength, 10) > this.maxImageSize) {
        throw new Error(`Image too large: ${Math.round(parseInt(contentLength, 10) / 1024 / 1024)}MB exceeds ${Math.round(this.maxImageSize / 1024 / 1024)}MB limit`);
      }

      const arrayBuffer = await response.arrayBuffer();

      // Validate actual size
      if (arrayBuffer.byteLength > this.maxImageSize) {
        throw new Error(`Image too large: ${Math.round(arrayBuffer.byteLength / 1024 / 1024)}MB`);
      }

      // Validate it's actually image data (check magic bytes)
      const bytes = new Uint8Array(arrayBuffer.slice(0, 4));
      if (!this.isValidImageMagicBytes(bytes)) {
        throw new Error("Invalid image data - not a recognized image format");
      }

      const base64 = Buffer.from(arrayBuffer).toString("base64");

      // Use validated content type or infer from magic bytes
      const mimeType = SUPPORTED_IMAGE_TYPES.includes(contentType) 
        ? contentType 
        : this.inferMimeType(bytes) ?? "image/jpeg";

      return { data: base64, mimeType };

    } catch (error) {
      clearTimeout(timeoutId);

      if (error instanceof Error) {
        if (error.name === "AbortError") {
          throw new Error(`Image fetch timeout after ${this.fetchTimeout / 1000}s`);
        }
        throw new Error(`Failed to fetch image: ${error.message}`);
      }
      throw new Error("Failed to fetch image: Unknown error");
    }
  }

  /**
   * Check if bytes match known image magic bytes
   */
  private isValidImageMagicBytes(bytes: Uint8Array): boolean {
    if (bytes.length < 2) return false;

    // JPEG: FF D8 FF
    if (bytes[0] === 0xFF && bytes[1] === 0xD8) return true;
    // PNG: 89 50 4E 47
    if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47) return true;
    // GIF: 47 49 46 38
    if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) return true;
    // WebP: 52 49 46 46 (RIFF)
    if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46) return true;

    return false;
  }

  /**
   * Infer MIME type from magic bytes
   */
  private inferMimeType(bytes: Uint8Array): string | null {
    if (bytes[0] === 0xFF && bytes[1] === 0xD8) return "image/jpeg";
    if (bytes[0] === 0x89 && bytes[1] === 0x50) return "image/png";
    if (bytes[0] === 0x47 && bytes[1] === 0x49) return "image/gif";
    if (bytes[0] === 0x52 && bytes[1] === 0x49) return "image/webp";
    return null;
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

