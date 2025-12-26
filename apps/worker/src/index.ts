import { Env } from './env';
export { InvestigationWorkflow } from './workflows/investigation';

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    
    if (url.pathname === "/api/chat/query" && request.method === "POST") {
      try {
        const body = await request.json() as any;
        const { personA, personB } = body;
        
        if (!personA || !personB) {
          return new Response("Missing personA or personB", { status: 400 });
        }

        // Trigger the workflow
        const instance = await env.INVESTIGATION_WORKFLOW.create({
          params: { personA, personB }
        });

        return new Response(JSON.stringify({ 
          id: instance.id,
          status: "started" 
        }), {
          headers: { "Content-Type": "application/json" }
        });
      } catch (e) {
        return new Response(`Error: ${e instanceof Error ? e.message : String(e)}`, { status: 500 });
      }
    }

    // Status polling endpoint
    if (url.pathname.startsWith("/api/chat/status/") && request.method === "GET") {
      const id = url.pathname.split("/").pop();
      if (!id) return new Response("Missing ID", { status: 400 });

      try {
        const instance = await env.INVESTIGATION_WORKFLOW.get(id);
        const status = await instance.status();
        
        // Note: Workflow return value is only available after completion
        // For now we just return the status and error/success state
        return new Response(JSON.stringify({
          id,
          status: status.status,
          error: status.error,
          output: status.output 
        }), {
          headers: { "Content-Type": "application/json" }
        });
      } catch (e) {
        return new Response("Instance not found", { status: 404 });
      }
    }

    return new Response("Visual Degrees Worker", { status: 200 });
  }
};

