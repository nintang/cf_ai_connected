import {
  RekognitionClient,
  RecognizeCelebritiesCommand,
  type Celebrity,
} from "@aws-sdk/client-rekognition";
import type {
  DetectedCelebrity,
  BoundingBox,
  ImageAnalysisResult,
} from "@visual-degrees/contracts";

/**
 * Configuration for Amazon Rekognition client
 */
export interface RekognitionConfig {
  region?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  /** Timeout for image fetch in milliseconds (default: 10000) */
  fetchTimeout?: number;
  /** Maximum image size in bytes (default: 5MB - Rekognition limit) */
  maxImageSize?: number;
}

/** Supported image MIME types for Rekognition */
const SUPPORTED_IMAGE_TYPES = ["image/jpeg", "image/jpg", "image/png"];

/**
 * Amazon Rekognition client for celebrity detection
 */
export class CelebrityRekognitionClient {
  private readonly client: RekognitionClient;
  private readonly fetchTimeout: number;
  private readonly maxImageSize: number;

  constructor(config: RekognitionConfig = {}) {
    const credentials =
      config.accessKeyId && config.secretAccessKey
        ? {
            accessKeyId: config.accessKeyId,
            secretAccessKey: config.secretAccessKey,
          }
        : undefined;

    this.client = new RekognitionClient({
      region: config.region ?? "us-east-1",
      credentials,
    });

    this.fetchTimeout = config.fetchTimeout ?? 10000; // 10 seconds
    this.maxImageSize = config.maxImageSize ?? 5 * 1024 * 1024; // 5MB (Rekognition limit)
  }

  /**
   * Validate image URL format
   */
  private validateImageUrl(imageUrl: string): void {
    try {
      const url = new URL(imageUrl);
      if (!["http:", "https:"].includes(url.protocol)) {
        throw new Error("Invalid protocol");
      }
    } catch {
      throw new Error("Invalid image URL format");
    }
  }

  /**
   * Fetch image bytes from a URL with timeout and validation
   */
  private async fetchImageBytes(imageUrl: string): Promise<Uint8Array> {
    this.validateImageUrl(imageUrl);

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

      // Check content length
      const contentLength = response.headers.get("content-length");
      if (contentLength && parseInt(contentLength, 10) > this.maxImageSize) {
        throw new Error(`Image too large for Rekognition (max 5MB)`);
      }

      const arrayBuffer = await response.arrayBuffer();

      if (arrayBuffer.byteLength > this.maxImageSize) {
        throw new Error(`Image too large: ${Math.round(arrayBuffer.byteLength / 1024 / 1024)}MB`);
      }

      if (arrayBuffer.byteLength === 0) {
        throw new Error("Empty image response");
      }

      return new Uint8Array(arrayBuffer);

    } catch (error) {
      clearTimeout(timeoutId);

      if (error instanceof Error) {
        if (error.name === "AbortError") {
          throw new Error(`Image fetch timeout after ${this.fetchTimeout / 1000}s`);
        }
        throw error;
      }
      throw new Error("Failed to fetch image");
    }
  }

  /**
   * Detect celebrities in an image by URL
   * @param imageUrl - URL of the image to analyze
   * @returns Analysis result with detected celebrities
   */
  async detectCelebrities(imageUrl: string): Promise<ImageAnalysisResult> {
    const imageBytes = await this.fetchImageBytes(imageUrl);

    const command = new RecognizeCelebritiesCommand({
      Image: {
        Bytes: imageBytes,
      },
    });

    const response = await this.client.send(command);

    const celebrities = this.parseCelebrities(response.CelebrityFaces ?? []);

    return {
      imageUrl,
      celebrities,
    };
  }

  /**
   * Parse Rekognition celebrity response into typed DetectedCelebrity[]
   */
  private parseCelebrities(faces: Celebrity[]): DetectedCelebrity[] {
    const celebrities: DetectedCelebrity[] = [];

    for (const face of faces) {
      if (!face.Name || face.MatchConfidence === undefined) {
        continue;
      }

      const boundingBox: BoundingBox = {
        left: face.Face?.BoundingBox?.Left ?? 0,
        top: face.Face?.BoundingBox?.Top ?? 0,
        width: face.Face?.BoundingBox?.Width ?? 0,
        height: face.Face?.BoundingBox?.Height ?? 0,
      };

      celebrities.push({
        name: face.Name,
        confidence: face.MatchConfidence,
        boundingBox,
      });
    }

    return celebrities;
  }
}

/**
 * Create a CelebrityRekognitionClient from environment variables
 */
export function createRekognitionClient(): CelebrityRekognitionClient {
  return new CelebrityRekognitionClient({
    region: process.env.AWS_REGION ?? "us-east-1",
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  });
}

