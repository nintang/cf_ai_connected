import { WorkflowEntrypoint, WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { Env } from "../env";
import { getTools } from "../tools";
import { WorkersAIPlannerClient, OpenRouterClient } from "@visual-degrees/integrations";
import {
  InvestigationState,
  DEFAULT_BUDGETS,
  DEFAULT_CONFIG,
  Candidate,
  VerifiedEdge,
  InvestigationResult,
  InvestigationEvent,
  InvestigationEventType,
  InvestigationStepId,
  StepStatus,
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
  runId: string;
}

/**
 * Step definitions for clear UI progression
 */
const STEP_DEFINITIONS: Record<InvestigationStepId, { number: number; title: string }> = {
  direct_check: { number: 1, title: "Checking for direct connection" },
  find_bridges: { number: 2, title: "Finding bridge candidates" },
  verify_bridge: { number: 3, title: "Verifying bridge connection" },
  connect_target: { number: 4, title: "Connecting to target" },
};

/**
 * Creates an event emitter that stores events in KV
 */
function createEventEmitter(kv: KVNamespace, runId: string) {
  let eventIndex = 0;
  let currentStepNumber = 0;

  const emitRaw = async (
    type: InvestigationEventType,
    message: string,
    data?: InvestigationEvent["data"]
  ): Promise<void> => {
    // Create unique event ID using sequential index
    const eventId = `${runId}:${String(eventIndex).padStart(6, "0")}`;

    const event: InvestigationEvent = {
      type,
      runId,
      timestamp: new Date().toISOString(),
      message,
      data: {
        ...data,
        eventId, // Unique ID for frontend deduplication
      },
    };

    // Store event with sequential key for ordering
    const key = eventId;
    eventIndex++;

    await kv.put(key, JSON.stringify(event), {
      // Expire after 1 hour to clean up
      expirationTtl: 3600,
    });

    // Also update the event count for easy retrieval
    await kv.put(`${runId}:count`, String(eventIndex), {
      expirationTtl: 3600,
    });

    console.log(`[${type}] ${message}`);
  };

  return {
    emit: emitRaw,

    // Start a new step
    startStep: async (
      stepId: InvestigationStepId,
      customTitle?: string,
      extraData?: Partial<InvestigationEvent["data"]>
    ) => {
      const def = STEP_DEFINITIONS[stepId];
      currentStepNumber = def.number;
      await emitRaw("step_start", customTitle || def.title, {
        stepId,
        stepNumber: def.number,
        stepTitle: customTitle || def.title,
        stepStatus: "running",
        ...extraData,
      });
    },

    // Update current step progress
    updateStep: async (message: string, extraData?: Partial<InvestigationEvent["data"]>) => {
      await emitRaw("step_update", message, {
        stepNumber: currentStepNumber,
        ...extraData,
      });
    },

    // Complete current step
    completeStep: async (
      stepId: InvestigationStepId,
      success: boolean,
      message: string,
      extraData?: Partial<InvestigationEvent["data"]>
    ) => {
      const def = STEP_DEFINITIONS[stepId];
      await emitRaw("step_complete", message, {
        stepId,
        stepNumber: def.number,
        stepStatus: success ? "done" : "failed",
        ...extraData,
      });
    },
  };
}

export class InvestigationWorkflow extends WorkflowEntrypoint<Env, Params> {
  async run(event: WorkflowEvent<Params>, step: WorkflowStep) {
    const { personA, personB, runId } = event.payload;
    const tools = getTools(this.env);

    // Create event emitter with step helpers
    const { emit, startStep, updateStep, completeStep } = createEventEmitter(this.env.INVESTIGATION_EVENTS, runId);

    // Tool wrappers
    const searchImages = tools.find(t => t.name === "search_images")!.function as unknown as (args: { query: string }) => Promise<any>;
    const detectCelebrities = tools.find(t => t.name === "detect_celebrities")!.function as unknown as (args: { imageUrl: string }) => Promise<any>;
    const verifyCopresence = tools.find(t => t.name === "verify_copresence")!.function as unknown as (args: { imageUrl: string }) => Promise<any>;
    const verifyCelebritiesAI = tools.find(t => t.name === "verify_celebrities_ai")!.function as unknown as (args: { imageUrl: string; personA: string; personB: string }) => Promise<{
      personAFound: boolean;
      personAConfidence: number;
      personBFound: boolean;
      personBConfidence: number;
      togetherInScene: boolean;
      overallConfidence: number;
      notes: string;
    }>;

    // Planner - use OpenRouter (Gemini 3 Flash) if available, otherwise Workers AI
    const planner = this.env.OPENROUTER_API_KEY
      ? new OpenRouterClient({
          apiKey: this.env.OPENROUTER_API_KEY,
          model: "google/gemini-2.0-flash-001",
        })
      : new WorkersAIPlannerClient(this.env.AI as any);

    // Initial State (must be initialized before using state.budgets)
    let state: InvestigationState = {
      personA,
      personB,
      frontier: personA,
      hopDepth: 0,
      path: [personA],
      verifiedEdges: [],
      failedCandidates: [],
      budgets: { ...DEFAULT_BUDGETS },
      status: "running",
    };

    // Helper to check budget
    const checkBudget = () => {
      if (state.budgets.searchCallsUsed >= state.budgets.maxSearchCalls ||
          state.budgets.rekognitionCallsUsed >= state.budgets.maxRekognitionCalls) {
        return false;
      }
      return true;
    };

    // Emit initial status
    await emit("status", `Starting investigation: ${personA} → ${personB}`, {
      hop: 0,
      frontier: personA,
      budget: state.budgets,
    });

    // ========================================================================
    // STEP 1: Direct Connection Check
    // ========================================================================
    await startStep("direct_check", `Checking for direct connection: ${personA} ↔ ${personB}`, {
      fromPerson: personA,
      toPerson: personB,
    });

    await updateStep(`Searching for "${personA} ${personB}" images...`, {
      query: directQuery(personA, personB),
    });

    const directEdge = await step.do("direct-attempt", async () => {
      const query = directQuery(personA, personB);
      state.budgets.searchCallsUsed++;
      
      try {
        const searchRes = await searchImages({ query });
        const images = searchRes.results.slice(0, DEFAULT_CONFIG.imagesPerQuery);
        const evidence = [];
        let imageIndex = 0;

        for (const img of images) {
          imageIndex++;
          if (!checkBudget()) break;

          try {
            // Visual check
            const visual = await verifyCopresence({ imageUrl: img.imageUrl });
            if (!visual.isValidScene) {
              await emit("image_result", `[${imageIndex}/${images.length}] Collage - ${visual.reason}`, {
                imageIndex,
                totalImages: images.length,
                imageUrl: img.thumbnailUrl,
                status: "collage",
                reason: visual.reason,
              });
              continue;
            }

            // Detect celebrities with Rekognition
            state.budgets.rekognitionCallsUsed++;
            const analysis = await detectCelebrities({ imageUrl: img.imageUrl });

            if (isValidEvidence(analysis.celebrities, personA, personB, DEFAULT_CONFIG.confidenceThreshold)) {
              const record = createEvidenceRecord(img, analysis, personA, personB);
              if (record) {
                evidence.push(record);
                const celebs = analysis.celebrities.map((c: any) => ({ name: c.name, confidence: Math.round(c.confidence) }));
                await emit("image_result", `[${imageIndex}/${images.length}] ✓ Evidence - ${personA} & ${personB}`, {
                  imageIndex,
                  totalImages: images.length,
                  imageUrl: img.thumbnailUrl,
                  status: "evidence",
                  celebrities: celebs,
                });
              }
            } else {
              // Rekognition didn't find a match - try AI verification as fallback
              const celebs = analysis.celebrities.map((c: any) => ({ name: c.name, confidence: Math.round(c.confidence) }));

              // Try AI verification (with error handling - don't fail if AI is unavailable)
              try {
                const aiVerification = await verifyCelebritiesAI({ imageUrl: img.imageUrl, personA, personB });

                if (aiVerification.togetherInScene && aiVerification.overallConfidence >= DEFAULT_CONFIG.confidenceThreshold) {
                  // AI found both people - create evidence record
                  const aiRecord = {
                    from: personA,
                    to: personB,
                    imageUrl: img.imageUrl,
                    thumbnailUrl: img.thumbnailUrl,
                    contextUrl: img.contextUrl,
                    title: img.title,
                    detectedCelebs: [
                      { name: personA, confidence: aiVerification.personAConfidence },
                      { name: personB, confidence: aiVerification.personBConfidence },
                    ],
                    imageScore: aiVerification.overallConfidence,
                  };
                  evidence.push(aiRecord);
                  await emit("image_result", `[${imageIndex}/${images.length}] ✓ AI Evidence - ${personA} & ${personB}`, {
                    imageIndex,
                    totalImages: images.length,
                    imageUrl: img.thumbnailUrl,
                    status: "evidence",
                    celebrities: [
                      { name: personA, confidence: aiVerification.personAConfidence },
                      { name: personB, confidence: aiVerification.personBConfidence },
                    ],
                    aiVerified: true,
                    aiNotes: aiVerification.notes,
                  });
                } else {
                  await emit("image_result", `[${imageIndex}/${images.length}] No target match`, {
                    imageIndex,
                    totalImages: images.length,
                    imageUrl: img.thumbnailUrl,
                    status: "no_match",
                    celebrities: celebs,
                  });
                }
              } catch (aiError) {
                // AI verification failed - just report no match (don't fail the whole process)
                await emit("image_result", `[${imageIndex}/${images.length}] No target match`, {
                  imageIndex,
                  totalImages: images.length,
                  imageUrl: img.thumbnailUrl,
                  status: "no_match",
                  celebrities: celebs,
                });
              }
            }
          } catch (imgError) {
            await emit("image_result", `[${imageIndex}/${images.length}] Error - ${imgError instanceof Error ? imgError.message : 'Unknown'}`, {
              imageIndex,
              totalImages: images.length,
              imageUrl: img.thumbnailUrl,
              status: "error",
              reason: imgError instanceof Error ? imgError.message : String(imgError),
            });
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
      // Direct connection found!
      state.verifiedEdges.push(directEdge);
      state.path.push(personB);

      await emit("evidence", `Found direct evidence: ${personA} ↔ ${personB}`, {
        edge: {
          from: personA,
          to: personB,
          confidence: directEdge.edgeConfidence,
          thumbnailUrl: directEdge.bestEvidence.thumbnailUrl,
          contextUrl: directEdge.bestEvidence.contextUrl,
        },
      });

      await completeStep("direct_check", true, `Direct connection verified with ${directEdge.edgeConfidence}% confidence!`);

      await emit("path_update", `Path complete: ${state.path.join(" → ")}`, {
        path: state.path,
        hopDepth: 0,
      });

      const result = this.finalizeSuccess(state, directEdge);
      await emit("final", `Investigation complete! Found direct connection with ${directEdge.edgeConfidence}% confidence.`, {
        result: result.status === "success" ? result.result : undefined,
      });

      return result;
    }

    // No direct connection - complete step 1 and move to step 2
    await completeStep("direct_check", false, "No direct visual evidence found");

    // ========================================================================
    // STEP 2: Finding Bridge Candidates
    // ========================================================================
    await startStep("find_bridges", `Finding bridge candidates from ${personA}`, {
      fromPerson: personA,
    });

    // Get LLM suggestions for bridge candidates
    const suggestedBridges = await step.do("suggest-bridges", async () => {
      state.budgets.llmCallsUsed++;
      return await planner.suggestBridgeCandidates(personA, personB);
    });

    if (suggestedBridges.length > 0) {
      await updateStep(`AI suggested ${suggestedBridges.length} bridge candidates`, {
        candidates: suggestedBridges.map((c) => ({
          name: c.name,
          score: c.confidence,
          reasoning: c.reasoning,
        })),
      });
    }

    // DFS Stack Frame type
    interface DFSStackFrame {
      frontier: string;
      candidates: string[];
      candidateIndex: number;
      edge: VerifiedEdge | null;
    }

    // DFS State
    const dfsStack: DFSStackFrame[] = [];
    const globalTriedCandidates = new Set<string>([personA.toLowerCase()]);
    let currentFrontier = personA;

    // Track remaining candidates to try at current level (set by backtrack)
    let pendingCandidatesToTry: string[] = [];
    let skipDiscovery = false;

    // Backtrack helper - returns true if we found more candidates to try
    const backtrack = async (): Promise<boolean> => {
      while (dfsStack.length > 0) {
        const poppedFrame = dfsStack.pop()!;
        const poppedCandidate = poppedFrame.candidates[poppedFrame.candidateIndex];

        // Restore state
        state.path.pop();
        state.verifiedEdges.pop();
        state.hopDepth = dfsStack.length;

        // Determine new frontier
        if (dfsStack.length === 0) {
          state.frontier = personA;
        } else {
          const prevFrame = dfsStack[dfsStack.length - 1];
          state.frontier = prevFrame.candidates[prevFrame.candidateIndex];
        }

        await emit("backtrack", `Backtracking from ${poppedCandidate} to ${state.frontier}`, {
          from: poppedCandidate,
          to: state.frontier,
          remainingDepth: dfsStack.length,
        });

        await emit("path_update", `Path: ${state.path.join(" → ")}`, {
          path: state.path,
          hopDepth: state.hopDepth,
        });

        // Check if there are more candidates to try at the popped level
        const remainingCandidates = poppedFrame.candidates.slice(poppedFrame.candidateIndex + 1);
        const untriedCandidates = remainingCandidates.filter(
          name => !globalTriedCandidates.has(name.toLowerCase())
        );

        if (untriedCandidates.length > 0) {
          // There are more candidates at this level to try - skip discovery
          pendingCandidatesToTry = untriedCandidates;
          skipDiscovery = true;
          await emit("thinking", `Found ${untriedCandidates.length} more candidate(s) to try at this level: ${untriedCandidates.slice(0, 3).join(", ")}...`);
          return true;
        }
        // No more candidates at this level, continue backtracking
      }

      await emit("thinking", "Search exhausted - no more paths to explore");
      return false;
    };

    // Main DFS Loop
    while (state.status === "running") {
      if (!checkBudget()) {
        await emit("status", "Budget exhausted, stopping search", {
          budget: state.budgets,
        });
        break;
      }

      // Check hop limit
      if (dfsStack.length >= DEFAULT_CONFIG.hopLimit) {
        await emit("thinking", `Reached hop limit (${DEFAULT_CONFIG.hopLimit}), backtracking...`);
        if (!await backtrack()) break;
        currentFrontier = state.frontier;
        continue;
      }

      // Step 2: Discover Candidates
      await emit("research", `Discovering candidates connected to ${currentFrontier}`, {
        query: `${currentFrontier} celebrity photos`,
      });

      const candidates = await step.do(`discover-${dfsStack.length}-${currentFrontier}`, async () => {
        const queries = discoveryQueries(currentFrontier);
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

        return aggregateCandidates(analyses, currentFrontier, state.path, DEFAULT_CONFIG.confidenceThreshold);
      });

      // Merge LLM-suggested bridges (only at first level)
      const mergedCandidates = dfsStack.length === 0 ? [
        ...candidates,
        ...suggestedBridges
          .filter(
            (s) =>
              !candidates.some(
                (c) => c.name.toLowerCase() === s.name.toLowerCase()
              )
          )
          .map((s) => ({
            name: s.name,
            coappearCount: 1,
            bestCoappearConfidence: 90,
            evidenceContextUrls: [],
          })),
      ] : candidates;

      // Filter out already tried candidates
      let availableCandidates = mergedCandidates.filter(
        c => !globalTriedCandidates.has(c.name.toLowerCase())
      );

      // If no candidates available, ask LLM for more suggestions
      if (availableCandidates.length === 0 && checkBudget()) {
        await emit("thinking", `All candidates exhausted for ${currentFrontier}. Asking AI for more suggestions...`);

        const excludeList = Array.from(globalTriedCandidates);
        const additionalBridges = await step.do(`additional-bridges-${dfsStack.length}-${currentFrontier}`, async () => {
          state.budgets.llmCallsUsed++;
          // Ask for suggestions excluding already tried candidates
          return await planner.suggestBridgeCandidates(currentFrontier, personB, excludeList);
        });

        // Filter out already tried from new suggestions
        const newCandidates = additionalBridges.filter(
          (s) => !globalTriedCandidates.has(s.name.toLowerCase())
        );

        if (newCandidates.length > 0) {
          await updateStep(`AI suggested ${newCandidates.length} additional bridge candidates`, {
            candidates: newCandidates.map((c) => ({
              name: c.name,
              score: c.confidence,
              reasoning: c.reasoning,
            })),
          });

          // Add new candidates to available list
          availableCandidates = newCandidates.map((s) => ({
            name: s.name,
            coappearCount: 1,
            bestCoappearConfidence: s.confidence,
            evidenceContextUrls: [],
          }));
        }
      }

      if (availableCandidates.length === 0) {
        await emit("thinking", `No viable candidates found for ${currentFrontier}. Backtracking...`);
        if (!await backtrack()) break;
        currentFrontier = state.frontier;
        continue;
      }

      await updateStep(`Found ${availableCandidates.length} potential bridge candidates`, {
        candidates: availableCandidates.slice(0, 5).map(c => ({ name: c.name })),
      });

      // LLM Selection - still part of find_bridges step
      await updateStep(`Analyzing candidates to find best path to ${personB}...`);

      const plan = await step.do(`plan-${dfsStack.length}-${currentFrontier}`, async () => {
        state.budgets.llmCallsUsed++;
        return await planner.selectNextExpansion({
          personA: state.personA,
          personB: state.personB,
          frontier: currentFrontier,
          hopUsed: dfsStack.length,
          hopLimit: DEFAULT_CONFIG.hopLimit,
          confidenceThreshold: DEFAULT_CONFIG.confidenceThreshold,
          budgets: {
            searchCallsRemaining: state.budgets.maxSearchCalls - state.budgets.searchCallsUsed,
            rekognitionCallsRemaining: state.budgets.maxRekognitionCalls - state.budgets.rekognitionCallsUsed,
            llmCallsRemaining: state.budgets.maxLLMCalls - state.budgets.llmCallsUsed
          },
          verifiedEdges: state.verifiedEdges.map(e => ({ from: e.from, to: e.to, confidence: e.edgeConfidence })),
          failedCandidates: state.failedCandidates,
          candidates: availableCandidates,
        });
      });

      await updateStep(`Selected: ${plan.nextCandidates.join(", ")}`, {
        candidates: plan.nextCandidates.map(name => ({ name })),
        reasoning: plan.reason,
      });

      if (plan.stop || plan.nextCandidates.length === 0) {
        await completeStep("find_bridges", false, plan.reason || "No viable candidates found");
        if (!await backtrack()) break;
        currentFrontier = state.frontier;
        continue;
      }

      // Filter candidates to those not yet tried
      const candidatesToTry = plan.nextCandidates.filter(
        name => !globalTriedCandidates.has(name.toLowerCase())
      );

      if (candidatesToTry.length === 0) {
        await completeStep("find_bridges", false, "All candidates already explored");
        if (!await backtrack()) break;
        currentFrontier = state.frontier;
        continue;
      }

      // Complete find_bridges step - we have candidates to try
      await completeStep("find_bridges", true, `Will try: ${candidatesToTry.slice(0, 3).join(", ")}`);

      // Try candidates one by one (DFS style)
      let foundValidEdge = false;

      for (let i = 0; i < candidatesToTry.length; i++) {
        const candidateName = candidatesToTry[i];

        // Mark as globally tried
        globalTriedCandidates.add(candidateName.toLowerCase());

        // ========================================================================
        // STEP 3: Verify Bridge Connection
        // ========================================================================
        await startStep("verify_bridge", `Verifying: ${currentFrontier} ↔ ${candidateName}`, {
          fromPerson: currentFrontier,
          toPerson: candidateName,
        });

        // Step 4: Verify Edge to Candidate
        await updateStep(`Searching for "${currentFrontier} ${candidateName}" images...`, {
          query: `${currentFrontier} ${candidateName}`,
        });

        const edgeToCandidate = await step.do(`verify-${dfsStack.length}-${candidateName}`, async () => {
          const queries = verificationQueries(currentFrontier, candidateName);
          const evidence = [];
          let totalImagesProcessed = 0;

          for (const q of queries) {
            if (!checkBudget()) break;
            state.budgets.searchCallsUsed++;

            try {
              const searchRes = await searchImages({ query: q });
              const images = searchRes.results.slice(0, DEFAULT_CONFIG.imagesPerQuery);
              const totalImages = images.length;

              for (const img of images) {
                if (!checkBudget()) break;
                totalImagesProcessed++;

                try {
                  const visual = await verifyCopresence({ imageUrl: img.imageUrl });
                  if (!visual.isValidScene) {
                    await emit("image_result", `[${totalImagesProcessed}/${totalImages}] Collage - ${visual.reason}`, {
                      imageIndex: totalImagesProcessed,
                      totalImages,
                      imageUrl: img.thumbnailUrl,
                      status: "collage",
                      reason: visual.reason,
                    });
                    continue;
                  }

                  state.budgets.rekognitionCallsUsed++;
                  const analysis = await detectCelebrities({ imageUrl: img.imageUrl });

                  if (isValidEvidence(analysis.celebrities, currentFrontier, candidateName, DEFAULT_CONFIG.confidenceThreshold)) {
                    const record = createEvidenceRecord(img, analysis, currentFrontier, candidateName);
                    if (record) {
                      evidence.push(record);
                      const celebs = analysis.celebrities.map((c: any) => ({ name: c.name, confidence: Math.round(c.confidence) }));
                      await emit("image_result", `[${totalImagesProcessed}/${totalImages}] ✓ Evidence - ${currentFrontier} & ${candidateName}`, {
                        imageIndex: totalImagesProcessed,
                        totalImages,
                        imageUrl: img.thumbnailUrl,
                        status: "evidence",
                        celebrities: celebs,
                      });
                    }
                  } else {
                    // AI fallback for verify_bridge
                    const celebs = analysis.celebrities.map((c: any) => ({ name: c.name, confidence: Math.round(c.confidence) }));

                    try {
                      const aiVerification = await verifyCelebritiesAI({ imageUrl: img.imageUrl, personA: currentFrontier, personB: candidateName });

                      if (aiVerification.togetherInScene && aiVerification.overallConfidence >= DEFAULT_CONFIG.confidenceThreshold) {
                        const aiRecord = {
                          from: currentFrontier,
                          to: candidateName,
                          imageUrl: img.imageUrl,
                          thumbnailUrl: img.thumbnailUrl,
                          contextUrl: img.contextUrl,
                          title: img.title,
                          detectedCelebs: [
                            { name: currentFrontier, confidence: aiVerification.personAConfidence },
                            { name: candidateName, confidence: aiVerification.personBConfidence },
                          ],
                          imageScore: aiVerification.overallConfidence,
                        };
                        evidence.push(aiRecord);
                        await emit("image_result", `[${totalImagesProcessed}/${totalImages}] ✓ AI Evidence - ${currentFrontier} & ${candidateName}`, {
                          imageIndex: totalImagesProcessed,
                          totalImages,
                          imageUrl: img.thumbnailUrl,
                          status: "evidence",
                          celebrities: [
                            { name: currentFrontier, confidence: aiVerification.personAConfidence },
                            { name: candidateName, confidence: aiVerification.personBConfidence },
                          ],
                          aiVerified: true,
                        });
                      } else {
                        await emit("image_result", `[${totalImagesProcessed}/${totalImages}] No target match`, {
                          imageIndex: totalImagesProcessed,
                          totalImages,
                          imageUrl: img.thumbnailUrl,
                          status: "no_match",
                          celebrities: celebs,
                        });
                      }
                    } catch (aiError) {
                      await emit("image_result", `[${totalImagesProcessed}/${totalImages}] No target match`, {
                        imageIndex: totalImagesProcessed,
                        totalImages,
                        imageUrl: img.thumbnailUrl,
                        status: "no_match",
                        celebrities: celebs,
                      });
                    }
                  }
                } catch (imgError) {
                  await emit("image_result", `[${totalImagesProcessed}/${totalImages}] Error - ${imgError instanceof Error ? imgError.message : 'Unknown'}`, {
                    imageIndex: totalImagesProcessed,
                    totalImages,
                    imageUrl: img.thumbnailUrl,
                    status: "error",
                    reason: imgError instanceof Error ? imgError.message : String(imgError),
                  });
                  continue;
                }
              }
            } catch (e) { continue; }

            if (evidence.length >= 3) break;
          }

          if (evidence.length > 0) {
            return createVerifiedEdge(currentFrontier, candidateName, evidence);
          }
          return null;
        });

        if (!edgeToCandidate) {
          state.failedCandidates.push(candidateName);
          await completeStep("verify_bridge", false, `Could not verify ${currentFrontier} ↔ ${candidateName}`);
          continue;
        }

        // Edge verified! Push to DFS stack
        const frame: DFSStackFrame = {
          frontier: currentFrontier,
          candidates: candidatesToTry,
          candidateIndex: i,
          edge: edgeToCandidate,
        };
        dfsStack.push(frame);

        // Update state
        state.verifiedEdges.push(edgeToCandidate);
        state.path.push(candidateName);
        state.hopDepth = dfsStack.length;
        state.frontier = candidateName;

        await emit("evidence", `Verified: ${currentFrontier} ↔ ${candidateName}`, {
          edge: {
            from: currentFrontier,
            to: candidateName,
            confidence: edgeToCandidate.edgeConfidence,
            thumbnailUrl: edgeToCandidate.bestEvidence.thumbnailUrl,
            contextUrl: edgeToCandidate.bestEvidence.contextUrl,
          },
        });

        await completeStep("verify_bridge", true, `Connection verified with ${edgeToCandidate.edgeConfidence}% confidence`);

        await emit("path_update", `Path updated: ${state.path.join(" → ")}`, {
          path: state.path,
          hopDepth: state.hopDepth,
        });

        // ========================================================================
        // STEP 4: Connect to Target
        // ========================================================================
        await startStep("connect_target", `Connecting: ${candidateName} ↔ ${personB}`, {
          fromPerson: candidateName,
          toPerson: personB,
        });

        await updateStep(`Searching for "${candidateName} ${personB}" images...`, {
          query: `${candidateName} ${personB}`,
        });

        const bridgeEdge = await step.do(`bridge-${dfsStack.length}-${candidateName}`, async () => {
          const queries = bridgeQueries(candidateName, personB);
          const evidence = [];
          let totalImagesProcessed = 0;

          for (const q of queries) {
            if (!checkBudget()) break;
            state.budgets.searchCallsUsed++;
            try {
              const searchRes = await searchImages({ query: q });
              const images = searchRes.results.slice(0, DEFAULT_CONFIG.imagesPerQuery);
              const totalImages = images.length;

              for (const img of images) {
                if (!checkBudget()) break;
                totalImagesProcessed++;

                try {
                  const visual = await verifyCopresence({ imageUrl: img.imageUrl });
                  if (!visual.isValidScene) {
                    await emit("image_result", `[${totalImagesProcessed}/${totalImages}] Collage - ${visual.reason}`, {
                      imageIndex: totalImagesProcessed,
                      totalImages,
                      imageUrl: img.thumbnailUrl,
                      status: "collage",
                      reason: visual.reason,
                    });
                    continue;
                  }

                  state.budgets.rekognitionCallsUsed++;
                  const analysis = await detectCelebrities({ imageUrl: img.imageUrl });

                  if (isValidEvidence(analysis.celebrities, candidateName, personB, DEFAULT_CONFIG.confidenceThreshold)) {
                    const record = createEvidenceRecord(img, analysis, candidateName, personB);
                    if (record) {
                      evidence.push(record);
                      const celebs = analysis.celebrities.map((c: any) => ({ name: c.name, confidence: Math.round(c.confidence) }));
                      await emit("image_result", `[${totalImagesProcessed}/${totalImages}] ✓ Evidence - ${candidateName} & ${personB}`, {
                        imageIndex: totalImagesProcessed,
                        totalImages,
                        imageUrl: img.thumbnailUrl,
                        status: "evidence",
                        celebrities: celebs,
                      });
                    }
                  } else {
                    // AI fallback for connect_target
                    const celebs = analysis.celebrities.map((c: any) => ({ name: c.name, confidence: Math.round(c.confidence) }));

                    try {
                      const aiVerification = await verifyCelebritiesAI({ imageUrl: img.imageUrl, personA: candidateName, personB });

                      if (aiVerification.togetherInScene && aiVerification.overallConfidence >= DEFAULT_CONFIG.confidenceThreshold) {
                        const aiRecord = {
                          from: candidateName,
                          to: personB,
                          imageUrl: img.imageUrl,
                          thumbnailUrl: img.thumbnailUrl,
                          contextUrl: img.contextUrl,
                          title: img.title,
                          detectedCelebs: [
                            { name: candidateName, confidence: aiVerification.personAConfidence },
                            { name: personB, confidence: aiVerification.personBConfidence },
                          ],
                          imageScore: aiVerification.overallConfidence,
                        };
                        evidence.push(aiRecord);
                        await emit("image_result", `[${totalImagesProcessed}/${totalImages}] ✓ AI Evidence - ${candidateName} & ${personB}`, {
                          imageIndex: totalImagesProcessed,
                          totalImages,
                          imageUrl: img.thumbnailUrl,
                          status: "evidence",
                          celebrities: [
                            { name: candidateName, confidence: aiVerification.personAConfidence },
                            { name: personB, confidence: aiVerification.personBConfidence },
                          ],
                          aiVerified: true,
                        });
                      } else {
                        await emit("image_result", `[${totalImagesProcessed}/${totalImages}] No target match`, {
                          imageIndex: totalImagesProcessed,
                          totalImages,
                          imageUrl: img.thumbnailUrl,
                          status: "no_match",
                          celebrities: celebs,
                        });
                      }
                    } catch (aiError) {
                      await emit("image_result", `[${totalImagesProcessed}/${totalImages}] No target match`, {
                        imageIndex: totalImagesProcessed,
                        totalImages,
                        imageUrl: img.thumbnailUrl,
                        status: "no_match",
                        celebrities: celebs,
                      });
                    }
                  }
                } catch (imgError) {
                  await emit("image_result", `[${totalImagesProcessed}/${totalImages}] Error - ${imgError instanceof Error ? imgError.message : 'Unknown'}`, {
                    imageIndex: totalImagesProcessed,
                    totalImages,
                    imageUrl: img.thumbnailUrl,
                    status: "error",
                    reason: imgError instanceof Error ? imgError.message : String(imgError),
                  });
                  continue;
                }
              }
            } catch (e) { continue; }
            if (evidence.length >= 3) break;
          }
          if (evidence.length > 0) return createVerifiedEdge(candidateName, personB, evidence);
          return null;
        });

        if (bridgeEdge) {
          // SUCCESS! Found complete path to target
          state.verifiedEdges.push(bridgeEdge);
          state.path.push(personB);

          await emit("evidence", `Verified final hop: ${candidateName} ↔ ${personB}`, {
            edge: {
              from: candidateName,
              to: personB,
              confidence: bridgeEdge.edgeConfidence,
              thumbnailUrl: bridgeEdge.bestEvidence.thumbnailUrl,
              contextUrl: bridgeEdge.bestEvidence.contextUrl,
            },
          });

          await completeStep("connect_target", true, `Connection to ${personB} verified!`);

          await emit("path_update", `Path complete: ${state.path.join(" → ")}`, {
            path: state.path,
            hopDepth: state.hopDepth + 1,
          });

          const result = this.finalizeSuccess(state);
          const confidence = calculatePathConfidence(state.verifiedEdges);
          await emit("final", `Investigation complete! Found ${state.path.length - 1}-hop connection with ${confidence.pathBottleneck}% confidence.`, {
            result: result.status === "success" ? result.result : undefined,
          });

          return result;
        }

        // Could not connect to target from this bridge - continue searching
        await completeStep("connect_target", false, `No direct connection to ${personB}. Continuing search...`);

        // Continue DFS from this new candidate - restart find_bridges step
        await startStep("find_bridges", `Finding bridge candidates from ${candidateName}`, {
          fromPerson: candidateName,
        });

        currentFrontier = candidateName;
        foundValidEdge = true;
        break; // Break to continue DFS from new frontier
      }

      if (!foundValidEdge) {
        // All candidates at this level failed verification
        await completeStep("find_bridges", false, "All candidates failed verification");
        if (!await backtrack()) break;
        currentFrontier = state.frontier;
      }
    }

    const result = this.finalizeFailure(state);
    await emit("no_path", `Investigation complete. No verified connection found within ${DEFAULT_CONFIG.hopLimit} hops.`, {
      path: state.path,
      hopDepth: state.hopDepth,
    });

    return result;
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

  private finalizeFailure(state: InvestigationState): InvestigationResult {
    return {
      status: "no_path",
      personA: state.personA,
      personB: state.personB,
      message: `No verified visual connection found within ${DEFAULT_CONFIG.hopLimit} degrees at ≥${DEFAULT_CONFIG.confidenceThreshold}% confidence.`,
    };
  }
}

