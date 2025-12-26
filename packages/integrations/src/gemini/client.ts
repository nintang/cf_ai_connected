import { GoogleGenerativeAI } from "@google/generative-ai";
import type { PlannerInput, PlannerOutput, Candidate } from "@visual-degrees/contracts";

// ============================================================================
// Research & Strategy Types
// ============================================================================

/**
 * Result of researching a potential connection between two people
 */
export interface ConnectionResearch {
  /** Summary of the research findings */
  summary: string;
  /** Industries or domains where they might intersect */
  industries: string[];
  /** Types of events where they might be photographed together */
  eventTypes: string[];
  /** Types of people who might bridge them */
  bridgeTypes: string[];
  /** Suggested search queries based on research */
  suggestedQueries: string[];
  /** Confidence in the research (0-100) */
  confidence: number;
  /** Detailed reasoning */
  reasoning: string;
}

/**
 * Strategic ranking of a candidate
 */
export interface RankedCandidate {
  /** Candidate name */
  name: string;
  /** Original co-appearance confidence */
  coappearConfidence: number;
  /** Strategic score (0-100) based on likelihood to connect to target */
  strategicScore: number;
  /** Why this candidate is strategically valuable */
  reasoning: string;
  /** Suggested queries specifically for this candidate */
  suggestedQueries: string[];
}

/**
 * Result of strategic candidate ranking
 */
export interface StrategicRanking {
  /** Re-ranked candidates with strategic scores */
  rankedCandidates: RankedCandidate[];
  /** Overall strategy explanation */
  strategy: string;
  /** Best path hypothesis */
  hypothesis: string;
}

/**
 * Configuration for Gemini client
 */
export interface GeminiConfig {
  apiKey: string;
  model?: string;
  gatewayUrl?: string;
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
 * Gemini Flash client for visual verification
 * Filters out collages, photogrids, and split-screen images
 */
export class GeminiVisualFilterClient {
  private readonly genAI: GoogleGenerativeAI;
  private readonly modelName: string;
  private readonly gatewayUrl?: string;
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
    this.gatewayUrl = config.gatewayUrl;
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

      const base64 = arrayBufferToBase64(arrayBuffer);

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
    const requestOptions = this.gatewayUrl ? { baseUrl: this.gatewayUrl } : undefined;
    const model = this.genAI.getGenerativeModel({ model: this.modelName }, requestOptions);

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
    gatewayUrl: process.env.GEMINI_GATEWAY_URL,
  });
}

// ============================================================================
// LLM Planner Client
// ============================================================================

/**
 * Gemini-based LLM planner for selecting next expansion candidates
 * Used to guide the investigation toward the target person
 */
export class GeminiPlannerClient {
  private readonly genAI: GoogleGenerativeAI;
  private readonly modelName: string;
  private readonly gatewayUrl?: string;

  private static readonly PLANNER_SYSTEM_PROMPT = `You are a planning assistant for a visual evidence pipeline that finds visual connections between public figures.

CRITICAL RULES:
- You do NOT identify faces.
- You only choose what to search next using the candidates provided.
- You must output ONLY strict JSON and nothing else.
- You must NOT invent relationships, events, or facts.
- Select candidates that maximize probability of finding verified image co-presence with the target.

Your output MUST be a valid JSON object with this exact structure:
{
  "nextCandidates": ["name1", "name2"],
  "searchQueries": ["query1", "query2"],
  "narration": "Short status message for the user",
  "stop": false,
  "reason": "Brief justification based on candidate stats"
}

FIELD RULES:
- nextCandidates: 1-2 names max, MUST exist in the provided candidates list
- searchQueries: 1-4 query strings using templates like "{candidate} {target}" or "{candidate} {target} event"
- narration: One short sentence for chat UI (no claims beyond "visual evidence search")
- stop: true ONLY if budgets/hops make continuing pointless
- reason: Brief justification referencing candidate stats (count/confidence), not speculation

NARRATION EXAMPLES (use this style):
- "Expanding via Kanye West due to high-confidence co-appearances."
- "Trying a path through political circles."
- "Verifying connection through entertainment industry contacts."

DO NOT say things like:
- "They are friends"
- "They worked together"
- Any claim about personal relationships`;

  constructor(config: GeminiConfig) {
    this.genAI = new GoogleGenerativeAI(config.apiKey);
    this.modelName = config.model ?? "gemini-2.0-flash";
    this.gatewayUrl = config.gatewayUrl;
  }

