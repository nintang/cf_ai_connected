// ============================================================================
// Image Search Types (Google PSE)
// ============================================================================

/**
 * Minimal extracted record from Google PSE image search
 */
export interface ImageSearchResult {
  /** Direct image URL (items[].link) */
  imageUrl: string;
  /** Thumbnail URL for UI preview (items[].image.thumbnailLink) */
  thumbnailUrl: string;
  /** Context webpage URL where the image appears (items[].image.contextLink) */
  contextUrl: string;
  /** Image title (optional display) */
  title: string;
}

/**
 * Response from a PSE search query
 */
export interface ImageSearchResponse {
  query: string;
  results: ImageSearchResult[];
}

// ============================================================================
// Celebrity Detection Types (Amazon Rekognition)
// ============================================================================

/**
 * Bounding box for a detected face
 */
export interface BoundingBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * A celebrity detected in an image by Rekognition
 */
export interface DetectedCelebrity {
  /** Celebrity name as returned by Rekognition */
  name: string;
  /** Match confidence (0-100) */
  confidence: number;
  /** Face bounding box in the image */
  boundingBox: BoundingBox;
}

/**
 * Result from analyzing a single image with Rekognition
 */
export interface ImageAnalysisResult {
  /** Original image URL that was analyzed */
  imageUrl: string;
  /** All celebrities detected in the image */
  celebrities: DetectedCelebrity[];
}

// ============================================================================
// Evidence Types
// ============================================================================

/**
 * Evidence record for a verified edge between two people
 */
export interface EvidenceRecord {
  /** Source person */
  from: string;
  /** Target person */
  to: string;
  /** Direct image URL */
  imageUrl: string;
  /** Thumbnail URL for UI */
  thumbnailUrl: string;
  /** Context/source page URL */
  contextUrl: string;
  /** Image title */
  title: string;
  /** Celebrities detected in this image */
  detectedCelebs: Array<{ name: string; confidence: number }>;
  /** Per-image evidence score: min(confP, confQ) */
  imageScore: number;
}

/**
 * A verified edge between two people with confidence
 */
export interface VerifiedEdge {
  from: string;
  to: string;
  /** Edge confidence: max(imageScore) across all valid evidence images */
  edgeConfidence: number;
  /** All valid evidence images for this edge */
  evidence: EvidenceRecord[];
  /** The single best evidence image (highest imageScore) */
  bestEvidence: EvidenceRecord;
}

// ============================================================================
// Path & Confidence Types
// ============================================================================

/**
 * Confidence metrics for a complete path
 */
export interface PathConfidence {
  /** Minimum edge confidence across the path */
  pathBottleneck: number;
  /** Product of (edge_conf / 100) across all edges, as decimal 0-1 */
  pathCumulative: number;
}

/**
 * A complete verified path between two people
 */
export interface VerifiedPath {
  personA: string;
  personB: string;
  /** Ordered list of people in the path [A, ..., B] */
  path: string[];
  /** All edges in the path */
  edges: VerifiedEdge[];
  /** Path confidence metrics */
  confidence: PathConfidence;
}

// ============================================================================
// Graph Types (for visualization)
// ============================================================================

export interface GraphNode {
  id: string;
  name: string;
}

export interface GraphEdge {
  id: string;
  from: string;
  to: string;
  edgeConfidence: number;
  evidenceRefs: string[];
}

export interface GraphPayload {
  nodes: GraphNode[];
  edges: GraphEdge[];
  evidence: Array<{
    id: string;
    imageUrl: string;
    thumbnailUrl: string;
    contextUrl: string;
    title: string;
  }>;
}

// ============================================================================
// Configuration Types
// ============================================================================

/**
 * MVP fixed parameters
 */
export interface InvestigationConfig {
  /** Maximum number of hops (default: 6) */
  hopLimit: number;
  /** Minimum confidence threshold for accepting detections (default: 80) */
  confidenceThreshold: number;
  /** Number of images to process per search query (default: 5) */
  imagesPerQuery: number;
}

