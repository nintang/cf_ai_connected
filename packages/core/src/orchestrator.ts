/**
 * Investigation Orchestrator - State Machine for Multi-Hop Expansion
 *
 * Implements the workflow from 03_runtime_workflow_state_machine.md:
 * S1: Direct Edge Attempt
 * S2: Candidate Discovery
 * S3: LLM Select Next Expansion
 * S4: Verify Next Edge
 * S5: Bridge Toward Target
 * S6: Finalize Success
 * S7: Finalize Failure
 */

import type {
  InvestigationConfig,
  InvestigationBudgets,
  InvestigationState,
  InvestigationResult,
  VerifiedEdge,
  VerifiedPath,
  EvidenceRecord,
  Candidate,
  PlannerInput,
  PlannerOutput,
  ImageSearchResult,
  ImageAnalysisResult,
  DEFAULT_CONFIG,
  DEFAULT_BUDGETS,
} from "@visual-degrees/contracts";

import {
  directQuery,
  discoveryQueries,
  verificationQueries,
  bridgeQueries,
} from "./query-templates.js";

import {
  isValidEvidence,
  createEvidenceRecord,
  createVerifiedEdge,
  calculatePathConfidence,
  aggregateCandidates,
  namesMatch,
} from "./confidence.js";

import type { AnalysisWithContext } from "./confidence.js";

// ============================================================================
// Event Types for Progress Callbacks
// ============================================================================

export type InvestigationEventType =
  | "status"
  | "evidence"
  | "path_update"
  | "candidate_discovery"
  | "llm_selection"
  | "research"
  | "strategy"
  | "thinking"
  | "error";

export interface InvestigationEvent {
  type: InvestigationEventType;
  message: string;
  data?: unknown;
}

export type EventCallback = (event: InvestigationEvent) => void;

// ============================================================================
// Research & Strategy Types (from intelligent planner)
// ============================================================================

export interface ConnectionResearch {
  summary: string;
  industries: string[];
  eventTypes: string[];
  bridgeTypes: string[];
  suggestedQueries: string[];
  confidence: number;
  reasoning: string;
}

export interface RankedCandidate {
  name: string;
  coappearConfidence: number;
  strategicScore: number;
  reasoning: string;
  suggestedQueries: string[];
}

export interface StrategicRanking {
  rankedCandidates: RankedCandidate[];
  strategy: string;
  hypothesis: string;
}

export interface BridgeCandidateSuggestion {
  name: string;
  reasoning: string;
  connectionToA: string;
  connectionToB: string;
  confidence: number;
}

// ============================================================================
// Client Interfaces (Dependency Injection)
// ============================================================================

export interface SearchClient {
  searchImages(query: string): Promise<{ results: ImageSearchResult[] }>;
}

export interface VisualFilterClient {
  verifyVisualCopresence(
    imageUrl: string
  ): Promise<{ isValidScene: boolean; reason: string }>;
}

export interface CelebrityDetectionClient {
  detectCelebrities(imageUrl: string): Promise<ImageAnalysisResult>;
}

export interface PlannerClient {
  selectNextExpansion(input: PlannerInput): Promise<PlannerOutput>;
}

/**
 * Intelligent planner with research and strategic ranking capabilities
 */
export interface IntelligentPlannerClient extends PlannerClient {
  /** Research potential connection paths between two people */
  researchConnection(personA: string, personB: string): Promise<ConnectionResearch>;
  /** 
   * Suggest specific real bridge candidates based on LLM's world knowledge
   * Returns actual people names who might connect personA and personB
   */
  suggestBridgeCandidates(personA: string, personB: string): Promise<BridgeCandidateSuggestion[]>;
  /** Strategically rank candidates based on likelihood to reach target */
  rankCandidatesStrategically(
    frontier: string,
    target: string,
    candidates: Candidate[],
    research: ConnectionResearch
  ): Promise<StrategicRanking>;
  /** Generate smart queries based on research context */
  generateSmartQueries(
    frontier: string,
    target: string,
    research: ConnectionResearch
  ): Promise<string[]>;
  /** 
   * Generate contextual discovery queries for a frontier person
   * Uses LLM to determine the best query suffixes based on who the person is
   * (e.g., "concert" for musicians, "premiere" for actors, "summit" for politicians)
   */
  generateFrontierQueries(frontier: string): Promise<string[]>;
}

