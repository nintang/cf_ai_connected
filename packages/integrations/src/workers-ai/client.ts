import { Ai } from "@cloudflare/workers-types";
import { PlannerInput, PlannerOutput } from "@visual-degrees/contracts";

interface BridgeCandidateSuggestion {
  name: string;
  reasoning: string;
  connectionToA: string;
  connectionToB: string;
}

export class WorkersAIPlannerClient {
  private static readonly PLANNER_SYSTEM_PROMPT = `You are a planning assistant for a visual evidence pipeline that finds visual connections between public figures.

CRITICAL RULES:
- You do NOT identify faces.
- You only choose what to search next using the candidates provided.
- You must output ONLY strict JSON and nothing else.
- You must NOT invent relationships, events, or facts.
- Select candidates that maximize probability of finding verified image co-presence with the target.

Your task is to call the 'submit_plan' function with the best next step.

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

    const prompt = `Suggest real bridge candidates who might have been photographed with BOTH people.
Return strict JSON:
{
  "bridgeCandidates": [
    { "name": "Person", "reasoning": "Why they connect both", "connectionToA": "short", "connectionToB": "short" }
  ]
}
No percentages. No extra text.${excludeClause}`;

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

