import { Env } from './env';
import { InvestigationEvent, EventsResponse } from '@visual-degrees/contracts';
import { OpenRouterClient, CelebrityRekognitionClient } from '@visual-degrees/integrations';
import { getFullGraph, getGraphStats, findPath } from './graph-db';
import { searchImages } from './tools/search';
export { InvestigationWorkflow } from './workflows/investigation';
export { GraphBroadcaster } from './durable-objects/graph-broadcaster';
export { InvestigationEventsBroadcaster } from './durable-objects/investigation-events-broadcaster';

// Default allowed origins (fallback if env not set)
const DEFAULT_ALLOWED_ORIGINS = [
  "https://vd.nintang48.workers.dev",
  "http://localhost:3000",
  "http://localhost:3001",
];

// Rate limit: 50 searches per day per IP
const RATE_LIMIT_MAX = 50;
const RATE_LIMIT_WINDOW = 24 * 60 * 60; // 24 hours in seconds

// Whitelisted IPs (unlimited access) - set via env variable WHITELISTED_IPS
const WHITELISTED_IPS = new Set<string>();

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
 * Check if IP is whitelisted (from env variable)
 */
function isWhitelisted(env: Env, ip: string): boolean {
  // Check hardcoded set first
  if (WHITELISTED_IPS.has(ip)) return true;

  // Check env variable (comma-separated IPs)
  if (env.WHITELISTED_IPS) {
    const envWhitelist = env.WHITELISTED_IPS.split(",").map((i: string) => i.trim());
    return envWhitelist.includes(ip);
  }
  return false;
}

/**
 * Check rate limit for an IP address
 * Returns { allowed: boolean, remaining: number, resetAt: number }
 */