export const DEFAULT_CONFIG: InvestigationConfig = {
  hopLimit: 6,
  confidenceThreshold: 80,
  imagesPerQuery: 5,
};

// ============================================================================
// Budget Types
// ============================================================================

/**
 * Budget tracking for API calls during investigation
 */
export interface InvestigationBudgets {
  /** Maximum search API calls allowed */
  maxSearchCalls: number;
  /** Maximum Rekognition API calls allowed */
  maxRekognitionCalls: number;
  /** Maximum LLM API calls allowed */
  maxLLMCalls: number;
  /** Search calls used so far */
  searchCallsUsed: number;
  /** Rekognition calls used so far */
  rekognitionCallsUsed: number;
  /** LLM calls used so far */
  llmCallsUsed: number;
}

export const DEFAULT_BUDGETS: InvestigationBudgets = {
  maxSearchCalls: 100,
  maxRekognitionCalls: 200,
  maxLLMCalls: 10,
  searchCallsUsed: 0,
  rekognitionCallsUsed: 0,
  llmCallsUsed: 0,
};

// ============================================================================
// Candidate Types (for LLM Planner)
// ============================================================================

/**
 * An intermediate candidate discovered from Rekognition co-appearances
 */
export interface Candidate {
  /** Celebrity name as returned by Rekognition */
  name: string;
  /** Number of images where this person co-appears with the frontier */
  coappearCount: number;
  /** Highest confidence score for co-appearance with frontier */
  bestCoappearConfidence: number;
  /** Context URLs where evidence was found */
  evidenceContextUrls: string[];
}

/**
 * Input to the LLM planner for selecting next expansion
 */
export interface PlannerInput {
  /** Original starting person */
  personA: string;
  /** Target person to connect to */
  personB: string;
  /** Current frontier node being expanded */
  frontier: string;
  /** Hops used so far */
  hopUsed: number;
  /** Maximum hops allowed */
  hopLimit: number;
  /** Confidence threshold for acceptance */
  confidenceThreshold: number;
  /** Remaining budget for API calls */
  budgets: {
    searchCallsRemaining: number;
    rekognitionCallsRemaining: number;
    llmCallsRemaining: number;
  };
  /** Edges verified so far in the path */
  verifiedEdges: Array<{ from: string; to: string; confidence: number }>;
  /** Candidates that failed verification */
  failedCandidates: string[];
  /** Available candidates to choose from */
  candidates: Candidate[];
}

/**
 * Output from the LLM planner
 */
export interface PlannerOutput {
  /** Ordered list of candidates to try (1-2 items) */
  nextCandidates: string[];
  /** Search queries to run next */
  searchQueries: string[];
  /** Narration for chat UI */
  narration: string;
  /** Whether to stop the search */
  stop: boolean;
  /** Reason for the decision */
  reason: string;
}

// ============================================================================
// Investigation State Types
// ============================================================================

/**
 * Current state of an investigation
 */
export interface InvestigationState {
  /** Original starting person */
  personA: string;
  /** Target person to connect to */
  personB: string;
  /** Current frontier node being expanded */
  frontier: string;
  /** Current hop depth */
  hopDepth: number;
  /** Ordered path of verified nodes so far */
  path: string[];
  /** All verified edges */
  verifiedEdges: VerifiedEdge[];
  /** Candidates that failed verification */
  failedCandidates: string[];
  /** Current budget state */
  budgets: InvestigationBudgets;
  /** Investigation status */
  status: "running" | "success" | "failed";
}

// ============================================================================
// Result Types
// ============================================================================

/**
 * Result of attempting to verify a direct edge between two people
 */
export type DirectEdgeResult =
  | { success: true; edge: VerifiedEdge }
  | { success: false; partialMatches: ImageAnalysisResult[] };

