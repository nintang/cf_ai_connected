import { DurableObject } from "cloudflare:workers";

export interface GraphEdgeUpdate {
  source: string;
  target: string;
  confidence: number;
  evidenceUrl?: string;
  thumbnailUrl?: string;
  contextUrl?: string;
}

interface WebSocketMessage {
  type: "edge_update" | "ping" | "pong";
  data?: GraphEdgeUpdate;
}

/**
 * GraphBroadcaster Durable Object
 *
 * Manages WebSocket connections for real-time graph updates.
 * When new edges are discovered during investigations, they are
 * broadcast to all connected clients immediately.
 */
export class GraphBroadcaster extends DurableObject {
  private sessions: Set<WebSocket> = new Set();

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // WebSocket upgrade request
    if (request.headers.get("Upgrade") === "websocket") {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);

      // Accept the WebSocket connection
      this.ctx.acceptWebSocket(server);
      this.sessions.add(server);

      // Handle incoming messages (for ping/pong keepalive)
      server.addEventListener("message", (event) => {
        try {
          const message = JSON.parse(event.data as string) as WebSocketMessage;
          if (message.type === "ping") {
            server.send(JSON.stringify({ type: "pong" }));
          }
        } catch {
          // Ignore malformed messages
        }
      });

      // Clean up on close
      server.addEventListener("close", () => {
        this.sessions.delete(server);
      });

      server.addEventListener("error", () => {
        this.sessions.delete(server);
      });

      return new Response(null, { status: 101, webSocket: client });
    }

    // HTTP endpoint for broadcasting new edges (called by workflow)
    if (url.pathname === "/broadcast" && request.method === "POST") {
      try {
        const edge = (await request.json()) as GraphEdgeUpdate;
        this.broadcast(edge);
        return new Response(JSON.stringify({ success: true, clients: this.sessions.size }), {
          headers: { "Content-Type": "application/json" },
        });
      } catch (error) {
        return new Response(
          JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }),
          { status: 400, headers: { "Content-Type": "application/json" } }
        );
      }
    }

    // Status endpoint
    if (url.pathname === "/status" && request.method === "GET") {
      return new Response(
        JSON.stringify({ connectedClients: this.sessions.size }),
        { headers: { "Content-Type": "application/json" } }
      );
    }

    return new Response("Not Found", { status: 404 });
  }

  /**
   * Broadcast an edge update to all connected WebSocket clients
   */
  private broadcast(edge: GraphEdgeUpdate): void {
    const message = JSON.stringify({
      type: "edge_update",
      data: edge,
    } satisfies WebSocketMessage);

    const deadSessions: WebSocket[] = [];

    for (const ws of this.sessions) {
      try {
        ws.send(message);
      } catch {
        // Connection is dead, mark for removal
        deadSessions.push(ws);
      }
    }

    // Clean up dead sessions
    for (const ws of deadSessions) {
      this.sessions.delete(ws);
    }
  }

  /**
   * Handle WebSocket hibernation (Cloudflare Durable Objects feature)
   * This is called when a WebSocket reconnects after hibernation
   */
  async webSocketMessage(ws: WebSocket, message: string): Promise<void> {
    try {
      const parsed = JSON.parse(message) as WebSocketMessage;
      if (parsed.type === "ping") {
        ws.send(JSON.stringify({ type: "pong" }));
      }
    } catch {
      // Ignore malformed messages
    }
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    this.sessions.delete(ws);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    this.sessions.delete(ws);
  }
}