export interface OrchestratorClients {
  search: SearchClient;
  visualFilter: VisualFilterClient;
  celebrityDetection: CelebrityDetectionClient;
  planner: PlannerClient | IntelligentPlannerClient;
}

// ============================================================================
// Orchestrator Class
// ============================================================================

export class InvestigationOrchestrator {
  private readonly config: InvestigationConfig;
  private readonly clients: OrchestratorClients;
  private readonly onEvent?: EventCallback;
  private research: ConnectionResearch | null = null;
  private suggestedBridges: BridgeCandidateSuggestion[] = [];

  constructor(
    clients: OrchestratorClients,
    config?: Partial<InvestigationConfig>,
    onEvent?: EventCallback
  ) {
    this.clients = clients;
    this.config = {
      hopLimit: config?.hopLimit ?? 6,
      confidenceThreshold: config?.confidenceThreshold ?? 80,
      imagesPerQuery: config?.imagesPerQuery ?? 5,
    };
    this.onEvent = onEvent;
  }

  /**
   * Check if the planner is an intelligent planner with research capabilities
   */
  private isIntelligentPlanner(
    planner: PlannerClient | IntelligentPlannerClient
  ): planner is IntelligentPlannerClient {
    return (
      "researchConnection" in planner &&
      "suggestBridgeCandidates" in planner &&
      "rankCandidatesStrategically" in planner &&
      "generateSmartQueries" in planner &&
      "generateFrontierQueries" in planner
    );
  }

  /**
   * Emit an event to the callback if provided
   */
  private emit(
    type: InvestigationEventType,
    message: string,
    data?: unknown
  ): void {
    this.onEvent?.({ type, message, data });
  }

  /**
   * Main entry point: Run a full investigation
   */
  async runInvestigation(
    personA: string,
    personB: string
  ): Promise<InvestigationResult> {
    // Initialize state
    const state: InvestigationState = {
      personA,
      personB,
      frontier: personA,
      hopDepth: 0,
      path: [personA],
      verifiedEdges: [],
      failedCandidates: [],
      budgets: {
        maxSearchCalls: 20,
        maxRekognitionCalls: 100,
        maxLLMCalls: 15,
        searchCallsUsed: 0,
        rekognitionCallsUsed: 0,
        llmCallsUsed: 0,
      },
      status: "running",
    };

    this.emit("status", `Starting investigation: ${personA} → ${personB}`);

    // Phase 0: Research connection (if intelligent planner)
    if (this.isIntelligentPlanner(this.clients.planner)) {
      await this.runResearchPhase(personA, personB);
    }

    // S1: Attempt direct edge
    const directResult = await this.attemptDirectEdge(state);
    if (directResult) {
      return this.finalizeSuccess(state, directResult);
    }

    // Main expansion loop
    while (state.status === "running" && state.hopDepth < this.config.hopLimit) {
      // Check budgets
      if (this.isBudgetExhausted(state.budgets)) {
        this.emit("status", "Budget exhausted");
        break;
      }

      // S2: Discover candidates from current frontier
      const candidates = await this.discoverCandidates(state);

      if (candidates.length === 0) {
        this.emit("status", "No viable candidates found from frontier");
        break;
      }

      // S3: LLM selects next candidate(s)
      const plannerResult = await this.selectNextCandidate(state, candidates);

      if (plannerResult.stop || plannerResult.nextCandidates.length === 0) {
        this.emit("status", plannerResult.narration);
        break;
      }

      // Try each candidate
      let foundPath = false;
      for (const candidateName of plannerResult.nextCandidates) {
        // S4: Verify edge from frontier to candidate
        const edgeToCandidate = await this.verifyEdge(
          state,
          state.frontier,
          candidateName
        );

        if (!edgeToCandidate) {
          state.failedCandidates.push(candidateName);
          this.emit("status", `Could not verify edge to ${candidateName}`);
          continue;
        }

        // Edge verified! Update state
        state.verifiedEdges.push(edgeToCandidate);
        state.path.push(candidateName);
        state.hopDepth++;

        this.emit("evidence", `Verified: ${state.frontier} ↔ ${candidateName}`, {
          edge: edgeToCandidate,
        });
        this.emit("path_update", `Path: ${state.path.join(" → ")}`, {
          path: state.path,
        });

        // S5: Try to bridge to target
        const bridgeEdge = await this.attemptBridgeToTarget(state, candidateName);

        if (bridgeEdge) {
          // Success! We found a path
          state.verifiedEdges.push(bridgeEdge);
          state.path.push(personB);
          return this.finalizeSuccess(state);
        }

        // No direct bridge, continue expansion from new frontier
        state.frontier = candidateName;
        state.failedCandidates = []; // Reset failed candidates for new frontier
        foundPath = true;
        break;
      }

      if (!foundPath) {
        // All candidates for this frontier failed
        this.emit("status", "All candidates failed for current frontier");
        break;
      }
    }

    // S7: Finalize failure
    return this.finalizeFailure(state);
  }