/**
 * Result of a full investigation
 */
export type InvestigationResult =
  | { status: "success"; result: VerifiedPath; disclaimer: string }
  | { status: "no_path"; personA: string; personB: string; message: string };

// ============================================================================
// Streaming Event Types (for Chain-of-Thought UI)
// ============================================================================

/**
 * All possible event types emitted during an investigation
 */
export type InvestigationEventType =
  // Phase markers for clear UI progression
  | "step_start"         // Starting a new step
  | "step_update"        // Progress update within a step
  | "step_complete"      // Step completed
  // Detail events (nested within steps)
  | "research"           // Starting a search query
  | "thinking"           // LLM reasoning/thoughts
  | "strategy"           // Initial strategy decision
  | "strategy_update"    // Strategy updated based on findings
  | "candidate_discovery"// Found candidate bridges
  | "llm_selection"      // LLM selected next candidates
  | "image_result"       // Per-image analysis result
  | "evidence"           // Verified edge found
  | "path_update"        // Path has changed
  | "backtrack"          // DFS backtracking to try another path
  | "status"             // General status update
  | "final"              // Investigation completed successfully
  | "no_path"            // Investigation completed with no path
  | "error";             // Error occurred

/**
 * Step identifiers for the investigation workflow
 */
export type InvestigationStepId =
  | "direct_check"       // Step 1: Check for direct connection
  | "find_bridges"       // Step 2: Find bridge candidates
  | "verify_bridge"      // Step 3: Verify connection to bridge candidate
  | "connect_target";    // Step 4: Connect bridge to target

/**
 * Step status
 */
export type StepStatus = "pending" | "running" | "done" | "failed" | "skipped";

/**
 * A streaming event emitted during investigation
 */
export interface InvestigationEvent {
  /** Event type */
  type: InvestigationEventType;
  /** Unique run identifier */
  runId: string;
  /** ISO-8601 timestamp */
  timestamp: string;
  /** Human-readable message */
  message: string;
  /** Event-specific data */
  data?: {
    // Unique event identifier for deduplication
    eventId?: string;
    // For step events (step_start, step_update, step_complete)
    stepId?: InvestigationStepId;
    stepNumber?: number;
    stepTitle?: string;
    stepStatus?: StepStatus;
    // For verify_bridge / connect_target steps - who we're connecting
    fromPerson?: string;
    toPerson?: string;
    // For research events
    query?: string;
    // For thinking events
    reasoning?: string;
    // For candidate_discovery / llm_selection
    candidates?: Array<{ name: string; score?: number; coappearCount?: number; reasoning?: string }>;
    // For image_result events
    imageIndex?: number;
    totalImages?: number;
    imageUrl?: string;
    status?: "collage" | "no_match" | "evidence" | "error";
    reason?: string;
    celebrities?: Array<{ name: string; confidence: number }>;
    // For evidence events
    edge?: {
      from: string;
      to: string;
      confidence: number;
      thumbnailUrl?: string;
      contextUrl?: string;
    };
    // For path_update events
    path?: string[];
    hopDepth?: number;
    // For strategy_update events
    confirmedBridge?: string;
    progressPct?: number;
    // For status events
    hop?: number;
    frontier?: string;
    budget?: InvestigationBudgets;
    // For backtrack events
    from?: string;
    to?: string;
    remainingDepth?: number;
    // For final events
    result?: VerifiedPath;
    // For error events
    category?: "INTEGRATION_ERROR" | "TIMEOUT" | "VALIDATION_ERROR" | "UNKNOWN";
  };
}

/**
 * Response from the events polling endpoint
 */
export interface EventsResponse {
  /** Run ID */
  runId: string;
  /** All events (or events after cursor) */
  events: InvestigationEvent[];
  /** Whether the investigation is complete */
  complete: boolean;
  /** Cursor for next poll (timestamp of last event) */
  cursor?: string;
}
