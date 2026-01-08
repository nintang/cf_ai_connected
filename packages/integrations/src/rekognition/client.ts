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
 * Extended result type that includes throttling information
 */
export interface RekognitionAnalysisResult extends ImageAnalysisResult {
  /** Whether the request was throttled after exhausting all retries */
  throttled?: boolean;
  /** Error message if the request failed (non-throttle error) */
  error?: string;
}

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
  /** Maximum number of retries for rate-limited requests (default: 3) */
  maxRetries?: number;
  /** Base delay for exponential backoff in ms (default: 1000) */
  baseRetryDelay?: number;
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
  private readonly maxRetries: number;
  private readonly baseRetryDelay: number;

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
    this.maxRetries = config.maxRetries ?? 3;
    this.baseRetryDelay = config.baseRetryDelay ?? 1000; // 1 second
  }

  /**
   * Sleep for a given number of milliseconds
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Calculate delay with exponential backoff and jitter
   */
  private getRetryDelay(attempt: number): number {
    // Exponential backoff: 1s, 2s, 4s, etc.
    const exponentialDelay = this.baseRetryDelay * Math.pow(2, attempt);
    // Add jitter (0-500ms) to prevent thundering herd
    const jitter = Math.random() * 500;
    return exponentialDelay + jitter;
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

      // Check content length header first - reject early if too large
      const contentLength = response.headers.get("content-length");
      if (contentLength) {
        const declaredSize = parseInt(contentLength, 10);
        if (declaredSize > this.maxImageSize) {
          throw new Error(`Image too large for Rekognition (${Math.round(declaredSize / 1024 / 1024)}MB, max 5MB)`);
        }
      }

      // Use streaming read to abort early if size exceeds limit
      // This protects against missing/incorrect Content-Length headers
      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error("No response body");
      }

      const chunks: Uint8Array[] = [];
      let totalSize = 0;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        totalSize += value.length;
        if (totalSize > this.maxImageSize) {
          reader.cancel();
          throw new Error(`Image too large for Rekognition (>${Math.round(this.maxImageSize / 1024 / 1024)}MB, max 5MB)`);
        }
        chunks.push(value);
      }

      if (totalSize === 0) {
        throw new Error("Empty image response");
      }

      // Combine chunks into single Uint8Array
      const result = new Uint8Array(totalSize);
      let offset = 0;
      for (const chunk of chunks) {
        result.set(chunk, offset);
        offset += chunk.length;
      }

      return result;

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
  async detectCelebrities(imageUrl: string): Promise<RekognitionAnalysisResult> {
    let imageBytes: Uint8Array;
    try {
      imageBytes = await this.fetchImageBytes(imageUrl);
    } catch (fetchError) {
      // Image fetch failed - return error result instead of throwing
      const errorMessage = fetchError instanceof Error ? fetchError.message : String(fetchError);
      console.warn(`[Rekognition] Image fetch failed for ${imageUrl}: ${errorMessage}`);
      return {
        imageUrl,
        celebrities: [],
        error: errorMessage,
      };
    }

    const command = new RecognizeCelebritiesCommand({
      Image: {
        Bytes: imageBytes,
      },
    });

    // Retry loop with exponential backoff for rate limiting
    let lastError: Error | null = null;
    let wasThrottled = false;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const response = await this.client.send(command);
        const celebrities = this.parseCelebrities(response.CelebrityFaces ?? []);
        return {
          imageUrl,
          celebrities,
        };
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        // Check if it's a throttling error (429 or ProvisionedThroughputExceededException)
        const isThrottled =
          lastError.message.includes("429") ||
          lastError.message.includes("Too Many Requests") ||
          lastError.message.includes("ThrottlingException") ||
          lastError.message.includes("ProvisionedThroughputExceeded") ||
          lastError.name === "ThrottlingException" ||
          lastError.name === "ProvisionedThroughputExceededException";

        if (isThrottled) {
          wasThrottled = true;
          if (attempt < this.maxRetries) {
            const delay = this.getRetryDelay(attempt);
            console.log(`[Rekognition] Rate limited, retrying in ${Math.round(delay)}ms (attempt ${attempt + 1}/${this.maxRetries})`);
            await this.sleep(delay);
            continue;
          }
          // Max retries exceeded for throttling - return throttled result
          console.warn(`[Rekognition] Throttled after ${this.maxRetries} retries for ${imageUrl}`);
          return {
            imageUrl,
            celebrities: [],
            throttled: true,
            error: "Rate limited - max retries exceeded",
          };
        }

        // Non-retryable error - return error result
        console.warn(`[Rekognition] Non-retryable error for ${imageUrl}: ${lastError.message}`);
        return {
          imageUrl,
          celebrities: [],
          error: lastError.message,
        };
      }
    }

    // Should not reach here, but return error result just in case
    return {
      imageUrl,
      celebrities: [],
      throttled: wasThrottled,
      error: lastError?.message ?? "Unknown error in detectCelebrities",
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

