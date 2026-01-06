import type { PlannerInput, PlannerOutput } from "@visual-degrees/contracts";

// ============================================================================
// OpenRouter Client for Gemini 3 Flash
// ============================================================================

const OPENROUTER_API_URL = "https://openrouter.ai/api/v1/chat/completions";

/**
 * Configuration for OpenRouter client
 */
export interface OpenRouterConfig {
  apiKey: string;
  model?: string;
  /** Timeout for requests in milliseconds (default: 30000) */
  requestTimeout?: number;
  /** Maximum image size in bytes (default: 10MB) */
  maxImageSize?: number;
}

/**
 * Result of visual co-presence verification
 */
export interface VisualVerificationResult {
  isValidScene: boolean;
  reason: string;
  rawResponse: string;
}

/**
 * A suggested bridge candidate from LLM's world knowledge
 */
export interface BridgeCandidateSuggestion {
  name: string;
  reasoning: string;
  connectionToA: string;
  connectionToB: string;
  confidence: number;
}

/**
 * Convert ArrayBuffer to Base64 string (browser/worker compatible)
 */
function arrayBufferToBase64(buffer: ArrayBuffer): string {
  let binary = "";
  const bytes = new Uint8Array(buffer);
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/**
 * OpenRouter client for Gemini 3 Flash
 * Handles both visual verification and LLM planning
 */
export class OpenRouterClient {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly requestTimeout: number;
  private readonly maxImageSize: number;

  private static readonly VISUAL_SYSTEM_PROMPT = `You are an image analysis expert. Your task is to determine if an image shows people physically together in a SINGLE, REAL-WORLD scene, or if it is a COMPOSITE image (collage, photogrid, split-screen, side-by-side comparison, before/after, meme with multiple panels, etc.).

RESPOND WITH ONLY A JSON OBJECT in this exact format:
{
  "isValidScene": true or false,
  "reason": "brief explanation"
}

Rules:
- isValidScene = true: Single photograph where all people are physically present together in the same moment and space
- isValidScene = false: Any composite, collage, split-screen, photogrid, side-by-side, meme, or edited image combining multiple separate photos

Be strict. If there's any visual indication of image boundaries, panels, or editing that combines separate photos, mark it as invalid.`;

  private static readonly CELEBRITY_VERIFICATION_PROMPT = `You are an expert at identifying celebrities and public figures in photographs.

TASK: Determine if the two specified people appear together in this image.

IMPORTANT RULES:
1. Only confirm if you can VISUALLY IDENTIFY both people with reasonable confidence
2. Consider the person's known appearance, style, and context
3. Be aware that some people (like partners/spouses) may not be traditional celebrities
4. If you recognize one person clearly and the other matches known photos/descriptions of the second person, that counts
5. Consider context clues (events, locations, other people) that might help identification

Output ONLY valid JSON:
{
  "personAFound": true/false,
  "personAConfidence": 0-100,
  "personANotes": "brief explanation",
  "personBFound": true/false,
  "personBConfidence": 0-100,
  "personBNotes": "brief explanation",
  "togetherInScene": true/false,
  "overallConfidence": 0-100,
  "notes": "any additional context"
}

Rules:
- personAFound/personBFound = true only if you can identify them with reasonable confidence
- togetherInScene = true only if both are found AND appear in the same real scene (not a composite)
- overallConfidence = your confidence that both people are genuinely together in this photo`;

  private static readonly PLANNER_SYSTEM_PROMPT = `You are a strategic planner for finding visual connections between public figures.

CRITICAL RULES:
- You do NOT identify faces.
- You only choose what to search next using the candidates provided.
- You must output ONLY strict JSON and nothing else.
- Select candidates based on their STRATEGIC VALUE for bridging to the target.

SELECTION STRATEGY (prioritize in order):
1. DIRECT INDUSTRY LINK: Candidate works in same field as the target
2. SHARED SOCIAL CIRCLES: Candidate known to attend same events as target
3. SUPER-CONNECTOR: Candidate has broad network spanning multiple industries
4. GEOGRAPHIC PROXIMITY: Candidate operates in same cities/scenes as target

Your output MUST be a valid JSON object with this exact structure:
{
  "nextCandidates": ["name1", "name2"],
  "searchQueries": ["query1", "query2"],
  "narration": "Short status message for the user",
  "stop": false,
  "reason": "Brief strategic justification"
}

FIELD RULES:
- nextCandidates: 1-2 names max, MUST exist in the provided candidates list
- searchQueries: 1-4 query strings using templates like "{candidate} {target}" or "{candidate} {target} event"
- narration: One short sentence for chat UI (e.g., "Exploring music industry connections" or "Trying entertainment network path")
- stop: true ONLY if budgets/hops make continuing pointless
- reason: Brief strategic reasoning (e.g., "Both in hip-hop industry" or "Known Met Gala attendees")`;

  private static readonly QUERY_PARSER_PROMPT = `You are a query parser that extracts two person names from natural language queries about finding connections between people.

TASK: Extract the two people the user wants to connect from their query.

The user might say things like:
- "Connect Elon Musk to Beyoncé"
- "How is Donald Trump connected to Cardi B?"
- "Find the path between Jay-Z and Taylor Swift"
- "elon musk beyonce" (just two names)
- "Is there a connection between Obama and Oprah?"
- "Link Kim Kardashian with Pete Davidson"

Output ONLY valid JSON:
{
  "personA": "First Person's Full Name",
  "personB": "Second Person's Full Name",
  "isValid": true,
  "confidence": 0-100
}

If you cannot identify two distinct people, output:
{
  "personA": "",
  "personB": "",
  "isValid": false,
  "confidence": 0,
  "reason": "Brief explanation"
}

Rules:
- Use the most common/recognizable name for each person
- Correct obvious typos (e.g., "elon muck" → "Elon Musk")
- If only one person is mentioned, isValid = false
- If query isn't about connecting people, isValid = false`;

  private static readonly BRIDGE_CANDIDATES_PROMPT = `You are an expert strategist for finding visual connections between public figures.

TASK: Suggest SPECIFIC REAL PEOPLE who could serve as "bridges" between Person A and Person B.

SELECTION CRITERIA (in order of importance):
1. INDUSTRY OVERLAP: People who work in industries that BOTH Person A and B touch
   - Example: A music producer who works with both rappers and pop stars
   - Example: A TV host who interviews both politicians and entertainers

2. SOCIAL CIRCLE INTERSECTIONS: People known to be friends, collaborators, or associates of BOTH
   - Same management, label, agency, production company
   - Known friendships or professional relationships with both

3. EVENT ATTENDANCE: People who frequent events both Person A and B would attend
   - Award shows (Grammys, Oscars, Met Gala, etc.)
   - Charity galas, political fundraisers
   - Fashion weeks, premieres, sports events

4. GEOGRAPHIC/CULTURAL HUBS: People embedded in locations or scenes both frequent
   - NYC/LA social scenes, specific clubs or venues
   - Cultural movements, artistic communities

5. SUPER-CONNECTORS: High-profile individuals known for bridging different worlds
   - Talk show hosts (interview diverse guests)
   - Music producers, DJs, promoters
   - Moguls, philanthropists with wide networks

IMPORTANT:
- Suggest REAL SPECIFIC NAMES with clear reasoning
- Higher confidence = stronger connection logic to BOTH people
- Prioritize people who are HIGH-PROFILE (more likely to have public photos)
- Think about WHO would realistically be at events with BOTH people

Output ONLY valid JSON:
{
  "bridgeCandidates": [
    {
      "name": "Full Name",
      "reasoning": "Strategic logic for why this person bridges both worlds",
      "connectionToA": "Specific connection type (colleague, friend, same industry, etc.)",
      "connectionToB": "Specific connection type",
      "confidence": 0-100
    }
  ],
  "summary": "Brief strategy explanation",
  "searchQueries": ["specific search queries to find photos"]
}`;

  constructor(config: OpenRouterConfig) {
    this.apiKey = config.apiKey;
    this.model = config.model ?? "google/gemini-2.0-flash-001";
    this.requestTimeout = config.requestTimeout ?? 30000;
    this.maxImageSize = config.maxImageSize ?? 10 * 1024 * 1024;
  }

  /**
   * Make a request to OpenRouter API
   */
  private async makeRequest(
    messages: Array<{ role: string; content: string | Array<{ type: string; text?: string; image_url?: { url: string } }> }>,
    options?: { maxTokens?: number }
  ): Promise<string> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.requestTimeout);

    try {
      const response = await fetch(OPENROUTER_API_URL, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "https://visual-degrees.app",
          "X-Title": "Visual Degrees",
        },
        body: JSON.stringify({
          model: this.model,
          messages,
          max_tokens: options?.maxTokens ?? 1024,
          temperature: 0.7,
        }),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      // Parse response body
      const data = await response.json().catch(() => ({})) as {
        choices?: Array<{ message?: { content?: string } }>;
        error?: { message?: string; code?: string | number; metadata?: Record<string, unknown> };
      };

      // Check for HTTP error status
      if (!response.ok) {
        const errorMsg = data.error?.message || response.statusText;
        const errorCode = data.error?.code ? ` (code: ${data.error.code})` : "";
        const metadata = data.error?.metadata ? ` [${JSON.stringify(data.error.metadata)}]` : "";
        throw new Error(`OpenRouter API error: ${errorMsg}${errorCode}${metadata}`);
      }

      // Check for error in response body (OpenRouter sometimes returns errors with 200 status)
      if (data.error) {
        const errorMsg = data.error.message || "Unknown error";
        const errorCode = data.error.code ? ` (code: ${data.error.code})` : "";
        const metadata = data.error.metadata ? ` [${JSON.stringify(data.error.metadata)}]` : "";
        throw new Error(`OpenRouter provider error: ${errorMsg}${errorCode}${metadata}`);
      }

      const content = data.choices?.[0]?.message?.content;
      if (!content) {
        throw new Error(`OpenRouter returned empty response for model ${this.model}`);
      }

      return content;
    } catch (error) {
      clearTimeout(timeoutId);
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error(`OpenRouter request timeout after ${this.requestTimeout / 1000}s`);
      }
      throw error;
    }
  }

  /**
   * Detect image type from magic bytes and return MIME type
   * Returns null if not a recognized image format
   */
  private detectImageType(bytes: Uint8Array): string | null {
    if (bytes.length < 12) {
      return null;
    }

    // JPEG: FF D8 FF
    if (bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF) {
      return "image/jpeg";
    }

    // PNG: 89 50 4E 47 0D 0A 1A 0A
    if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47) {
      return "image/png";
    }

    // GIF: 47 49 46 38
    if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) {
      return "image/gif";
    }

    // WebP: 52 49 46 46 ... 57 45 42 50
    if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
        bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
      return "image/webp";
    }

    return null;
  }

  /**
   * Check if bytes look like HTML (common when servers return error pages)
   */
  private looksLikeHtml(bytes: Uint8Array): boolean {
    // Check for common HTML signatures
    const text = String.fromCharCode(...bytes.slice(0, 100)).toLowerCase();
    return text.includes("<!doctype") || text.includes("<html") || text.includes("<head");
  }

  /**
   * Fetch image and convert to base64 data URL
   * Uses browser-like headers to avoid 403s
   */
  private async fetchImageAsDataUrl(imageUrl: string): Promise<string> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);

    try {
      // Parse URL to get referer domain
      const urlObj = new URL(imageUrl);
      const referer = `${urlObj.protocol}//${urlObj.host}/`;

      const response = await fetch(imageUrl, {
        signal: controller.signal,
        headers: {
          // Use a real browser User-Agent to avoid blocks
          "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          "Accept": "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.9",
          "Referer": referer,
          "Sec-Fetch-Dest": "image",
          "Sec-Fetch-Mode": "no-cors",
          "Sec-Fetch-Site": "cross-site",
        },
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const arrayBuffer = await response.arrayBuffer();
      const bytes = new Uint8Array(arrayBuffer);

      // Check for common error conditions
      if (arrayBuffer.byteLength < 100) {
        throw new Error("Image too small - likely invalid or placeholder");
      }

      if (arrayBuffer.byteLength > this.maxImageSize) {
        throw new Error(`Image too large: ${Math.round(arrayBuffer.byteLength / 1024 / 1024)}MB`);
      }

      // Check if response is actually HTML (error page)
      if (this.looksLikeHtml(bytes)) {
        throw new Error("Server returned HTML instead of image");
      }

      // Detect image type from magic bytes
      const detectedType = this.detectImageType(bytes);

      if (!detectedType) {
        // If we can't detect type but it's not HTML, try using content-type header
        const contentType = response.headers.get("content-type")?.split(";")[0]?.toLowerCase();
        const supportedFormats = ["image/jpeg", "image/png", "image/webp", "image/gif"];

        if (contentType && supportedFormats.includes(contentType)) {
          const base64 = arrayBufferToBase64(arrayBuffer);
          return `data:${contentType};base64,${base64}`;
        }

        throw new Error("Unrecognized image format");
      }

      const base64 = arrayBufferToBase64(arrayBuffer);
      return `data:${detectedType};base64,${base64}`;
    } catch (error) {
      clearTimeout(timeoutId);
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error("Image fetch timeout");
      }
      throw error;
    }
  }

  /**
   * Verify if an image shows real visual co-presence (not a collage/grid)
   * Throws on API/network errors so the caller can skip the image and try another
   */
  async verifyVisualCopresence(imageUrl: string): Promise<VisualVerificationResult> {
    // Fetch image - let errors propagate so caller can skip this image
    const imageDataUrl = await this.fetchImageAsDataUrl(imageUrl);

    // Make API request - let errors propagate
    const responseText = await this.makeRequest([
      { role: "system", content: OpenRouterClient.VISUAL_SYSTEM_PROMPT },
      {
        role: "user",
        content: [
          { type: "text", text: "Analyze this image. Is it a single real-world scene with people physically together, or a composite/collage?" },
          { type: "image_url", image_url: { url: imageDataUrl } },
        ],
      },
    ]);

    // Parse JSON response - if parsing fails, treat as error (skip image)
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error("No JSON found in visual verification response");
    }

    try {
      const parsed = JSON.parse(jsonMatch[0]);

      return {
        isValidScene: Boolean(parsed.isValidScene),
        reason: String(parsed.reason ?? "No reason provided"),
        rawResponse: responseText,
      };
    } catch {
      throw new Error("Failed to parse visual verification JSON");
    }
  }

  /**
   * AI-based celebrity verification - identifies if two specific people are in an image
   * Use this as a fallback when Rekognition doesn't recognize someone (e.g., newer celebrities)
   */
  async verifyCelebritiesInImage(
    imageUrl: string,
    personA: string,
    personB: string
  ): Promise<{
    personAFound: boolean;
    personAConfidence: number;
    personBFound: boolean;
    personBConfidence: number;
    togetherInScene: boolean;
    overallConfidence: number;
    notes: string;
  }> {
    try {
      const imageDataUrl = await this.fetchImageAsDataUrl(imageUrl);

      const responseText = await this.makeRequest([
        { role: "system", content: OpenRouterClient.CELEBRITY_VERIFICATION_PROMPT },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: `Look at this image and determine if these two people appear together:\n\nPerson A: ${personA}\nPerson B: ${personB}\n\nIdentify if both people are present and together in this single photograph.`
            },
            { type: "image_url", image_url: { url: imageDataUrl } },
          ],
        },
      ]);

      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error("No JSON found in response");
      }

      const parsed = JSON.parse(jsonMatch[0]);

      return {
        personAFound: Boolean(parsed.personAFound),
        personAConfidence: typeof parsed.personAConfidence === "number" ? parsed.personAConfidence : 0,
        personBFound: Boolean(parsed.personBFound),
        personBConfidence: typeof parsed.personBConfidence === "number" ? parsed.personBConfidence : 0,
        togetherInScene: Boolean(parsed.togetherInScene),
        overallConfidence: typeof parsed.overallConfidence === "number" ? parsed.overallConfidence : 0,
        notes: String(parsed.notes ?? ""),
      };
    } catch (error) {
      return {
        personAFound: false,
        personAConfidence: 0,
        personBFound: false,
        personBConfidence: 0,
        togetherInScene: false,
        overallConfidence: 0,
        notes: `Error: ${error instanceof Error ? error.message : "Unknown error"}`,
      };
    }
  }

  /**
   * Select next expansion candidates using the LLM planner
   */
  async selectNextExpansion(input: PlannerInput): Promise<PlannerOutput> {
    const userPayload = {
      task: "select_next_expansion",
      personA: input.personA,
      personB: input.personB,
      frontier: input.frontier,
      hopUsed: input.hopUsed,
      hopLimit: input.hopLimit,
      confidenceThreshold: input.confidenceThreshold,
      budgets: input.budgets,
      verifiedEdges: input.verifiedEdges,
      failedCandidates: input.failedCandidates,
      candidates: input.candidates.map(c => ({
        name: c.name,
        coappearCount: c.coappearCount,
        bestCoappearConfidence: c.bestCoappearConfidence,
      })),
    };

    try {
      const responseText = await this.makeRequest([
        { role: "system", content: OpenRouterClient.PLANNER_SYSTEM_PROMPT },
        { role: "user", content: `Current investigation state:\n${JSON.stringify(userPayload, null, 2)}\n\nSelect the best candidate(s) to explore next and provide search queries. Output ONLY valid JSON.` },
      ]);

      return this.parseAndValidatePlannerOutput(responseText, input);
    } catch (error) {
      console.warn("[OpenRouter] LLM call failed, using heuristic fallback:", error);
      return this.heuristicFallback(input);
    }
  }

  /**
   * Suggest specific real bridge candidates who might connect two people
   * @param personA - First person to connect from
   * @param personB - Target person to connect to
   * @param exclude - Optional list of names to exclude (already tried)
   */
  async suggestBridgeCandidates(personA: string, personB: string, exclude?: string[]): Promise<BridgeCandidateSuggestion[]> {
    try {
      const excludeClause = exclude && exclude.length > 0
        ? `\n\nIMPORTANT: Do NOT suggest any of these people (already tried): ${exclude.join(", ")}`
        : "";

      const responseText = await this.makeRequest([
        { role: "system", content: OpenRouterClient.BRIDGE_CANDIDATES_PROMPT },
        { role: "user", content: `Find bridge candidates between:\nPerson A: ${personA}\nPerson B: ${personB}\n\nSuggest specific real people who might have been photographed with BOTH of them.${excludeClause}` },
      ]);

      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error("No JSON found");
      }

      const parsed = JSON.parse(jsonMatch[0]);

      if (!Array.isArray(parsed.bridgeCandidates)) {
        throw new Error("No bridgeCandidates array");
      }

      return parsed.bridgeCandidates.map((bc: {
        name?: string;
        reasoning?: string;
        connectionToA?: string;
        connectionToB?: string;
        confidence?: number;
      }) => ({
        name: String(bc.name ?? "Unknown"),
        reasoning: String(bc.reasoning ?? ""),
        connectionToA: String(bc.connectionToA ?? ""),
        connectionToB: String(bc.connectionToB ?? ""),
        confidence: typeof bc.confidence === "number" ? bc.confidence : 50,
      })).slice(0, 10);
    } catch (error) {
      console.warn("[OpenRouter] Bridge candidate suggestion failed:", error);
      return [];
    }
  }

  /**
   * Parse a natural language query to extract two person names using AI
   */
  async parseQuery(query: string): Promise<{
    personA: string;
    personB: string;
    isValid: boolean;
    confidence: number;
    reason?: string;
  }> {
    try {
      const responseText = await this.makeRequest([
        { role: "system", content: OpenRouterClient.QUERY_PARSER_PROMPT },
        { role: "user", content: `Parse this query and extract the two people to connect:\n\n"${query}"` },
      ], { maxTokens: 256 });

      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error("No JSON found");
      }

      const parsed = JSON.parse(jsonMatch[0]);

      return {
        personA: String(parsed.personA ?? "").trim(),
        personB: String(parsed.personB ?? "").trim(),
        isValid: Boolean(parsed.isValid),
        confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0,
        reason: parsed.reason ? String(parsed.reason) : undefined,
      };
    } catch (error) {
      console.warn("[OpenRouter] Query parsing failed:", error);
      return {
        personA: "",
        personB: "",
        isValid: false,
        confidence: 0,
        reason: error instanceof Error ? error.message : "Failed to parse query",
      };
    }
  }

  /**
   * Parse and validate LLM planner output
   */
  private parseAndValidatePlannerOutput(responseText: string, input: PlannerInput): PlannerOutput {
    try {
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error("No JSON found in response");
      }

      const parsed = JSON.parse(jsonMatch[0]);

      if (!Array.isArray(parsed.nextCandidates) || parsed.nextCandidates.length === 0) {
        throw new Error("nextCandidates must be a non-empty array");
      }

      // Validate candidates exist in the provided list
      const validCandidateNames = new Set(input.candidates.map(c => c.name.toLowerCase()));
      const validatedCandidates = parsed.nextCandidates.filter((name: string) =>
        validCandidateNames.has(name.toLowerCase())
      );

      if (validatedCandidates.length === 0) {
        throw new Error("No valid candidates in LLM response");
      }

      const searchQueries = Array.isArray(parsed.searchQueries)
        ? parsed.searchQueries.slice(0, 4)
        : this.generateDefaultQueries(validatedCandidates[0], input.personB);

      return {
        nextCandidates: validatedCandidates.slice(0, 2),
        searchQueries,
        narration: String(parsed.narration ?? "Expanding search..."),
        stop: Boolean(parsed.stop),
        reason: String(parsed.reason ?? "LLM selection"),
      };
    } catch {
      console.warn("[OpenRouter] Failed to parse LLM output, using heuristic");
      return this.heuristicFallback(input);
    }
  }

  /**
   * Heuristic fallback when LLM fails
   */
  private heuristicFallback(input: PlannerInput): PlannerOutput {
    const failedSet = new Set(input.failedCandidates.map(n => n.toLowerCase()));
    const availableCandidates = input.candidates.filter(
      c => !failedSet.has(c.name.toLowerCase())
    );

    if (availableCandidates.length === 0) {
      return {
        nextCandidates: [],
        searchQueries: [],
        narration: "No viable candidates remaining.",
        stop: true,
        reason: "All candidates exhausted or failed",
      };
    }

    const sorted = [...availableCandidates].sort((a, b) => {
      if (b.bestCoappearConfidence !== a.bestCoappearConfidence) {
        return b.bestCoappearConfidence - a.bestCoappearConfidence;
      }
      return b.coappearCount - a.coappearCount;
    });

    const topCandidate = sorted[0];
    const secondCandidate = sorted[1];

    const nextCandidates = secondCandidate
      ? [topCandidate.name, secondCandidate.name]
      : [topCandidate.name];

    return {
      nextCandidates,
      searchQueries: this.generateDefaultQueries(topCandidate.name, input.personB),
      narration: `Trying expansion via ${topCandidate.name} (${topCandidate.bestCoappearConfidence}% confidence).`,
      stop: false,
      reason: `Heuristic: highest confidence (${topCandidate.bestCoappearConfidence}%) with ${topCandidate.coappearCount} co-appearances`,
    };
  }

  /**
   * Generate default search queries for a candidate
   */
  private generateDefaultQueries(candidate: string, target: string): string[] {
    return [
      `${candidate} ${target}`,
      `${candidate} ${target} event`,
    ];
  }
}

/**
 * Create an OpenRouter client from environment variables
 */
export function createOpenRouterClient(): OpenRouterClient {
  const apiKey = process.env.OPENROUTER_API_KEY;

  if (!apiKey) {
    throw new Error("OPENROUTER_API_KEY environment variable is required");
  }

  return new OpenRouterClient({
    apiKey,
    model: process.env.OPENROUTER_MODEL ?? "google/gemini-2.0-flash-001",
  });
}
