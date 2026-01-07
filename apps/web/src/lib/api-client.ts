/**
 * API Client for the Visual Degrees Worker
 */

// Worker URL - defaults to localhost for development
const WORKER_URL = process.env.NEXT_PUBLIC_WORKER_URL || "http://localhost:8787";

/**
 * Event types matching the worker's InvestigationEvent
 */
export type InvestigationEventType =
  // Step events (new)
  | "step_start"
  | "step_update"
  | "step_complete"
  // Detail events
  | "research"
  | "thinking"
  | "strategy"
  | "strategy_update"
  | "candidate_discovery"
  | "llm_selection"
  | "image_result"
  | "evidence"
  | "path_update"
  | "backtrack"
  | "status"
  | "final"
  | "no_path"
  | "error";

export type InvestigationStepId =
  | "direct_check"
  | "find_bridges"
  | "verify_bridge"
  | "connect_target";

export type StepStatus = "pending" | "running" | "done" | "failed" | "skipped";

export interface InvestigationEvent {
  type: InvestigationEventType;
  runId: string;
  timestamp: string;
  message: string;
  data?: {
    // Step event data
    stepId?: InvestigationStepId;
    stepNumber?: number;
    stepTitle?: string;
    stepStatus?: StepStatus;
    fromPerson?: string;
    toPerson?: string;
    // Other data
    query?: string;
    reasoning?: string;
    candidates?: Array<{ name: string; score?: number; coappearCount?: number; reasoning?: string }>;
    imageIndex?: number;
    totalImages?: number;
    imageUrl?: string;
    status?: "collage" | "no_match" | "evidence" | "error";
    reason?: string;
    celebrities?: Array<{ name: string; confidence: number }>;
    edge?: {
      from: string;
      to: string;
      confidence: number;
      thumbnailUrl?: string;
      contextUrl?: string;
    };
    path?: string[];
    hopDepth?: number;
    confirmedBridge?: string;
    progressPct?: number;
    hop?: number;
    frontier?: string;
    budget?: Record<string, unknown>;
    result?: Record<string, unknown>;
    category?: string;
    from?: string;
    to?: string;
    remainingDepth?: number;
  };
}

export interface EventsResponse {
  runId: string;
  events: InvestigationEvent[];
  complete: boolean;
  cursor?: string;
}

export interface StartInvestigationResponse {
  id: string;
  runId: string;
  status: string;
  personA: string;
  personB: string;
}

export interface ParseQueryResponse {
  personA: string;
  personB: string;
  isValid: boolean;
  confidence: number;
  reason?: string;
}

/**
 * Parse a natural language query using AI to extract person names
 */
export async function parseQueryWithAI(query: string): Promise<ParseQueryResponse> {
  const response = await fetch(`${WORKER_URL}/api/chat/parse`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query }),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(error.error || "Failed to parse query");
  }

  return response.json();
}

/**
 * Start a new investigation
 */
export async function startInvestigation(
  personA: string,
  personB: string
): Promise<StartInvestigationResponse> {
  const response = await fetch(`${WORKER_URL}/api/chat/query`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ personA, personB }),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(error.error || "Failed to start investigation");
  }

  return response.json();
}

/**
 * Poll for investigation events
 */
export async function pollEvents(
  runId: string,
  cursor?: string
): Promise<EventsResponse> {
  const url = new URL(`${WORKER_URL}/api/chat/events/${runId}`);
  if (cursor) {
    url.searchParams.set("cursor", cursor);
  }

  const response = await fetch(url.toString());

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(error.error || "Failed to poll events");
  }

  return response.json();
}

// ============================================================================
// Graph API Types and Functions
// ============================================================================

export interface GraphData {
  nodes: Array<{
    id: string;
    name: string;
    thumbnailUrl: string | null;
  }>;
  edges: Array<{
    id: string;
    source: string;
    target: string;
    confidence: number;
    evidenceUrl: string | null;
    thumbnailUrl: string | null;
    contextUrl: string | null;
  }>;
}

export interface GraphStats {
  nodeCount: number;
  edgeCount: number;
  avgConfidence: number;
}

/**
 * Fetch the full social graph for visualization
 */
export async function fetchGraph(): Promise<GraphData> {
  const response = await fetch(`${WORKER_URL}/api/graph`);
  if (!response.ok) {
    throw new Error("Failed to fetch graph");
  }
  return response.json();
}

/**
 * Fetch graph statistics
 */
export async function fetchGraphStats(): Promise<GraphStats> {
  const response = await fetch(`${WORKER_URL}/api/graph/stats`);
  if (!response.ok) {
    throw new Error("Failed to fetch graph stats");
  }
  return response.json();
}

// ============================================================================
// Cached Path Lookup
// ============================================================================

