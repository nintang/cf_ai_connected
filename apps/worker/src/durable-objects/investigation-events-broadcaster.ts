import { DurableObject } from "cloudflare:workers";
import type { InvestigationEvent } from "@visual-degrees/contracts";

interface WebSocketMessage {
  type: "event" | "complete" | "ping" | "pong" | "replay";
  data?: InvestigationEvent;
  index?: number;
  cursor?: number;
}

interface StoredEvent {
  event: InvestigationEvent;
  index: number;
}

/**
 * InvestigationEventsBroadcaster Durable Object
 *
 * Manages WebSocket connections for real-time investigation event streaming.
 * Unlike GraphBroadcaster (singleton), this creates one instance per runId
 * to isolate event streams per investigation.
 *
 * Features:
 * - Hibernatable WebSockets (DO can sleep while clients stay connected)
 * - Event buffering in DO storage for replay to late-joining clients
 * - Automatic cleanup via alarm after investigation completes
 */
export class InvestigationEventsBroadcaster extends DurableObject {
  private eventIndex: number = 0;
  private isComplete: boolean = false;

  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env);
    // Restore state on hibernation wake-up
    this.ctx.blockConcurrencyWhile(async () => {
      const stored = await this.ctx.storage.get<number>("eventIndex");
      this.eventIndex = stored ?? 0;
      const complete = await this.ctx.storage.get<boolean>("isComplete");
      this.isComplete = complete ?? false;
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // WebSocket upgrade for client connections
    if (request.headers.get("Upgrade") === "websocket") {
      return this.handleWebSocketUpgrade(request);
    }

    // POST /emit - Workflow emits events here
    if (url.pathname === "/emit" && request.method === "POST") {
      return this.handleEmit(request);
    }

    // GET /status - Check connection count and state
    if (url.pathname === "/status" && request.method === "GET") {
      return this.handleStatus();
    }

    return new Response("Not Found", { status: 404 });
  }

  private async handleWebSocketUpgrade(request: Request): Promise<Response> {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    // Get cursor from query param (for replay from specific point)
    const url = new URL(request.url);
    const cursorParam = url.searchParams.get("cursor");
    const cursor = cursorParam ? parseInt(cursorParam, 10) : 0;

    // Accept with hibernation support
    this.ctx.acceptWebSocket(server);

    // Send buffered events since cursor (replay for late joiners or reconnects)
    await this.sendBufferedEvents(server, cursor);

    return new Response(null, { status: 101, webSocket: client });
  }

  private async handleEmit(request: Request): Promise<Response> {
    try {
      const event = (await request.json()) as InvestigationEvent;

      // Store event with sequential index
      const index = this.eventIndex++;
      await this.ctx.storage.put(`event:${index}`, { event, index } satisfies StoredEvent);
      await this.ctx.storage.put("eventIndex", this.eventIndex);

      // Check for completion events
      if (event.type === "final" || event.type === "no_path" || event.type === "error") {
        this.isComplete = true;
        await this.ctx.storage.put("isComplete", true);
        // Schedule cleanup after 1 hour
        await this.ctx.storage.setAlarm(Date.now() + 3600 * 1000);
      }

      // Broadcast to all connected WebSockets
      const message = JSON.stringify({
        type: "event",
        data: event,
        index,
      } satisfies WebSocketMessage);

      const sockets = this.ctx.getWebSockets();
      for (const ws of sockets) {
        try {
          ws.send(message);
        } catch {
          // Connection dead, will be cleaned up by hibernation handlers
        }
      }

      return Response.json({
        success: true,
        index,
        clients: sockets.length,
      });
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? error.message : "Unknown error" },
        { status: 400 }
      );
    }
  }

  private async sendBufferedEvents(ws: WebSocket, fromCursor: number): Promise<void> {
    // Send all events from cursor to current index
    for (let i = fromCursor; i < this.eventIndex; i++) {
      const stored = await this.ctx.storage.get<StoredEvent>(`event:${i}`);
      if (stored) {
        try {
          ws.send(
            JSON.stringify({
              type: "event",
              data: stored.event,
              index: stored.index,
            } satisfies WebSocketMessage)
          );
        } catch {
          // Connection died during replay
          return;
        }
      }
    }

    // If investigation is complete, send completion signal
    if (this.isComplete) {
      try {
        ws.send(JSON.stringify({ type: "complete" } satisfies WebSocketMessage));
      } catch {
        // Ignore
      }
    }
  }

  private handleStatus(): Response {
    return Response.json({
      eventIndex: this.eventIndex,
      isComplete: this.isComplete,
      connectedClients: this.ctx.getWebSockets().length,
    });
  }

  // Hibernation handlers - called when DO wakes from hibernation
  async webSocketMessage(ws: WebSocket, message: string): Promise<void> {
    try {
      const parsed = JSON.parse(message) as WebSocketMessage;

      if (parsed.type === "ping") {
        ws.send(JSON.stringify({ type: "pong" } satisfies WebSocketMessage));
      }

      // Client can request replay from specific cursor
      if (parsed.type === "replay" && typeof parsed.cursor === "number") {
        await this.sendBufferedEvents(ws, parsed.cursor);
      }
    } catch {
      // Ignore malformed messages
    }
  }

  async webSocketClose(_ws: WebSocket): Promise<void> {
    // Automatic cleanup by runtime - no action needed
  }

  async webSocketError(_ws: WebSocket): Promise<void> {
    // Automatic cleanup by runtime - no action needed
  }

  // Cleanup alarm - delete all stored events after TTL
  async alarm(): Promise<void> {
    await this.ctx.storage.deleteAll();
  }
}