async function checkRateLimit(
  env: Env,
  ip: string
): Promise<{ allowed: boolean; remaining: number; resetAt: number }> {
  // Whitelisted IPs bypass rate limiting
  if (isWhitelisted(env, ip)) {
    return { allowed: true, remaining: 999999, resetAt: 0 };
  }

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

    // GET /api/graph/ws - WebSocket upgrade for real-time graph updates
    if (url.pathname === "/api/graph/ws" && request.headers.get("Upgrade") === "websocket") {
      const id = env.GRAPH_BROADCASTER.idFromName("global");
      const stub = env.GRAPH_BROADCASTER.get(id);
      return stub.fetch(request);
    }

    // GET /api/chat/ws/:runId - WebSocket upgrade for real-time investigation events
    // Uses per-runId Durable Object instances for event streaming (no subrequest limits)
    if (url.pathname.startsWith("/api/chat/ws/") && request.headers.get("Upgrade") === "websocket") {
      const runId = url.pathname.split("/").pop();
      if (!runId) {
        return new Response(JSON.stringify({ error: "Missing runId" }), {
          status: 400,
          headers: { "Content-Type": "application/json", ...corsHeaders }
        });
      }

      // Route to per-runId Durable Object
      const id = env.INVESTIGATION_EVENTS_BROADCASTER.idFromName(runId);
      const stub = env.INVESTIGATION_EVENTS_BROADCASTER.get(id);

      // Forward cursor param if present (for replay from specific point)
      const cursor = url.searchParams.get("cursor");
      const doUrl = cursor
        ? `https://internal/ws?cursor=${cursor}`
        : "https://internal/ws";

      return stub.fetch(new Request(doUrl, request));
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
            error: "Rate limit exceeded. You can perform 50 searches per day.",
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
          const streamStartTime = Date.now();
          const MAX_STREAM_DURATION_MS = 10 * 60 * 1000; // 10 minutes max

          const sendEvent = (event: InvestigationEvent) => {
            const data = `data: ${JSON.stringify(event)}\n\n`;
            controller.enqueue(encoder.encode(data));
          };

          // Poll for new events and stream them
          while (!isComplete) {
            // Check for stream timeout
            if (Date.now() - streamStartTime > MAX_STREAM_DURATION_MS) {
              const timeoutEvent = {
                type: "error" as const,
                runId,
                timestamp: new Date().toISOString(),
                message: "Stream exceeded maximum duration (10 minutes)",
                data: { category: "TIMEOUT" as const }
              };
              sendEvent(timeoutEvent);
              isComplete = true;
              break;
            }

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
                    console.warn(`[SSE] Malformed event at ${key}`);
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
              console.error("[SSE] Stream error:", error instanceof Error ? error.message : error);
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

    // GET /api/health - Test all external services
    if (url.pathname === "/api/health" && request.method === "GET") {
      const results: Record<string, { ok: boolean; message: string; latency?: number }> = {};

      // Test 1: Google Custom Search API
      try {
        const start = Date.now();
        const searchFn = searchImages(env);
        const searchResult = await searchFn({ query: "Elon Musk" });
        const latency = Date.now() - start;
        results.googleSearch = {
          ok: searchResult.results && searchResult.results.length > 0,
          message: `Found ${searchResult.results?.length || 0} images`,
          latency,
        };
      } catch (e) {
        results.googleSearch = {
          ok: false,
          message: e instanceof Error ? e.message : String(e),
        };
      }

      // Test 2: AWS Rekognition
      try {
        const start = Date.now();
        const rekognitionClient = new CelebrityRekognitionClient({
          region: env.AWS_REGION || "us-east-1",
          accessKeyId: env.AWS_ACCESS_KEY_ID,
          secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
        });
        // Use a well-known public image of a celebrity
        const testImageUrl = "https://upload.wikimedia.org/wikipedia/commons/thumb/3/34/Elon_Musk_Royal_Society_%28crop2%29.jpg/440px-Elon_Musk_Royal_Society_%28crop2%29.jpg";
        const rekResult = await rekognitionClient.detectCelebrities(testImageUrl);
        const latency = Date.now() - start;
        const foundElon = rekResult.celebrities?.some((c: { name: string }) =>
          c.name.toLowerCase().includes("elon") || c.name.toLowerCase().includes("musk")
        );
        results.awsRekognition = {
          ok: rekResult.celebrities && rekResult.celebrities.length > 0,
          message: foundElon
            ? `Detected ${rekResult.celebrities.length} celebrities including Elon Musk`
            : `Detected ${rekResult.celebrities?.length || 0} celebrities (Elon not found)`,
          latency,
        };
      } catch (e) {
        results.awsRekognition = {
          ok: false,
          message: e instanceof Error ? e.message : String(e),
        };
      }

      // Test 3: OpenRouter (Gemini)
      try {
        const start = Date.now();
        const openRouterClient = new OpenRouterClient({
          apiKey: env.OPENROUTER_API_KEY,
          model: "google/gemini-2.0-flash-001",
        });
        const parseResult = await openRouterClient.parseQuery("Elon Musk to Beyonce");
        const latency = Date.now() - start;
        results.openRouter = {
          ok: parseResult.isValid && !!parseResult.personA && !!parseResult.personB,
          message: parseResult.isValid
            ? `Parsed: ${parseResult.personA} → ${parseResult.personB}`
            : `Failed to parse: ${parseResult.reason || "unknown"}`,
          latency,
        };
      } catch (e) {
        results.openRouter = {
          ok: false,
          message: e instanceof Error ? e.message : String(e),
        };
      }

      // Overall status
      const allOk = Object.values(results).every(r => r.ok);

      return new Response(JSON.stringify({
        status: allOk ? "healthy" : "degraded",
        services: results,
        timestamp: new Date().toISOString(),
      }, null, 2), {
        status: allOk ? 200 : 503,
        headers: { "Content-Type": "application/json", ...corsHeaders }
      });
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
      service: "Connected? Worker",
      version: "1.0.0",
      endpoints: [
        "GET /api/health",
        "POST /api/chat/parse",
        "POST /api/chat/query",
        "GET /api/chat/stream/:runId (SSE)",
        "GET /api/chat/events/:runId",
        "GET /api/chat/status/:instanceId",
        "GET /api/graph",
        "GET /api/graph/stats",
        "GET /api/graph/path?from=Person+A&to=Person+B",
        "GET /api/graph/ws (WebSocket)"
      ]
    }), {
      status: 200,
      headers: { "Content-Type": "application/json", ...corsHeaders }
    });
  }
};
