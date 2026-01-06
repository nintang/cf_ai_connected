import { Ai } from "@cloudflare/workers-types";
import { PlannerInput, PlannerOutput } from "@visual-degrees/contracts";

interface BridgeCandidateSuggestion {
  name: string;
  reasoning: string;
  connectionToA: string;
  connectionToB: string;
}

export class WorkersAIPlannerClient {
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

Your task is to call the 'submit_plan' function with the best next step.

FIELD RULES:
- nextCandidates: 1-2 names max, MUST exist in the provided candidates list
- searchQueries: 1-4 query strings using templates like "{candidate} {target}" or "{candidate} {target} event"
- narration: One short sentence for chat UI (e.g., "Exploring music industry connections")
- stop: true ONLY if budgets/hops make continuing pointless
- reason: Brief strategic reasoning (e.g., "Both in hip-hop industry" or "Known Met Gala attendees")

NARRATION EXAMPLES (use this style):
- "Exploring hip-hop industry connections via Kanye West."
- "Trying a path through political circles."
- "Bridging via entertainment industry network."
`;

  constructor(private ai: Ai, private modelId: string = "@cf/meta/llama-3.3-70b-instruct-fp8-fast") {}

  /**
   * Suggest bridge candidates using LLM world knowledge (names only, no percentages)
   * @param personA - First person to connect from
   * @param personB - Target person to connect to
   * @param exclude - Optional list of names to exclude (already tried)
   */
  async suggestBridgeCandidates(
    personA: string,
    personB: string,
    exclude?: string[]
  ): Promise<BridgeCandidateSuggestion[]> {
    const excludeClause = exclude && exclude.length > 0
      ? `\n\nIMPORTANT: Do NOT suggest any of these people (already tried): ${exclude.join(", ")}`
      : "";

    const prompt = `You are an expert strategist for finding visual connections between public figures.

Suggest SPECIFIC REAL PEOPLE who could bridge Person A and Person B based on:
1. INDUSTRY OVERLAP: People working in industries both A and B touch
2. SOCIAL CIRCLES: Mutual friends, collaborators, same events (Met Gala, Grammys, etc.)
3. SUPER-CONNECTORS: Talk show hosts, producers, moguls with wide networks
4. GEOGRAPHIC HUBS: People in same cities/scenes as both

Return strict JSON only:
{
  "bridgeCandidates": [
    { "name": "Full Name", "reasoning": "Strategic logic for bridging both worlds", "connectionToA": "relationship type", "connectionToB": "relationship type" }
  ]
}
No extra text.${excludeClause}`;

    try {
      const response = await this.ai.run(this.modelId as any, {
        messages: [
          { role: "system", content: prompt },
          { role: "user", content: `Person A: ${personA}\nPerson B: ${personB}` },
        ],
      });

      // @ts-ignore - response type from Ai.run is generic
      const text = response?.message?.content?.[0]?.text || "";
      const match = typeof text === "string" ? text.match(/\{[\s\S]*\}/) : null;
      if (!match) {
        console.warn("Workers AI bridge suggestion returned no JSON");
        return [];
      }

      const parsed = JSON.parse(match[0]);
      if (!Array.isArray(parsed.bridgeCandidates)) return [];

      return parsed.bridgeCandidates
        .map((bc: any) => ({
          name: String(bc.name ?? "").trim(),
          reasoning: String(bc.reasoning ?? "").trim(),
          connectionToA: String(bc.connectionToA ?? "").trim(),
          connectionToB: String(bc.connectionToB ?? "").trim(),
        }))
        .filter((bc: BridgeCandidateSuggestion) => bc.name.length > 0)
        .slice(0, 6);
    } catch (error) {
      console.warn(
        "Workers AI bridge suggestion failed:",
        error instanceof Error ? error.message : error
      );
      return [];
    }
  }

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

    const tools = [
      {
        name: "submit_plan",
        description: "Submit the investigation plan",
        parameters: {
          type: "object",
          properties: {
            nextCandidates: { 
              type: "array", 
              items: { type: "string" },
              description: "List of 1-2 candidate names to explore next"
            },
            searchQueries: { 
              type: "array", 
              items: { type: "string" },
              description: "List of 1-4 search queries"
            },
            narration: { type: "string", description: "Short status message for chat" },
            stop: { type: "boolean", description: "Whether to stop the investigation" },
            reason: { type: "string", description: "Reason for the decision" }
          },
          required: ["nextCandidates", "searchQueries", "narration", "stop", "reason"]
        }
      }
    ];

    try {
      const response = await this.ai.run(this.modelId as any, {
        messages: [
          { role: "system", content: WorkersAIPlannerClient.PLANNER_SYSTEM_PROMPT },
          { role: "user", content: `Current investigation state:\n${JSON.stringify(userPayload, null, 2)}` }
        ],
        tools: tools as any // Casting as tools type might vary in bindings
      });

      // @ts-ignore - response type from Ai.run is generic
      if (response.tool_calls && response.tool_calls.length > 0) {
        // @ts-ignore
        const args = response.tool_calls[0].arguments;
        // Verify structure (basic check)
        if (args && Array.isArray(args.nextCandidates)) {
          return args as PlannerOutput;
        }
      }

      // Fallback if no tool call or invalid
      console.warn("Workers AI did not call submit_plan, falling back to heuristic");
      return this.heuristicFallback(input);

    } catch (error) {
      console.error("Workers AI Planner failed:", error);
      return this.heuristicFallback(input);
    }
  }

  private heuristicFallback(input: PlannerInput): PlannerOutput {
    // Basic heuristic: pick highest confidence candidate
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

    // Sort by confidence (desc)
    const sorted = [...availableCandidates].sort((a, b) => b.bestCoappearConfidence - a.bestCoappearConfidence);
    const top = sorted[0];

    return {
      nextCandidates: [top.name],
      searchQueries: [`${top.name} ${input.personB}`],
      narration: `Trying expansion via ${top.name} (fallback).`,
      stop: false,
      reason: "Heuristic fallback"
    };
  }
}

