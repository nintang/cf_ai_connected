import { WorkflowEntrypoint, WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { Env } from "../env";
import { getTools } from "../tools";
import { WorkersAIPlannerClient } from "@visual-degrees/integrations";
import {
  InvestigationState,
  DEFAULT_BUDGETS,
  DEFAULT_CONFIG,
  Candidate,
  VerifiedEdge,
  PlannerOutput,
  InvestigationResult
} from "@visual-degrees/contracts";
import {
  directQuery,
  discoveryQueries,
  verificationQueries,
  bridgeQueries,
  isValidEvidence,
  createEvidenceRecord,
  createVerifiedEdge,
  aggregateCandidates,
  calculatePathConfidence
} from "@visual-degrees/core";

interface Params {
  personA: string;
  personB: string;
}

export class InvestigationWorkflow extends WorkflowEntrypoint<Env, Params> {
  async run(event: WorkflowEvent<Params>, step: WorkflowStep) {
    const { personA, personB } = event.payload;
    const tools = getTools(this.env);
    
    // Tool wrappers
    const searchImages = tools.find(t => t.name === "search_images")!.function as unknown as (args: { query: string }) => Promise<any>;
    const detectCelebrities = tools.find(t => t.name === "detect_celebrities")!.function as unknown as (args: { imageUrl: string }) => Promise<any>;
    const verifyCopresence = tools.find(t => t.name === "verify_copresence")!.function as unknown as (args: { imageUrl: string }) => Promise<any>;

    // Planner
    const planner = new WorkersAIPlannerClient(this.env.AI as any);

    // Initial State
    let state: InvestigationState & { logs: string[] } = {
      personA,
      personB,
      frontier: personA,
      hopDepth: 0,
      path: [personA],
      verifiedEdges: [],
      failedCandidates: [],
      budgets: { ...DEFAULT_BUDGETS },
      status: "running",
      logs: [],
    };

    const log = (msg: string) => {
      console.log(msg);
      state.logs.push(msg);
    };

    // Helper to check budget
    const checkBudget = () => {
      if (state.budgets.searchCallsUsed >= state.budgets.maxSearchCalls ||
          state.budgets.rekognitionCallsUsed >= state.budgets.maxRekognitionCalls) {
        return false;
      }
      return true;
    };

    // Step 1: Direct Edge Attempt
    const directEdge = await step.do("direct-attempt", async () => {
      const query = directQuery(personA, personB);
      state.budgets.searchCallsUsed++;
      
      try {
        const searchRes = await searchImages({ query });
        const images = searchRes.results.slice(0, DEFAULT_CONFIG.imagesPerQuery);
        const evidence = [];

        for (const img of images) {
          if (!checkBudget()) break;

          try {
            // Visual check
            const visual = await verifyCopresence({ imageUrl: img.imageUrl });
            if (!visual.isValidScene) {
              log(`Visual Reject (${img.imageUrl.slice(0,30)}...): ${visual.reason}`);
              continue;
            }
            log(`Visual Pass (${img.imageUrl.slice(0,30)}...)`);

            // Detect
            state.budgets.rekognitionCallsUsed++;
            const analysis = await detectCelebrities({ imageUrl: img.imageUrl });
            
            if (isValidEvidence(analysis.celebrities, personA, personB, DEFAULT_CONFIG.confidenceThreshold)) {
              const record = createEvidenceRecord(img, analysis, personA, personB);
              if (record) evidence.push(record);
            }
          } catch (imgError) {
            log(`Image Error (${img.imageUrl.slice(0,30)}...): ${imgError instanceof Error ? imgError.message : String(imgError)}`);
            console.warn(`Failed to process image ${img.imageUrl}:`, imgError);
            continue;
          }
        }

        if (evidence.length > 0) {
          return createVerifiedEdge(personA, personB, evidence);
        }
      } catch (e) {
        console.error("Direct attempt failed", e);
      }
      return null;
    });

    if (directEdge) {
      state.verifiedEdges.push(directEdge);
      state.path.push(personB);
      return this.finalizeSuccess(state, directEdge);
    }

    // Expansion Loop
    while (state.status === "running" && state.hopDepth < DEFAULT_CONFIG.hopLimit) {
      if (!checkBudget()) break;

      // Step 2: Discover Candidates
      const candidates = await step.do(`discover-${state.hopDepth}-${state.frontier}`, async () => {
        const queries = discoveryQueries(state.frontier);
        const analyses = [];

        for (const q of queries) {
          if (!checkBudget()) break;
          state.budgets.searchCallsUsed++;
          
          try {
            const searchRes = await searchImages({ query: q });
            const images = searchRes.results.slice(0, DEFAULT_CONFIG.imagesPerQuery);

            for (const img of images) {
              if (!checkBudget()) break;
              
              try {
                const visual = await verifyCopresence({ imageUrl: img.imageUrl });
                if (!visual.isValidScene) continue;

                state.budgets.rekognitionCallsUsed++;
                const analysis = await detectCelebrities({ imageUrl: img.imageUrl });
                analyses.push({ analysis, contextUrl: img.contextUrl });
              } catch (imgError) {
                console.warn(`Failed to process discovery image ${img.imageUrl}:`, imgError);
                continue;
              }
            }
          } catch (e) {
            console.error("Discovery search failed", e);
          }
        }

        return aggregateCandidates(analyses, state.frontier, state.path, DEFAULT_CONFIG.confidenceThreshold);
      });

      if (candidates.length === 0) break;

      // Step 3: Planner Selection
      const plan = await step.do(`plan-${state.hopDepth}`, async () => {
        state.budgets.llmCallsUsed++;
        return await planner.selectNextExpansion({
          personA: state.personA,
          personB: state.personB,
          frontier: state.frontier,
          hopUsed: state.hopDepth,
          hopLimit: DEFAULT_CONFIG.hopLimit,
          confidenceThreshold: DEFAULT_CONFIG.confidenceThreshold,
          budgets: {
            searchCallsRemaining: state.budgets.maxSearchCalls - state.budgets.searchCallsUsed,
            rekognitionCallsRemaining: state.budgets.maxRekognitionCalls - state.budgets.rekognitionCallsUsed,
            llmCallsRemaining: state.budgets.maxLLMCalls - state.budgets.llmCallsUsed
          },
          verifiedEdges: state.verifiedEdges.map(e => ({ from: e.from, to: e.to, confidence: e.edgeConfidence })),
          failedCandidates: state.failedCandidates,
          candidates
        });
      });

      if (plan.stop || plan.nextCandidates.length === 0) break;

      let foundNext = false;

      // Try candidates
      for (const candidateName of plan.nextCandidates) {
        // Step 4: Verify Edge to Candidate
        const edgeToCandidate = await step.do(`verify-${state.hopDepth}-${candidateName}`, async () => {
          const queries = verificationQueries(state.frontier, candidateName);
          const evidence = [];

          for (const q of queries) {
            if (!checkBudget()) break;
            state.budgets.searchCallsUsed++;
            
            try {
              const searchRes = await searchImages({ query: q });
              const images = searchRes.results.slice(0, DEFAULT_CONFIG.imagesPerQuery);

              for (const img of images) {
                if (!checkBudget()) break;
                
                try {
                  const visual = await verifyCopresence({ imageUrl: img.imageUrl });
                  if (!visual.isValidScene) continue;

                  state.budgets.rekognitionCallsUsed++;
                  const analysis = await detectCelebrities({ imageUrl: img.imageUrl });
                  
                  if (isValidEvidence(analysis.celebrities, state.frontier, candidateName, DEFAULT_CONFIG.confidenceThreshold)) {
                    const record = createEvidenceRecord(img, analysis, state.frontier, candidateName);
                    if (record) evidence.push(record);
                  }
                } catch (imgError) {
                  continue;
                }
              }
            } catch (e) { continue; }
            
            if (evidence.length >= 3) break;
          }

          if (evidence.length > 0) {
            return createVerifiedEdge(state.frontier, candidateName, evidence);
          }
          return null;
        });

        if (!edgeToCandidate) {
          state.failedCandidates.push(candidateName);
          continue;
        }

        // Edge verified
        state.verifiedEdges.push(edgeToCandidate);
        state.path.push(candidateName);
        state.hopDepth++;

        // Step 5: Bridge to Target
        const bridgeEdge = await step.do(`bridge-${state.hopDepth}-${candidateName}`, async () => {
           const queries = bridgeQueries(candidateName, personB);
           const evidence = [];
           // ... similar verification logic ...
           for (const q of queries) {
             if (!checkBudget()) break;
             state.budgets.searchCallsUsed++;
             try {
                const searchRes = await searchImages({ query: q });
                // ... process images ...
                const images = searchRes.results.slice(0, DEFAULT_CONFIG.imagesPerQuery);
                for (const img of images) {
                    if (!checkBudget()) break;
                    try {
                        const visual = await verifyCopresence({ imageUrl: img.imageUrl });
                        if (!visual.isValidScene) continue;
                        state.budgets.rekognitionCallsUsed++;
                        const analysis = await detectCelebrities({ imageUrl: img.imageUrl });
                        if (isValidEvidence(analysis.celebrities, candidateName, personB, DEFAULT_CONFIG.confidenceThreshold)) {
                            const record = createEvidenceRecord(img, analysis, candidateName, personB);
                            if (record) evidence.push(record);
                        }
                    } catch(e) { continue; }
                }
             } catch(e) { continue; }
             if (evidence.length >= 3) break;
           }
           if (evidence.length > 0) return createVerifiedEdge(candidateName, personB, evidence);
           return null;
        });

        if (bridgeEdge) {
          state.verifiedEdges.push(bridgeEdge);
          state.path.push(personB);
          return this.finalizeSuccess(state);
        }

        // Continue expansion from new frontier
        state.frontier = candidateName;
        state.failedCandidates = [];
        foundNext = true;
        break;
      }

      if (!foundNext) {
        // All candidates failed
        if (state.failedCandidates.length === plan.nextCandidates.length) {
            // If we tried all planned candidates and failed, loop will continue to Planner again?
            // Or break?
            // For simplicity, if planner fails to progress, we break to avoid infinite loops if it keeps suggesting same candidates (though failedCandidates list prevents that).
            // But let's verify if we should loop back to planner.
            // The logic: if foundNext is false, we go to next iteration of while loop.
            // `failedCandidates` has grown.
            // If candidates list is exhausted, `discoverCandidates` might return same list but planner will see `failedCandidates`.
            // So looping is okay.
        } else {
             // We didn't try all candidates? (maybe budget?)
             break;
        }
      }
    }

    return this.finalizeFailure(state);
  }

  private finalizeSuccess(state: InvestigationState, directEdge?: VerifiedEdge): InvestigationResult {
    const edges = directEdge ? [directEdge] : state.verifiedEdges;
    const path = directEdge ? [state.personA, state.personB] : state.path;

    return {
      status: "success",
      result: {
        personA: state.personA,
        personB: state.personB,
        path,
        edges,
        confidence: calculatePathConfidence(edges),
      },
      disclaimer: "This result shows visual co-presence in public images, not necessarily a personal relationship."
    };
  }

  private finalizeFailure(state: InvestigationState & { logs: string[] }): InvestigationResult & { debug?: any } {
    return {
      status: "no_path",
      personA: state.personA,
      personB: state.personB,
      message: `No verified visual connection found within ${DEFAULT_CONFIG.hopLimit} degrees at ≥${DEFAULT_CONFIG.confidenceThreshold}% confidence.`,
      // @ts-ignore - Adding debug info not in strict contract yet
      debug: {
        hopsReached: state.hopDepth,
        failedCandidates: state.failedCandidates,
        budgets: state.budgets,
        pathSoFar: state.path,
        logs: state.logs.slice(-20), // Last 20 logs
      }
    };
  }
}