  /**
   * Phase 0: Research potential connection paths using LLM knowledge
   */
  private async runResearchPhase(personA: string, personB: string): Promise<void> {
    if (!this.isIntelligentPlanner(this.clients.planner)) return;

    this.emit("research", `Researching potential connections between ${personA} and ${personB}...`);

    try {
      // Get general research about the connection
      this.research = await this.clients.planner.researchConnection(personA, personB);

      this.emit("thinking", `Research complete`, { research: this.research });

      // Emit detailed research findings
      this.emit("research", `📊 Research Summary: ${this.research.summary}`);

      if (this.research.industries.length > 0) {
        this.emit("thinking", `Industries: ${this.research.industries.join(", ")}`);
      }

      if (this.research.bridgeTypes.length > 0) {
        this.emit("thinking", `Bridge types: ${this.research.bridgeTypes.join(", ")}`);
      }

      if (this.research.eventTypes.length > 0) {
        this.emit("thinking", `Event types: ${this.research.eventTypes.join(", ")}`);
      }

      this.emit("thinking", `Research confidence: ${this.research.confidence}%`);

      if (this.research.reasoning) {
        this.emit("thinking", `💭 ${this.research.reasoning}`);
      }

      // Get specific bridge candidate suggestions from LLM's world knowledge
      this.emit("research", `🎯 Finding specific bridge candidates...`);
      this.suggestedBridges = await this.clients.planner.suggestBridgeCandidates(personA, personB);

      if (this.suggestedBridges.length > 0) {
        this.emit("research", `💡 Suggested bridge candidates (from LLM knowledge):`);
        for (const bridge of this.suggestedBridges.slice(0, 5)) {
          this.emit("thinking", `  • ${bridge.name} (${bridge.confidence}%): ${bridge.reasoning}`);
        }
      }

    } catch (error) {
      this.emit("error", `Research failed: ${error instanceof Error ? error.message : "Unknown"}`);
    }
  }

  /**
   * S1: Attempt direct edge between current endpoints
   */
  private async attemptDirectEdge(
    state: InvestigationState
  ): Promise<VerifiedEdge | null> {
    this.emit("status", `Searching for direct connection: ${state.personA} ↔ ${state.personB}`);

    const query = directQuery(state.personA, state.personB);
    const evidence = await this.searchAndVerify(
      state,
      query,
      state.personA,
      state.personB
    );

    if (evidence.length > 0) {
      const edge = createVerifiedEdge(state.personA, state.personB, evidence);
      if (edge) {
        this.emit("evidence", "Direct connection found!", { edge });
        return edge;
      }
    }

    this.emit("status", "No direct connection found, expanding search...");
    return null;
  }

