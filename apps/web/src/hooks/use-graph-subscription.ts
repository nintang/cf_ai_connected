"use client";

import { useEffect, useRef, useCallback, useState } from "react";

const WORKER_URL = process.env.NEXT_PUBLIC_WORKER_URL || "http://localhost:8787";

// Convert HTTP URL to WebSocket URL
function getWebSocketUrl(): string {
  const url = new URL(WORKER_URL);
  const protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${url.host}/api/graph/ws`;
}

export interface GraphEdgeUpdate {
  source: string;
  target: string;
  confidence: number;
  evidenceUrl?: string;
  thumbnailUrl?: string;
  contextUrl?: string;
}

interface WebSocketMessage {
  type: "edge_update" | "pong";
  data?: GraphEdgeUpdate;
}

interface UseGraphSubscriptionOptions {
  /** Called when a new edge is received */
  onEdgeUpdate?: (edge: GraphEdgeUpdate) => void;
  /** Whether to auto-reconnect on disconnect (default: true) */
  autoReconnect?: boolean;
  /** Reconnection delay in ms (default: 3000) */
  reconnectDelay?: number;
  /** Enable the subscription (default: true) */
  enabled?: boolean;
}

interface UseGraphSubscriptionResult {
  /** Whether the WebSocket is currently connected */
  isConnected: boolean;
  /** Any connection error */
  error: string | null;
  /** Manually disconnect */
  disconnect: () => void;
  /** Manually reconnect */
  reconnect: () => void;
}

/**
 * Hook to subscribe to real-time graph edge updates via WebSocket
 */
export function useGraphSubscription(
  options: UseGraphSubscriptionOptions = {}
): UseGraphSubscriptionResult {
  const {
    onEdgeUpdate,
    autoReconnect = true,
    reconnectDelay = 3000,
    enabled = true,
  } = options;

  const [isConnected, setIsConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const pingIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const onEdgeUpdateRef = useRef(onEdgeUpdate);

  // Keep callback ref updated
  useEffect(() => {
    onEdgeUpdateRef.current = onEdgeUpdate;
  }, [onEdgeUpdate]);

  const cleanup = useCallback(() => {
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }
    if (pingIntervalRef.current) {
      clearInterval(pingIntervalRef.current);
      pingIntervalRef.current = null;
    }
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
  }, []);

  const connect = useCallback(() => {
    if (!enabled) return;

    cleanup();

    try {
      const wsUrl = getWebSocketUrl();
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        setIsConnected(true);
        setError(null);

        // Start ping interval to keep connection alive
        pingIntervalRef.current = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "ping" }));
          }
        }, 30000); // Ping every 30 seconds
      };

      ws.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data) as WebSocketMessage;

          if (message.type === "edge_update" && message.data) {
            onEdgeUpdateRef.current?.(message.data);
          }
          // Ignore pong messages
        } catch {
          // Ignore malformed messages
        }
      };

      ws.onclose = () => {
        setIsConnected(false);

        if (pingIntervalRef.current) {
          clearInterval(pingIntervalRef.current);
          pingIntervalRef.current = null;
        }

        // Auto-reconnect if enabled
        if (autoReconnect && enabled) {
          reconnectTimeoutRef.current = setTimeout(() => {
            connect();
          }, reconnectDelay);
        }
      };

      ws.onerror = () => {
        setError("WebSocket connection error");
        setIsConnected(false);
      };
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to connect");
      setIsConnected(false);
    }
  }, [enabled, autoReconnect, reconnectDelay, cleanup]);

  const disconnect = useCallback(() => {
    cleanup();
    setIsConnected(false);
  }, [cleanup]);

  const reconnect = useCallback(() => {
    cleanup();
    connect();
  }, [cleanup, connect]);

  // Connect on mount, disconnect on unmount
  useEffect(() => {
    if (enabled) {
      connect();
    }
    return cleanup;
  }, [enabled, connect, cleanup]);

  return {
    isConnected,
    error,
    disconnect,
    reconnect,
  };
}
