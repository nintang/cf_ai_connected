// Step identifiers matching the backend
export type InvestigationStepId =
  | "direct_check"    // Step 1: Check for direct connection
  | "find_bridges"    // Step 2: Find bridge candidates
  | "verify_bridge"   // Step 3: Verify connection to bridge candidate
  | "connect_target"; // Step 4: Connect bridge to target

export type StepStatus = "pending" | "running" | "done" | "failed" | "skipped";

export type InvestigationEventType =
  | "step_start"
  | "step_update"
  | "step_complete"
  | "research"
  | "strategy"
  | "strategy_update"
  | "candidate_discovery"
  | "llm_selection"
  | "status"
  | "evidence"
  | "path_update"
  | "visual_check"
  | "thinking"
  | "backtrack"
  | "image_result"
  | "final"
  | "no_path"
  | "error";

export interface InvestigationEvent {
  type: InvestigationEventType;
  message: string;
  data?: {
    // Step-related data
    stepId?: InvestigationStepId;
    stepNumber?: number;
    stepTitle?: string;
    stepStatus?: StepStatus;
    fromPerson?: string;
    toPerson?: string;
    // Candidate data
    candidates?: Array<{ name: string; score?: number; reasoning?: string }>;
    // Image result data
    imageIndex?: number;
    totalImages?: number;
    imageUrl?: string;
    status?: "collage" | "no_match" | "evidence" | "error";
    reason?: string;
    celebrities?: Array<{ name: string; confidence: number }>;
    // Evidence data
    edge?: {
      from: string;
      to: string;
      confidence: number;
      thumbnailUrl?: string;
      contextUrl?: string;
    };
    // Path data
    path?: string[];
    hopDepth?: number;
    // Other
    query?: string;
    [key: string]: unknown;
  };
  timestamp: number;
}

// A single step in the investigation workflow
export interface InvestigationStep {
  id: InvestigationStepId;
  number: number;
  title: string;
  status: StepStatus;
  message?: string;
  events: InvestigationEvent[]; // Detail events within this step
  fromPerson?: string;
  toPerson?: string;
  startTime?: number;
  endTime?: number;
}

export interface EvidenceItem {
  id: string;
  from: string;
  to: string;
  thumbnailUrl: string;
  evidenceUrl?: string; // Full-resolution image URL
  sourceUrl: string;
  confidence: number;
  description: string;
}

export interface PathHop {
  from: string;
  to: string;
  confidence: number;
}

/**
 * A segment represents one "search attempt" between two people.
 * When DFS goes deeper, each hop becomes its own segment.
 * Example: A → Bridge → B creates segments:
 *   1. "A → B" (direct check - failed)
 *   2. "A → Bridge" (finding bridge - success)
 *   3. "Bridge → B" (connecting to target - success)
 */
export interface InvestigationSegment {
  id: string;
  from: string;
  to: string;
  hopDepth: number; // 0 = direct, 1+ = via bridges
  status: "running" | "success" | "failed" | "skipped";
  steps: InvestigationStep[];
  evidence?: EvidenceItem;
  startTime: number;
  endTime?: number;
  /** Reasoning for why this candidate was selected (from LLM planner) */
  candidateReasoning?: string;
}

export interface InvestigationState {
  query: {
    personA: string;
    personB: string;
  };
  status: "idle" | "running" | "completed" | "failed";
  // Segment-based tracking - each segment is a from→to search
  segments: InvestigationSegment[];
  activeSegmentId: string | null;
  // Legacy step-based tracking (for backwards compat)
  steps: InvestigationStep[];
  currentStepNumber: number;
  // Evidence and path
  evidence: EvidenceItem[];
  path: PathHop[];
  // Current DFS path being explored
  currentPath: string[];
  // All raw events for debugging
  logs: InvestigationEvent[];
}

// Helper to create initial state
export function createInitialState(personA: string, personB: string): InvestigationState {
  return {
    query: { personA, personB },
    status: "running",
    // Segment-based tracking
    segments: [],
    activeSegmentId: null,
    // Legacy step-based
    steps: [],
    currentStepNumber: 0,
    // Evidence and path
    evidence: [],
    path: [],
    currentPath: [personA],
    logs: [],
  };
}

// Step title defaults
export const STEP_TITLES: Record<InvestigationStepId, string> = {
  direct_check: "Checking for direct connection",
  find_bridges: "Finding bridge candidates",
  verify_bridge: "Verifying bridge connection",
  connect_target: "Connecting to target",
};
