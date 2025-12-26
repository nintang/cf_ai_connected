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