  /**
   * S2: Discover candidate intermediates from the frontier
   */
  private async discoverCandidates(
    state: InvestigationState
  ): Promise<Candidate[]> {
    this.emit(
      "candidate_discovery",
      `Discovering candidates from ${state.frontier}...`
    );

    // Build queries prioritizing suggested bridge candidates
    let queries: string[] = [];
    
    // PRIORITY 1: Search for frontier with each suggested bridge candidate
    // These are high-value targets from LLM's world knowledge
    // Filter out bridges that match the current frontier or are already in path
    if (this.suggestedBridges.length > 0) {
      const frontierLower = state.frontier.toLowerCase();
      const pathLower = new Set(state.path.map(p => p.toLowerCase()));
      
      const validBridges = this.suggestedBridges.filter(b => {
        const nameLower = b.name.toLowerCase();
        return !nameLower.includes(frontierLower) && 
               !frontierLower.includes(nameLower) &&
               !pathLower.has(nameLower);
      });
      
      const bridgeQueries = validBridges
        .slice(0, 5)
        .map(b => `${state.frontier} ${b.name}`);
      queries.push(...bridgeQueries);
      
      if (bridgeQueries.length > 0) {
        this.emit("thinking", `Generated ${bridgeQueries.length} queries from suggested bridges`);
        for (const b of validBridges.slice(0, 3)) {
          this.emit("thinking", `  → "${state.frontier} ${b.name}" (${b.reasoning})`);
        }
      }
    }

    // PRIORITY 2: Use smart queries from LLM if available
    if (this.isIntelligentPlanner(this.clients.planner)) {
      try {
        if (this.research) {
          // Use research-informed queries when we have research
          const smartQueries = await this.clients.planner.generateSmartQueries(
            state.frontier,
            state.personB,
            this.research
          );
          // Add smart queries that aren't duplicates
          const existingSet = new Set(queries.map(q => q.toLowerCase()));
          for (const q of smartQueries) {
            if (!existingSet.has(q.toLowerCase())) {
              queries.push(q);
            }
          }
          this.emit("thinking", `Added ${smartQueries.length} research-based queries`);
        } else if (queries.length === 0) {
          // Fallback: Generate contextual queries based on who the frontier person is
          queries = await this.clients.planner.generateFrontierQueries(state.frontier);
          this.emit("thinking", `Generated ${queries.length} contextual queries for ${state.frontier}`);
        }
      } catch {
        if (queries.length === 0) {
        queries = discoveryQueries(state.frontier);
      }
      }
    } else if (queries.length === 0) {
      queries = discoveryQueries(state.frontier);
    }

    // Log final queries
    this.emit("thinking", `Total queries: ${queries.length}`);
    for (const q of queries.slice(0, 4)) {
      this.emit("thinking", `  → "${q}"`);
    }

    const allAnalyses: AnalysisWithContext[] = [];
    let foundHighConfidenceCandidates = false;

    for (const query of queries) {
      if (this.isBudgetExhausted(state.budgets)) break;

      this.emit("status", `Searching: "${query}"`);
      const analyses = await this.searchAndAnalyze(state, query, state.frontier);
      allAnalyses.push(...analyses);

      // Check if we found strong candidates
      const currentCandidates = aggregateCandidates(
        allAnalyses,
        state.frontier,
        state.path,
        this.config.confidenceThreshold
      );

      // Heuristic: If we found at least 2 candidates with >90% confidence, stop searching
      const highConfCandidates = currentCandidates.filter(c => c.bestCoappearConfidence >= 90);
      if (highConfCandidates.length >= 2) {
        this.emit("thinking", `Found ${highConfCandidates.length} high-confidence candidates (${highConfCandidates.map(c => c.name).join(", ")}). Stopping search early.`);
        foundHighConfidenceCandidates = true;
        break;
      }
    }

    // Aggregate candidates, excluding people already in the path
    let candidates = aggregateCandidates(
      allAnalyses,
      state.frontier,
      state.path,
      this.config.confidenceThreshold
    );

    this.emit(
      "candidate_discovery",
      `Found ${candidates.length} raw candidate(s) from image analysis`
    );

    // Strategic ranking if research is available
    if (candidates.length > 0 && this.research && this.isIntelligentPlanner(this.clients.planner)) {
      this.emit("strategy", `Analyzing candidates strategically...`);

      try {
        state.budgets.llmCallsUsed++;
        const ranking = await this.clients.planner.rankCandidatesStrategically(
          state.frontier,
          state.personB,
          candidates,
          this.research
        );

        this.emit("strategy", `📋 Strategy: ${ranking.strategy}`);

        if (ranking.hypothesis) {
          this.emit("thinking", `💡 Hypothesis: ${ranking.hypothesis}`);
        }

        // Show top candidates with reasoning
        const topRanked = ranking.rankedCandidates.slice(0, 5);
        for (const rc of topRanked) {
          const score = Math.round(rc.strategicScore);
          const conf = Math.round(rc.coappearConfidence);
          this.emit(
            "thinking",
            `  ${rc.name}: Strategic ${score}%, Confidence ${conf}%`
          );
          if (rc.reasoning) {
            this.emit("thinking", `    → ${rc.reasoning}`);
          }
        }

        // Convert ranked candidates back to Candidate format, preserving strategic order
        const rankedCandidateNames = new Set(ranking.rankedCandidates.map(rc => rc.name.toLowerCase()));
        const strategicCandidates: Candidate[] = [];

        for (const rc of ranking.rankedCandidates) {
          const original = candidates.find(c => c.name.toLowerCase() === rc.name.toLowerCase());
          if (original) {
            strategicCandidates.push({
              ...original,
              // Store strategic score in confidence for sorting purposes
              bestCoappearConfidence: rc.strategicScore,
            });
          }
        }

        // Add any candidates not ranked (shouldn't happen, but safety)
        for (const c of candidates) {
          if (!rankedCandidateNames.has(c.name.toLowerCase())) {
            strategicCandidates.push(c);
          }
        }

        candidates = strategicCandidates;
      } catch (error) {
        this.emit("error", `Strategic ranking failed: ${error instanceof Error ? error.message : "Unknown"}`);
      }
    }

    this.emit(
      "candidate_discovery",
      `${candidates.length} candidate(s) ready for exploration`,
      { candidates: candidates.slice(0, 5) }
    );

    return candidates;
  }

