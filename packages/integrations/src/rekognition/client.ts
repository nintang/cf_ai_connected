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
}

/**
 * Amazon Rekognition client for celebrity detection
 */
export class CelebrityRekognitionClient {
  private readonly client: RekognitionClient;

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
  }

  /**
   * Fetch image bytes from a URL
   */
  private async fetchImageBytes(imageUrl: string): Promise<Uint8Array> {
    const response = await fetch(imageUrl);

    if (!response.ok) {
      throw new Error(`Failed to fetch image (${response.status}): ${imageUrl}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    return new Uint8Array(arrayBuffer);
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

