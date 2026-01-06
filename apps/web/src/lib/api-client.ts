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
    budget?: any;
    result?: any;
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