  /**
   * S3: Use LLM to select next candidate(s) to explore
   */
  private async selectNextCandidate(
    state: InvestigationState,
    candidates: Candidate[]
  ): Promise<PlannerOutput> {
    // Check LLM budget
    if (state.budgets.llmCallsUsed >= state.budgets.maxLLMCalls) {
      // Fallback to heuristic
      return this.heuristicSelection(candidates, state);
    }

    const input: PlannerInput = {
      personA: state.personA,
      personB: state.personB,
      frontier: state.frontier,
      hopUsed: state.hopDepth,
      hopLimit: this.config.hopLimit,
      confidenceThreshold: this.config.confidenceThreshold,
      budgets: {
        searchCallsRemaining:
          state.budgets.maxSearchCalls - state.budgets.searchCallsUsed,
        rekognitionCallsRemaining:
          state.budgets.maxRekognitionCalls - state.budgets.rekognitionCallsUsed,
        llmCallsRemaining:
          state.budgets.maxLLMCalls - state.budgets.llmCallsUsed,
      },
      verifiedEdges: state.verifiedEdges.map((e) => ({
        from: e.from,
        to: e.to,
        confidence: e.edgeConfidence,
      })),
      failedCandidates: state.failedCandidates,
      candidates,
    };

    state.budgets.llmCallsUsed++;

    try {
      const result = await this.clients.planner.selectNextExpansion(input);
      this.emit("llm_selection", result.narration, {
        candidates: result.nextCandidates,
        reason: result.reason,
      });
      return result;
    } catch (error) {
      this.emit(
        "error",
        `LLM planner failed: ${error instanceof Error ? error.message : "Unknown"}`
      );
      return this.heuristicSelection(candidates, state);
    }
  }

