import { Env } from './env';
import { InvestigationEvent, EventsResponse } from '@visual-degrees/contracts';
import { OpenRouterClient } from '@visual-degrees/integrations';
import { getFullGraph, getGraphStats, findPath } from './graph-db';
export { InvestigationWorkflow } from './workflows/investigation';

// Default allowed origins (fallback if env not set)
const DEFAULT_ALLOWED_ORIGINS = [
  "https://vd.nintang48.workers.dev",
  "http://localhost:3000",
  "http://localhost:3001",
];

// Rate limit: 10 searches per hour per IP
const RATE_LIMIT_MAX = 10;
const RATE_LIMIT_WINDOW = 60 * 60; // 1 hour in seconds

/**
 * Get allowed origins from env or use defaults
 */
function getAllowedOrigins(env: Env): string[] {
  if (env.ALLOWED_ORIGINS) {
    return env.ALLOWED_ORIGINS.split(",").map(o => o.trim());
  }
  return DEFAULT_ALLOWED_ORIGINS;
}

/**
 * Get CORS headers based on request origin
 */
function getCorsHeaders(request: Request, env: Env): Record<string, string> {
  const allowedOrigins = getAllowedOrigins(env);
  const origin = request.headers.get("Origin") || "";
  const allowedOrigin = allowedOrigins.includes(origin) ? origin : allowedOrigins[0];

  return {
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

/**
 * Check rate limit for an IP address
 * Returns { allowed: boolean, remaining: number, resetAt: number }
 */
async function checkRateLimit(
  env: Env,
  ip: string
): Promise<{ allowed: boolean; remaining: number; resetAt: number }> {
  const key = `ratelimit:${ip}`;
  const now = Math.floor(Date.now() / 1000);

  const data = await env.RATE_LIMIT.get(key);

  if (!data) {
    // First request - initialize counter
    const resetAt = now + RATE_LIMIT_WINDOW;
    await env.RATE_LIMIT.put(key, JSON.stringify({ count: 1, resetAt }), {
      expirationTtl: RATE_LIMIT_WINDOW,
    });
    return { allowed: true, remaining: RATE_LIMIT_MAX - 1, resetAt };
  }

  const { count, resetAt } = JSON.parse(data);

  if (now >= resetAt) {
    // Window expired - reset counter
    const newResetAt = now + RATE_LIMIT_WINDOW;
    await env.RATE_LIMIT.put(key, JSON.stringify({ count: 1, resetAt: newResetAt }), {
      expirationTtl: RATE_LIMIT_WINDOW,
    });
    return { allowed: true, remaining: RATE_LIMIT_MAX - 1, resetAt: newResetAt };
  }

  if (count >= RATE_LIMIT_MAX) {
    // Rate limit exceeded
    return { allowed: false, remaining: 0, resetAt };
  }

  // Increment counter
  await env.RATE_LIMIT.put(key, JSON.stringify({ count: count + 1, resetAt }), {
    expirationTtl: resetAt - now,
  });

  return { allowed: true, remaining: RATE_LIMIT_MAX - count - 1, resetAt };
}

/**
 * Get client IP from request
 */
function getClientIP(request: Request): string {
  return request.headers.get("CF-Connecting-IP") ||
         request.headers.get("X-Forwarded-For")?.split(",")[0]?.trim() ||
         "unknown";
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const corsHeaders = getCorsHeaders(request, env);

    // Handle CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }
    
    // POST /api/chat/parse - Parse a natural language query using AI
    if (url.pathname === "/api/chat/parse" && request.method === "POST") {
      try {
        const body = await request.json() as { query?: string };
        const { query } = body;

        if (!query || typeof query !== "string") {
          return new Response(JSON.stringify({ error: "Missing query" }), {
            status: 400,
            headers: { "Content-Type": "application/json", ...corsHeaders }
          });
        }

        const client = new OpenRouterClient({
          apiKey: env.OPENROUTER_API_KEY,
          model: "google/gemini-2.0-flash-001",
        });

        const result = await client.parseQuery(query);

        return new Response(JSON.stringify(result), {
          headers: { "Content-Type": "application/json", ...corsHeaders }
        });
      } catch (e) {
        return new Response(JSON.stringify({
          error: e instanceof Error ? e.message : String(e)
        }), {
          status: 500,
          headers: { "Content-Type": "application/json", ...corsHeaders }
        });
      }
    }

    // POST /api/chat/query - Start a new investigation
    if (url.pathname === "/api/chat/query" && request.method === "POST") {
      try {
        // Check rate limit
        const clientIP = getClientIP(request);
        const rateLimit = await checkRateLimit(env, clientIP);

        if (!rateLimit.allowed) {
          const resetDate = new Date(rateLimit.resetAt * 1000);
          return new Response(JSON.stringify({
            error: "Rate limit exceeded. You can perform 10 searches per hour.",
            remaining: 0,
            resetAt: resetDate.toISOString(),
          }), {
            status: 429,
            headers: {
              "Content-Type": "application/json",
              "X-RateLimit-Limit": String(RATE_LIMIT_MAX),
              "X-RateLimit-Remaining": "0",
              "X-RateLimit-Reset": String(rateLimit.resetAt),
              ...corsHeaders
            }
          });
        }

        const body = await request.json() as { personA?: string; personB?: string };
        const { personA, personB } = body;

        if (!personA || !personB) {
          return new Response(JSON.stringify({ error: "Missing personA or personB" }), {
            status: 400,
            headers: { "Content-Type": "application/json", ...corsHeaders }
          });
        }

        // Generate a unique run ID
        const runId = crypto.randomUUID();

        // Trigger the workflow with the runId
        const instance = await env.INVESTIGATION_WORKFLOW.create({
          params: { personA, personB, runId }
        });

        return new Response(JSON.stringify({
          id: instance.id,
          runId,
          status: "started",
          personA,
          personB,
        }), {
          headers: {
            "Content-Type": "application/json",
            "X-RateLimit-Limit": String(RATE_LIMIT_MAX),
            "X-RateLimit-Remaining": String(rateLimit.remaining),
            "X-RateLimit-Reset": String(rateLimit.resetAt),
            ...corsHeaders
          }
        });
      } catch (e) {
        return new Response(JSON.stringify({
          error: e instanceof Error ? e.message : String(e)
        }), {
          status: 500,
          headers: { "Content-Type": "application/json", ...corsHeaders }
        });
      }
    }

    // GET /api/chat/stream/:runId - Server-Sent Events stream for real-time updates
    if (url.pathname.startsWith("/api/chat/stream/") && request.method === "GET") {
      const runId = url.pathname.split("/").pop();
      if (!runId) {
        return new Response(JSON.stringify({ error: "Missing runId" }), {
          status: 400,
          headers: { "Content-Type": "application/json", ...corsHeaders }
        });
      }

      // Create SSE stream
      const stream = new ReadableStream({
        async start(controller) {
          const encoder = new TextEncoder();
          let cursor = 0;
          let isComplete = false;

          const sendEvent = (event: InvestigationEvent) => {
            const data = `data: ${JSON.stringify(event)}\n\n`;
            controller.enqueue(encoder.encode(data));
          };

          // Poll for new events and stream them
          while (!isComplete) {
            try {
              const countStr = await env.INVESTIGATION_EVENTS.get(`${runId}:count`);
              const count = countStr ? parseInt(countStr, 10) : 0;

              // Stream new events
              for (let i = cursor; i < count; i++) {
                const key = `${runId}:${String(i).padStart(6, "0")}`;
                const eventJson = await env.INVESTIGATION_EVENTS.get(key);
                if (eventJson) {
                  try {
                    const event = JSON.parse(eventJson) as InvestigationEvent;
                    sendEvent(event);

                    // Check for completion
                    if (event.type === "final" || event.type === "no_path" || event.type === "error") {
                      isComplete = true;
                    }
                  } catch {
                    // Skip malformed events
                  }
                }
              }

              cursor = count;

              // Small delay before next poll (100ms for faster updates)
              if (!isComplete) {
                await new Promise(resolve => setTimeout(resolve, 100));
              }
            } catch (error) {
              // Send error event and close
              const errorEvent = {
                type: "error" as const,
                runId,
                timestamp: new Date().toISOString(),
                message: error instanceof Error ? error.message : "Stream error",
                data: {}
              };
              sendEvent(errorEvent);
              isComplete = true;
            }
          }

          controller.close();
        }
      });

      return new Response(stream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
          ...corsHeaders
        }
      });
    }

    // GET /api/chat/events/:runId - Poll for events
    // Query params: cursor (optional) - timestamp to get events after
    if (url.pathname.startsWith("/api/chat/events/") && request.method === "GET") {
      const runId = url.pathname.split("/").pop();
      if (!runId) {
        return new Response(JSON.stringify({ error: "Missing runId" }), { 
          status: 400,
          headers: { "Content-Type": "application/json", ...corsHeaders }
        });
      }

      try {
        const cursorParam = url.searchParams.get("cursor");
        const cursor = cursorParam ? parseInt(cursorParam, 10) : 0;

        // Get the total event count
        const countStr = await env.INVESTIGATION_EVENTS.get(`${runId}:count`);
        const count = countStr ? parseInt(countStr, 10) : 0;

        // Fetch all events after cursor
        const events: InvestigationEvent[] = [];
        for (let i = cursor; i < count; i++) {
          const key = `${runId}:${String(i).padStart(6, "0")}`;
          const eventJson = await env.INVESTIGATION_EVENTS.get(key);
          if (eventJson) {
            try {
              events.push(JSON.parse(eventJson));
            } catch {
              // Skip malformed events
            }
          }
        }

        // Check if investigation is complete
        const lastEvent = events[events.length - 1];
        const complete = lastEvent?.type === "final" || lastEvent?.type === "no_path" || lastEvent?.type === "error";

        const response: EventsResponse = {
          runId,
          events,
          complete,
          cursor: String(count),
        };

        return new Response(JSON.stringify(response), {
          headers: { "Content-Type": "application/json", ...corsHeaders }
        });
      } catch (e) {
        return new Response(JSON.stringify({ 
          error: e instanceof Error ? e.message : String(e) 
        }), { 
          status: 500,
          headers: { "Content-Type": "application/json", ...corsHeaders }
        });
      }
    }

    // GET /api/chat/status/:instanceId - Get workflow status
    if (url.pathname.startsWith("/api/chat/status/") && request.method === "GET") {
      const id = url.pathname.split("/").pop();
      if (!id) {
        return new Response(JSON.stringify({ error: "Missing ID" }), { 
          status: 400,
          headers: { "Content-Type": "application/json", ...corsHeaders }
        });
      }

      try {
        const instance = await env.INVESTIGATION_WORKFLOW.get(id);
        const status = await instance.status();
        
        return new Response(JSON.stringify({
          id,
          status: status.status,
          error: status.error,
          output: status.output 
        }), {
          headers: { "Content-Type": "application/json", ...corsHeaders }
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: "Instance not found" }), { 
          status: 404,
          headers: { "Content-Type": "application/json", ...corsHeaders }
        });
      }
    }

    // GET /api/graph - Get the full social graph for visualization
    if (url.pathname === "/api/graph" && request.method === "GET") {
      try {
        const graph = await getFullGraph(env.GRAPH_DB);
        return new Response(JSON.stringify(graph), {
          headers: { "Content-Type": "application/json", ...corsHeaders }
        });
      } catch (e) {
        return new Response(JSON.stringify({
          error: e instanceof Error ? e.message : String(e),
          nodes: [],
          edges: []
        }), {
          status: 200, // Return empty graph on error (DB might not exist yet)
          headers: { "Content-Type": "application/json", ...corsHeaders }
        });
      }
    }

    // GET /api/graph/stats - Get graph statistics
    if (url.pathname === "/api/graph/stats" && request.method === "GET") {
      try {
        const stats = await getGraphStats(env.GRAPH_DB);
        return new Response(JSON.stringify(stats), {
          headers: { "Content-Type": "application/json", ...corsHeaders }
        });
      } catch (e) {
        return new Response(JSON.stringify({
          nodeCount: 0,
          edgeCount: 0,
          avgConfidence: 0
        }), {
          status: 200,
          headers: { "Content-Type": "application/json", ...corsHeaders }
        });
      }
    }

    // GET /api/graph/path - Find shortest path between two people (cached lookup)
    if (url.pathname === "/api/graph/path" && request.method === "GET") {
      try {
        const from = url.searchParams.get("from");
        const to = url.searchParams.get("to");

        if (!from || !to) {
          return new Response(JSON.stringify({
            error: "Missing 'from' or 'to' query parameter"
          }), {
            status: 400,
            headers: { "Content-Type": "application/json", ...corsHeaders }
          });
        }

        const pathResult = await findPath(env.GRAPH_DB, from, to);
        return new Response(JSON.stringify(pathResult), {
          headers: { "Content-Type": "application/json", ...corsHeaders }
        });
      } catch (e) {
        return new Response(JSON.stringify({
          found: false,
          path: [],
          pathIds: [],
          steps: [],
          hops: 0,
          minConfidence: 0,
          error: e instanceof Error ? e.message : String(e)
        }), {
          status: 200,
          headers: { "Content-Type": "application/json", ...corsHeaders }
        });
      }
    }

    return new Response(JSON.stringify({
      service: "Visual Degrees Worker",
      version: "1.0.0",
      endpoints: [
        "POST /api/chat/parse",
        "POST /api/chat/query",
        "GET /api/chat/stream/:runId (SSE)",
        "GET /api/chat/events/:runId",
        "GET /api/chat/status/:instanceId",
        "GET /api/graph",
        "GET /api/graph/stats",
        "GET /api/graph/path?from=Person+A&to=Person+B"
      ]
    }), {
      status: 200,
      headers: { "Content-Type": "application/json", ...corsHeaders }
    });
  }
};
