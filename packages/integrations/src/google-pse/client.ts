import type { ImageSearchResult, ImageSearchResponse } from "@visual-degrees/contracts";

/**
 * Configuration for Google Programmable Search Engine client
 */
export interface GooglePSEConfig {
  /** Google API key with Custom Search enabled */
  apiKey: string;
  /** Programmable Search Engine ID (cx) */
  searchEngineId: string;
  /** Number of results to fetch (max 10, MVP uses 5) */
  numResults?: number;
}

/**
 * Raw response structure from Google Custom Search API
 */
interface GoogleSearchResponse {
  items?: Array<{
    link: string;
    title?: string;
    image?: {
      thumbnailLink?: string;
      contextLink?: string;
    };
  }>;
}

/**
 * Google Programmable Search Engine client for image retrieval
 */
export class GooglePSEClient {
  private readonly apiKey: string;
  private readonly searchEngineId: string;
  private readonly numResults: number;

  private static readonly BASE_URL = "https://www.googleapis.com/customsearch/v1";

  constructor(config: GooglePSEConfig) {
    this.apiKey = config.apiKey;
    this.searchEngineId = config.searchEngineId;
    this.numResults = config.numResults ?? 5;
  }

  /**
   * Search for images matching the query
   * @param query - Search query string (e.g., "Donald Trump Kanye West")
   * @returns Parsed image search results
   */
  async searchImages(query: string): Promise<ImageSearchResponse> {
    const params = new URLSearchParams({
      key: this.apiKey,
      cx: this.searchEngineId,
      q: query,
      searchType: "image",
      num: String(this.numResults),
    });

    const url = `${GooglePSEClient.BASE_URL}?${params.toString()}`;

    const response = await fetch(url);

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Google PSE API error (${response.status}): ${errorText}`);
    }

    const data = (await response.json()) as GoogleSearchResponse;

    const results = this.parseResults(data);

    return {
      query,
      results,
    };
  }

  /**
   * Parse raw Google API response into typed ImageSearchResult[]
   * Skips results missing imageUrl or contextUrl as per constraints
   */
  private parseResults(data: GoogleSearchResponse): ImageSearchResult[] {
    if (!data.items) {
      return [];
    }

    const results: ImageSearchResult[] = [];

    for (const item of data.items) {
      // Skip if missing required fields
      const imageUrl = item.link;
      const contextUrl = item.image?.contextLink;

      if (!imageUrl || !contextUrl) {
        continue;
      }

      results.push({
        imageUrl,
        thumbnailUrl: item.image?.thumbnailLink ?? imageUrl,
        contextUrl,
        title: item.title ?? "",
      });
    }

    return results;
  }
}

/**
 * Create a GooglePSEClient from environment variables
 */
export function createGooglePSEClient(): GooglePSEClient {
  const apiKey = process.env.GOOGLE_API_KEY;
  const searchEngineId = process.env.GOOGLE_CX;

  if (!apiKey) {
    throw new Error("GOOGLE_API_KEY environment variable is required");
  }
  if (!searchEngineId) {
    throw new Error("GOOGLE_CX environment variable is required");
  }

  return new GooglePSEClient({
    apiKey,
    searchEngineId,
    numResults: 5,
  });
}