/**
 * Path step with evidence details
 */
export interface PathStep {
  from: string;
  fromName: string;
  to: string;
  toName: string;
  confidence: number;
  evidenceUrl: string | null;
  thumbnailUrl: string | null;
  contextUrl: string | null;
}

/**
 * Result of a cached path lookup
 */
export interface CachedPathResult {
  found: boolean;
  path: string[];      // Node names in order
  pathIds: string[];   // Node IDs in order
  steps: PathStep[];   // Edge details for each hop
  hops: number;
  minConfidence: number;  // Bottleneck confidence
}

/**
 * Look up a cached path between two people in the graph database
 * Uses BFS to find the shortest existing path
 */
export async function findCachedPath(
  fromName: string,
  toName: string
): Promise<CachedPathResult> {
  const url = new URL(`${WORKER_URL}/api/graph/path`);
  url.searchParams.set("from", fromName);
  url.searchParams.set("to", toName);

  const response = await fetch(url.toString());
  if (!response.ok) {
    throw new Error("Failed to lookup cached path");
  }
  return response.json();
}

/**
 * Creates a polling loop that calls onEvents whenever new events arrive
 */
export function createEventPoller(
  runId: string,
  onEvents: (events: InvestigationEvent[], complete: boolean) => void,
  onError: (error: Error) => void,
  intervalMs = 500
): () => void {
  let cursor = "0";
  let isRunning = true;
  let timeoutId: NodeJS.Timeout | null = null;
  const seenEventIds = new Set<string>();

  // Get unique event ID - use backend-provided eventId if available, fallback to composite key
  const getEventId = (e: InvestigationEvent): string => {
    // Prefer backend-provided unique eventId
    const data = e.data as Record<string, unknown> | undefined;
    if (data?.eventId) {
      return data.eventId as string;
    }
    // Fallback for older events without eventId
    return `${e.type}:${e.timestamp}:${e.message}`;
  };

  const poll = async () => {
    if (!isRunning) return;

    try {
      const response = await pollEvents(runId, cursor);

      if (response.events.length > 0) {
        // Filter out events we've already seen using unique eventId
        const newEvents = response.events.filter(event => {
          const id = getEventId(event);
          if (seenEventIds.has(id)) {
            return false;
          }
          seenEventIds.add(id);
          return true;
        });

        if (newEvents.length > 0) {
          onEvents(newEvents, response.complete);
        }
      }

      if (response.cursor) {
        cursor = response.cursor;
      }

      if (!response.complete && isRunning) {
        timeoutId = setTimeout(poll, intervalMs);
      } else if (response.complete) {
        // Final poll - investigation is complete
        onEvents([], true);
        isRunning = false;
      }
    } catch (error) {
      onError(error instanceof Error ? error : new Error(String(error)));
      // Retry on error after a longer delay
      if (isRunning) {
        timeoutId = setTimeout(poll, intervalMs * 2);
      }
    }
  };

  // Start polling immediately
  poll();

  // Return cleanup function
  return () => {
    isRunning = false;
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  };
}

/**
 * Creates an SSE (Server-Sent Events) stream for real-time event updates
 * This provides lower latency than polling and uses less bandwidth
 */
export function createEventStream(
  runId: string,
  onEvent: (event: InvestigationEvent) => void,
  onComplete: () => void,
  onError: (error: Error) => void
): () => void {
  const seenEventIds = new Set<string>();
  let eventSource: EventSource | null = null;

  // Get unique event ID
  const getEventId = (e: InvestigationEvent): string => {
    const data = e.data as Record<string, unknown> | undefined;
    if (data?.eventId) {
      return data.eventId as string;
    }
    return `${e.type}:${e.timestamp}:${e.message}`;
  };

  try {
    const streamUrl = `${WORKER_URL}/api/chat/stream/${runId}`;
    eventSource = new EventSource(streamUrl);

    eventSource.onmessage = (event) => {
      try {
        const parsed = JSON.parse(event.data) as InvestigationEvent;
        const id = getEventId(parsed);

        // Skip duplicates
        if (seenEventIds.has(id)) {
          return;
        }
        seenEventIds.add(id);

        onEvent(parsed);

        // Check for completion
        if (parsed.type === "final" || parsed.type === "no_path" || parsed.type === "error") {
          eventSource?.close();
          onComplete();
        }
      } catch (err) {
        console.warn("Failed to parse SSE event:", err);
      }
    };

    eventSource.onerror = (err) => {
      console.error("SSE error:", err);
      eventSource?.close();
      onError(new Error("SSE connection error"));
    };
  } catch (err) {
    onError(err instanceof Error ? err : new Error(String(err)));
  }

  // Return cleanup function
  return () => {
    eventSource?.close();
  };
}

