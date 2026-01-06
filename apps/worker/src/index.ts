import { Env } from './env';
import { InvestigationEvent, EventsResponse } from '@visual-degrees/contracts';
import { OpenRouterClient } from '@visual-degrees/integrations';
export { InvestigationWorkflow } from './workflows/investigation';

// CORS headers for cross-origin requests from the frontend
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

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
        const body = await request.json() as any;
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

    return new Response(JSON.stringify({
      service: "Visual Degrees Worker",
      version: "1.0.0",
      endpoints: [
        "POST /api/chat/parse",
        "POST /api/chat/query",
        "GET /api/chat/events/:runId",
        "GET /api/chat/status/:instanceId"
      ]
    }), { 
      status: 200,
      headers: { "Content-Type": "application/json", ...corsHeaders }
    });
  }
};