  /**
   * Select next expansion candidates using the LLM planner
   * Falls back to heuristic selection if LLM fails
   */
  async selectNextExpansion(input: PlannerInput): Promise<PlannerOutput> {
    const requestOptions = this.gatewayUrl ? { baseUrl: this.gatewayUrl } : undefined;
    const model = this.genAI.getGenerativeModel({ model: this.modelName }, requestOptions);

    // Build the user message payload
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
      const result = await model.generateContent([
        GeminiPlannerClient.PLANNER_SYSTEM_PROMPT,
        `Current investigation state:\n${JSON.stringify(userPayload, null, 2)}`,
        "Select the best candidate(s) to explore next and provide search queries. Output ONLY valid JSON.",
      ]);

      const responseText = result.response.text();
      const parsed = this.parseAndValidateOutput(responseText, input);
      return parsed;
    } catch (error) {
      // Fall back to heuristic selection
      console.warn(
        "[GeminiPlanner] LLM call failed, using heuristic fallback:",
        error instanceof Error ? error.message : error
      );
      return this.heuristicFallback(input);
    }
  }

  /**
   * Parse and validate LLM output, falling back to heuristic if invalid
   */
  private parseAndValidateOutput(
    responseText: string,
    input: PlannerInput
  ): PlannerOutput {
    try {
      // Extract JSON from the response (handle markdown code blocks)
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error("No JSON found in response");
      }

      const parsed = JSON.parse(jsonMatch[0]);

      // Validate required fields
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

      // Validate search queries
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
      console.warn("[GeminiPlanner] Failed to parse LLM output, using heuristic");
      return this.heuristicFallback(input);
    }
  }

  /**
   * Heuristic fallback when LLM fails
   * Picks candidate with highest bestCoappearConfidence, tie-break by count
   */
  private heuristicFallback(input: PlannerInput): PlannerOutput {
    // Filter out failed candidates
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

    // Sort by confidence (desc), then by count (desc)
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

  // ==========================================================================
  // Research & Strategic Intelligence
  // ==========================================================================

  private static readonly RESEARCH_PROMPT = `You are a research assistant helping find visual connections between public figures.

Your task: Research how Person A might be connected to Person B through shared events, industries, or mutual contacts.

IMPORTANT RULES:
- Base your research on publicly known information about these people
- Focus on contexts where they might be PHOTOGRAPHED together (events, galas, political meetings, shows, etc.)
- Do NOT claim they are friends or have personal relationships
- Think about: professions, industries, political affiliations, entertainment events, charity events, business connections

Output ONLY valid JSON with this structure:
{
  "summary": "Brief summary of potential connection paths",
  "industries": ["industry1", "industry2"],
  "eventTypes": ["type of event where they might be photographed"],
  "bridgeTypes": ["types of people who might connect them, e.g., 'politicians', 'music producers'"],
  "suggestedQueries": ["search query 1", "search query 2", "search query 3"],
  "confidence": 0-100,
  "reasoning": "Detailed reasoning about the connection hypothesis"
}`;

  /**
   * Research potential connection paths between two people
   * Uses LLM's knowledge to suggest industries, events, and bridge types
   */
  async researchConnection(personA: string, personB: string): Promise<ConnectionResearch> {
    const requestOptions = this.gatewayUrl ? { baseUrl: this.gatewayUrl } : undefined;
    const model = this.genAI.getGenerativeModel({ model: this.modelName }, requestOptions);

    try {
      const result = await model.generateContent([
        GeminiPlannerClient.RESEARCH_PROMPT,
        `Research connection paths between:\nPerson A: ${personA}\nPerson B: ${personB}\n\nProvide strategic research to help find visual evidence of their connection.`,
      ]);

      const responseText = result.response.text();
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      
      if (!jsonMatch) {
        throw new Error("No JSON found");
      }

      const parsed = JSON.parse(jsonMatch[0]);

      return {
        summary: String(parsed.summary ?? "Research completed"),
        industries: Array.isArray(parsed.industries) ? parsed.industries : [],
        eventTypes: Array.isArray(parsed.eventTypes) ? parsed.eventTypes : [],
        bridgeTypes: Array.isArray(parsed.bridgeTypes) ? parsed.bridgeTypes : [],
        suggestedQueries: Array.isArray(parsed.suggestedQueries) ? parsed.suggestedQueries.slice(0, 5) : [],
        confidence: typeof parsed.confidence === "number" ? parsed.confidence : 50,
        reasoning: String(parsed.reasoning ?? ""),
      };
    } catch (error) {
      // Return basic research on failure
      return {
        summary: `Researching connection between ${personA} and ${personB}`,
        industries: [],
        eventTypes: ["public events", "galas", "press conferences"],
        bridgeTypes: ["celebrities", "politicians", "business leaders"],
        suggestedQueries: [
          `${personA} ${personB}`,
          `${personA} with celebrities`,
          `${personB} with celebrities`,
        ],
        confidence: 30,
        reasoning: "Using default research due to LLM failure",
      };
    }
  }

  private static readonly STRATEGIC_RANKING_PROMPT = `You are a strategic advisor for finding visual connections between public figures.

Given:
- A starting person (frontier) we've verified connection with
- A target person we want to reach
- A list of candidates discovered from images with the frontier
- Previous research about the connection

Your task: Re-rank the candidates by their STRATEGIC VALUE for reaching the target.

Consider:
1. Does the candidate work in the same industry as the target?
2. Have they likely attended the same events as the target?
3. Are they in the same social/professional circles as the target?
4. How "famous" are they (more famous = more likely photographed with target)?

Output ONLY valid JSON:
{
  "rankedCandidates": [
    {
      "name": "Candidate Name",
      "strategicScore": 0-100,
      "reasoning": "Why this candidate might connect to target",
      "suggestedQueries": ["query1", "query2"]
    }
  ],
  "strategy": "Overall strategy explanation",
  "hypothesis": "Best path hypothesis to reach the target"
}`;

  /**
   * Strategically rank candidates based on likelihood to connect to target
   */
  async rankCandidatesStrategically(
    frontier: string,
    target: string,
    candidates: Candidate[],
    research: ConnectionResearch
  ): Promise<StrategicRanking> {
    const requestOptions = this.gatewayUrl ? { baseUrl: this.gatewayUrl } : undefined;
    const model = this.genAI.getGenerativeModel({ model: this.modelName }, requestOptions);

    const payload = {
      frontier,
      target,
      research: {
        summary: research.summary,
        industries: research.industries,
        bridgeTypes: research.bridgeTypes,
      },
      candidates: candidates.slice(0, 15).map(c => ({
        name: c.name,
        coappearCount: c.coappearCount,
        confidence: c.bestCoappearConfidence,
      })),
    };

    try {
      const result = await model.generateContent([
        GeminiPlannerClient.STRATEGIC_RANKING_PROMPT,
        `Strategic ranking request:\n${JSON.stringify(payload, null, 2)}`,
      ]);

      const responseText = result.response.text();
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      
      if (!jsonMatch) {
        throw new Error("No JSON found");
      }

      const parsed = JSON.parse(jsonMatch[0]);

      const rankedCandidates: RankedCandidate[] = [];
      if (Array.isArray(parsed.rankedCandidates)) {
        for (const rc of parsed.rankedCandidates) {
          // Match to original candidate
          const original = candidates.find(
            c => c.name.toLowerCase() === String(rc.name).toLowerCase()
          );
          if (original) {
            rankedCandidates.push({
              name: original.name,
              coappearConfidence: original.bestCoappearConfidence,
              strategicScore: typeof rc.strategicScore === "number" ? rc.strategicScore : 50,
              reasoning: String(rc.reasoning ?? ""),
              suggestedQueries: Array.isArray(rc.suggestedQueries) ? rc.suggestedQueries : [],
            });
          }
        }
      }

      // Add any candidates not ranked by LLM with default scores
      for (const c of candidates) {
        if (!rankedCandidates.find(rc => rc.name === c.name)) {
          rankedCandidates.push({
            name: c.name,
            coappearConfidence: c.bestCoappearConfidence,
            strategicScore: c.bestCoappearConfidence * 0.5, // Half credit
            reasoning: "Not strategically ranked by LLM",
            suggestedQueries: [],
          });
        }
      }

      // Sort by strategic score
      rankedCandidates.sort((a, b) => b.strategicScore - a.strategicScore);

      return {
        rankedCandidates,
        strategy: String(parsed.strategy ?? "Using strategic ranking"),
        hypothesis: String(parsed.hypothesis ?? ""),
      };
    } catch (error) {
      // Fallback: use confidence as strategic score
      const rankedCandidates = candidates.map(c => ({
        name: c.name,
        coappearConfidence: c.bestCoappearConfidence,
        strategicScore: c.bestCoappearConfidence,
        reasoning: "Fallback ranking based on confidence",
        suggestedQueries: [`${c.name} ${target}`, `${c.name} ${target} event`],
      }));

      rankedCandidates.sort((a, b) => b.strategicScore - a.strategicScore);

      return {
        rankedCandidates,
        strategy: "Using confidence-based ranking (LLM fallback)",
        hypothesis: "",
      };
    }
  }

  /**
   * Generate smart search queries based on research and context
   */
  async generateSmartQueries(
    frontier: string,
    target: string,
    research: ConnectionResearch
  ): Promise<string[]> {
    const queries: string[] = [];

    // Direct queries
    queries.push(`${frontier} ${target}`);
    queries.push(`${frontier} ${target} together`);

    // Industry-based queries
    for (const industry of research.industries.slice(0, 2)) {
      queries.push(`${frontier} ${industry}`);
    }

    // Event-based queries
    for (const eventType of research.eventTypes.slice(0, 2)) {
      queries.push(`${frontier} ${eventType}`);
    }

    // Add research-suggested queries
    queries.push(...research.suggestedQueries.slice(0, 3));

    // Deduplicate
    return [...new Set(queries)].slice(0, 8);
  }

  private static readonly FRONTIER_QUERIES_PROMPT = `You are a search query generator for finding photos of public figures with other people.

Given a person's name, generate 4-6 search queries that are most likely to find images of them photographed with OTHER famous people.

Think about:
- What is this person's profession/field?
- What events do they typically attend where they'd be photographed with others?
- What contexts are they commonly photographed in?

Examples of good contextual queries:
- For a musician: "Taylor Swift Grammy awards", "Taylor Swift concert backstage", "Taylor Swift music video"
- For an actor: "Leonardo DiCaprio film premiere", "Leonardo DiCaprio Oscars", "Leonardo DiCaprio red carpet"
- For a politician: "Joe Biden summit", "Joe Biden state dinner", "Joe Biden press conference"
- For an athlete: "LeBron James All-Star game", "LeBron James charity event", "LeBron James Nike"
- For a business leader: "Elon Musk conference", "Elon Musk product launch", "Elon Musk interview"

Output ONLY a JSON array of query strings. No explanation, just the array.
Example: ["query 1", "query 2", "query 3", "query 4"]`;

  /**
   * Generate contextual discovery queries for a frontier person
   * Uses LLM to determine the best query suffixes based on who the person is
   */
  async generateFrontierQueries(frontier: string): Promise<string[]> {
    const requestOptions = this.gatewayUrl ? { baseUrl: this.gatewayUrl } : undefined;
    const model = this.genAI.getGenerativeModel({ model: this.modelName }, requestOptions);

    try {
      const result = await model.generateContent([
        GeminiPlannerClient.FRONTIER_QUERIES_PROMPT,
        `Generate search queries to find photos of "${frontier}" with other famous people.`,
      ]);

      const responseText = result.response.text();
      
      // Extract JSON array from response
      const arrayMatch = responseText.match(/\[[\s\S]*\]/);
      if (!arrayMatch) {
        throw new Error("No JSON array found");
      }

      const parsed = JSON.parse(arrayMatch[0]);
      
      if (!Array.isArray(parsed) || parsed.length === 0) {
        throw new Error("Invalid response format");
      }

      // Validate all items are strings and limit to 6
      const queries = parsed
        .filter((q: unknown) => typeof q === "string" && q.length > 0)
        .slice(0, 6) as string[];

      if (queries.length === 0) {
        throw new Error("No valid queries in response");
      }

      return queries;

    } catch (error) {
      // Fallback to basic queries
      console.warn(
        "[GeminiPlanner] Failed to generate frontier queries, using fallback:",
        error instanceof Error ? error.message : error
      );
      return [
        `${frontier} photo`,
        `${frontier} event`,
        `${frontier} with`,
      ];
    }
  }
}

/**
 * Create a GeminiPlannerClient from environment variables
 */
export function createGeminiPlannerClient(): GeminiPlannerClient {
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    throw new Error("GEMINI_API_KEY environment variable is required");
  }

  return new GeminiPlannerClient({
    apiKey,
    model: process.env.GEMINI_MODEL ?? "gemini-2.0-flash",
    gatewayUrl: process.env.GEMINI_GATEWAY_URL,
  });
}