  /**
   * Heuristic candidate selection when LLM is unavailable
   */
  private heuristicSelection(
    candidates: Candidate[],
    state: InvestigationState
  ): PlannerOutput {
    const failedSet = new Set(
      state.failedCandidates.map((n) => n.toLowerCase())
    );
    const available = candidates.filter(
      (c) => !failedSet.has(c.name.toLowerCase())
    );

    if (available.length === 0) {
      return {
        nextCandidates: [],
        searchQueries: [],
        narration: "No viable candidates remaining.",
        stop: true,
        reason: "All candidates exhausted",
      };
    }

    // Sort by confidence desc, then count desc
    available.sort((a, b) => {
      if (b.bestCoappearConfidence !== a.bestCoappearConfidence) {
        return b.bestCoappearConfidence - a.bestCoappearConfidence;
      }
      return b.coappearCount - a.coappearCount;
    });

    const top = available[0];
    return {
      nextCandidates: [top.name],
      searchQueries: bridgeQueries(top.name, state.personB),
      narration: `Trying ${top.name} (${top.bestCoappearConfidence}% confidence).`,
      stop: false,
      reason: `Heuristic: highest confidence candidate`,
    };
  }

  /**
   * S4: Verify edge between two people
   */
  private async verifyEdge(
    state: InvestigationState,
    person1: string,
    person2: string
  ): Promise<VerifiedEdge | null> {
    this.emit("status", `Verifying connection: ${person1} ↔ ${person2}`);

    const queries = verificationQueries(person1, person2);
    const allEvidence: EvidenceRecord[] = [];

    for (const query of queries) {
      if (this.isBudgetExhausted(state.budgets)) break;

      const evidence = await this.searchAndVerify(state, query, person1, person2);
      allEvidence.push(...evidence);

      // Early exit if we have enough evidence
      if (allEvidence.length >= 3) break;
    }

    if (allEvidence.length === 0) {
      return null;
    }

    return createVerifiedEdge(person1, person2, allEvidence);
  }

  /**
   * S5: Attempt to bridge from candidate to target
   */
  private async attemptBridgeToTarget(
    state: InvestigationState,
    candidate: string
  ): Promise<VerifiedEdge | null> {
    this.emit(
      "status",
      `Checking if ${candidate} connects to ${state.personB}...`
    );

    const queries = bridgeQueries(candidate, state.personB);
    const allEvidence: EvidenceRecord[] = [];

    for (const query of queries) {
      if (this.isBudgetExhausted(state.budgets)) break;

      const evidence = await this.searchAndVerify(
        state,
        query,
        candidate,
        state.personB
      );
      allEvidence.push(...evidence);

      if (allEvidence.length >= 3) break;
    }

    if (allEvidence.length === 0) {
      return null;
    }

    return createVerifiedEdge(candidate, state.personB, allEvidence);
  }

  /**
   * Search for images and verify both people are present
   */
  private async searchAndVerify(
    state: InvestigationState,
    query: string,
    person1: string,
    person2: string
  ): Promise<EvidenceRecord[]> {
    if (state.budgets.searchCallsUsed >= state.budgets.maxSearchCalls) {
      return [];
    }

    state.budgets.searchCallsUsed++;
    const searchResponse = await this.clients.search.searchImages(query);
    const images = searchResponse.results.slice(0, this.config.imagesPerQuery);

    const evidence: EvidenceRecord[] = [];

    for (const imageResult of images) {
      if (
        state.budgets.rekognitionCallsUsed >= state.budgets.maxRekognitionCalls
      ) {
        break;
      }

      try {
        // Visual filter first
        const visualCheck = await this.clients.visualFilter.verifyVisualCopresence(
          imageResult.imageUrl
        );

        if (!visualCheck.isValidScene) {
          continue;
        }

        // Rekognition
        state.budgets.rekognitionCallsUsed++;
        const analysis = await this.clients.celebrityDetection.detectCelebrities(
          imageResult.imageUrl
        );

        // Check if valid evidence
        if (
          isValidEvidence(
            analysis.celebrities,
            person1,
            person2,
            this.config.confidenceThreshold
          )
        ) {
          const record = createEvidenceRecord(
            imageResult,
            analysis,
            person1,
            person2
          );
          if (record) {
            evidence.push(record);
          }
        }
      } catch (error) {
        // Skip failed images
        continue;
      }
    }

    return evidence;
  }

  /**
   * Search for images and analyze for candidates (no specific pair verification)
   */
  private async searchAndAnalyze(
    state: InvestigationState,
    query: string,
    targetPerson: string
  ): Promise<AnalysisWithContext[]> {
    if (state.budgets.searchCallsUsed >= state.budgets.maxSearchCalls) {
      return [];
    }

    state.budgets.searchCallsUsed++;
    const searchResponse = await this.clients.search.searchImages(query);
    const images = searchResponse.results.slice(0, this.config.imagesPerQuery);

    const analyses: AnalysisWithContext[] = [];

    for (const imageResult of images) {
      if (
        state.budgets.rekognitionCallsUsed >= state.budgets.maxRekognitionCalls
      ) {
        break;
      }

      try {
        // Visual filter first
        const visualCheck = await this.clients.visualFilter.verifyVisualCopresence(
          imageResult.imageUrl
        );

        if (!visualCheck.isValidScene) {
          continue;
        }

        // Rekognition
        state.budgets.rekognitionCallsUsed++;
        const analysis = await this.clients.celebrityDetection.detectCelebrities(
          imageResult.imageUrl
        );

        analyses.push({
          analysis,
          contextUrl: imageResult.contextUrl,
        });
      } catch (error) {
        // Skip failed images
        continue;
      }
    }

    return analyses;
  }

  /**
   * Check if any budget is exhausted
   */
  private isBudgetExhausted(budgets: InvestigationBudgets): boolean {
    return (
      budgets.searchCallsUsed >= budgets.maxSearchCalls ||
      budgets.rekognitionCallsUsed >= budgets.maxRekognitionCalls
    );
  }

  /**
   * S6: Finalize with success
   */
  private finalizeSuccess(
    state: InvestigationState,
    directEdge?: VerifiedEdge
  ): InvestigationResult {
    const edges = directEdge ? [directEdge] : state.verifiedEdges;
    const path = directEdge ? [state.personA, state.personB] : state.path;

    const verifiedPath: VerifiedPath = {
      personA: state.personA,
      personB: state.personB,
      path,
      edges,
      confidence: calculatePathConfidence(edges),
    };

    this.emit("status", `Success! Found path with ${path.length - 1} hop(s)`);

    return {
      status: "success",
      result: verifiedPath,
      disclaimer:
        "This result shows visual co-presence in public images, not necessarily a personal relationship.",
    };
  }

  /**
   * S7: Finalize with failure
   */
  private finalizeFailure(state: InvestigationState): InvestigationResult {
    this.emit(
      "status",
      `No verified path found within ${this.config.hopLimit} hops`
    );

    return {
      status: "no_path",
      personA: state.personA,
      personB: state.personB,
      message: `No verified visual connection found within ${this.config.hopLimit} degrees at ≥${this.config.confidenceThreshold}% confidence.`,
    };
  }
}

