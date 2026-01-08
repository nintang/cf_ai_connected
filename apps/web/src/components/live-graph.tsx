"use client";

import { useEffect, useRef, useState, useCallback, useImperativeHandle, forwardRef } from "react";
import Graph from "graphology";
import Sigma from "sigma";
import { circular } from "graphology-layout";
import forceAtlas2 from "graphology-layout-forceatlas2";
import { fetchGraph } from "@/lib/api-client";
import { Button } from "@/components/ui/button";
import { EvidenceImageModal } from "@/components/ui/evidence-image-modal";
import { useGraphSubscription, GraphEdgeUpdate } from "@/hooks/use-graph-subscription";
import { ZoomIn, ZoomOut, Maximize2, ExternalLink, RefreshCw, Loader2, Wifi, WifiOff } from "lucide-react";

// Animation utilities
const ANIMATION_DURATION = 500;
const PULSE_DURATION = 400; // Reduced for less flickering

// Debounce sigma refresh to prevent flickering
function createDebouncedRefresh(delay = 50) {
  let timeoutId: NodeJS.Timeout | null = null;
  return (sigma: Sigma | null) => {
    if (!sigma) return;
    if (timeoutId) clearTimeout(timeoutId);
    timeoutId = setTimeout(() => {
      sigma.refresh();
    }, delay);
  };
}

// Pulse animation for highlighting new connections - uses requestAnimationFrame for smoother animation
function pulseNodes(
  graph: Graph,
  sigma: Sigma,
  nodeIds: string[],
  baseSize: number,
  debouncedRefresh: (sigma: Sigma | null) => void
): void {
  const startTime = performance.now();

  function animate(currentTime: number) {
    const elapsed = currentTime - startTime;
    const progress = Math.min(elapsed / PULSE_DURATION, 1);

    // Smooth pulse: grows then shrinks back
    const scale = 1 + 0.3 * Math.sin(progress * Math.PI);

    nodeIds.forEach((nodeId) => {
      if (!graph.hasNode(nodeId)) return;
      graph.setNodeAttribute(nodeId, "size", baseSize * scale);
    });

    if (progress < 1) {
      requestAnimationFrame(animate);
    } else {
      // Reset to base size at end
      nodeIds.forEach((nodeId) => {
        if (!graph.hasNode(nodeId)) return;
        graph.setNodeAttribute(nodeId, "size", baseSize);
      });
    }
    debouncedRefresh(sigma);
  }

  requestAnimationFrame(animate);
}

// Pulse animation for edges - uses requestAnimationFrame for smoother animation
function pulseEdges(
  graph: Graph,
  sigma: Sigma,
  edgeIds: string[],
  debouncedRefresh: (sigma: Sigma | null) => void
): void {
  const startTime = performance.now();

  function animate(currentTime: number) {
    const elapsed = currentTime - startTime;
    const progress = Math.min(elapsed / PULSE_DURATION, 1);

    // Smooth pulse: grows then shrinks back
    const scale = 1 + 0.8 * Math.sin(progress * Math.PI);

    edgeIds.forEach((edgeId) => {
      if (!graph.hasEdge(edgeId)) return;
      const baseSize = graph.getEdgeAttribute(edgeId, "baseSize") || 1;
      graph.setEdgeAttribute(edgeId, "size", baseSize * scale);
    });

    if (progress < 1) {
      requestAnimationFrame(animate);
    } else {
      // Reset to base size at end
      edgeIds.forEach((edgeId) => {
        if (!graph.hasEdge(edgeId)) return;
        const baseSize = graph.getEdgeAttribute(edgeId, "baseSize") || 1;
        graph.setEdgeAttribute(edgeId, "size", baseSize);
      });
    }
    debouncedRefresh(sigma);
  }

  requestAnimationFrame(animate);
}

// Color palette for nodes
const NODE_COLORS = [
  "#6366f1", // indigo
  "#8b5cf6", // violet
  "#ec4899", // pink
  "#f43f5e", // rose
  "#f97316", // orange
  "#eab308", // yellow
  "#22c55e", // green
  "#14b8a6", // teal
  "#06b6d4", // cyan
  "#3b82f6", // blue
];

function getNodeColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = ((hash << 5) - hash) + name.charCodeAt(i);
    hash = hash & hash;
  }
  return NODE_COLORS[Math.abs(hash) % NODE_COLORS.length];
}

export interface LiveGraphNode {
  id: string;
  name: string;
  thumbnailUrl?: string | null;
}

export interface LiveGraphEdge {
  id: string;
  source: string;
  target: string;
  confidence: number;
  thumbnailUrl?: string | null;
  contextUrl?: string | null;
}

export interface LiveGraphHandle {
  refresh: () => void;
  highlightNodes: (nodeIds: Set<string>) => void;
  highlightEdges: (edgeIds: Set<string>) => void;
}

interface LiveGraphProps {
  className?: string;
  compact?: boolean;
  // Current investigation nodes/edges to highlight
  highlightedNodeIds?: Set<string>;
  highlightedEdgeKeys?: Set<string>; // Format: "sourceId_targetId"
}

export const LiveGraph = forwardRef<LiveGraphHandle, LiveGraphProps>(
  function LiveGraph({ className, compact = false, highlightedNodeIds, highlightedEdgeKeys }, ref) {
    const containerRef = useRef<HTMLDivElement>(null);
    const sigmaRef = useRef<Sigma | null>(null);
    const graphRef = useRef<Graph | null>(null);
    const hoveredEdgeRef = useRef<string | null>(null);

    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [stats, setStats] = useState({ nodes: 0, edges: 0 });
    const [hoveredNode, setHoveredNode] = useState<string | null>(null);
    const [hoveredEdge, setHoveredEdge] = useState<string | null>(null);
    const [previewModal, setPreviewModal] = useState<{
      open: boolean;
      imageUrl?: string;
      sourceUrl?: string;
      title?: string;
    }>({ open: false });

    // Store highlight sets in refs for use in reducers
    const highlightedNodesRef = useRef<Set<string>>(new Set());
    const highlightedEdgesRef = useRef<Set<string>>(new Set());

    // Create debounced refresh to prevent flickering
    const debouncedRefreshRef = useRef(createDebouncedRefresh(30));

    // Handle real-time edge updates from WebSocket
    const handleEdgeUpdate = useCallback((edge: GraphEdgeUpdate) => {
      const graph = graphRef.current;
      const sigma = sigmaRef.current;
      if (!graph || !sigma) return;

      const baseSize = compact ? 12 : 15;

      // Normalize node IDs (use lowercase for consistency)
      const sourceId = edge.source;
      const targetId = edge.target;

      // Add source node if it doesn't exist
      if (!graph.hasNode(sourceId)) {
        graph.addNode(sourceId, {
          label: edge.source,
          size: baseSize,
          color: getNodeColor(edge.source),
          x: Math.random() * 100,
          y: Math.random() * 100,
          originalColor: getNodeColor(edge.source),
        });
      }

      // Add target node if it doesn't exist
      if (!graph.hasNode(targetId)) {
        graph.addNode(targetId, {
          label: edge.target,
          size: baseSize,
          color: getNodeColor(edge.target),
          x: Math.random() * 100,
          y: Math.random() * 100,
          originalColor: getNodeColor(edge.target),
        });
      }

      // Add edge if it doesn't exist
      if (!graph.hasEdge(sourceId, targetId) && !graph.hasEdge(targetId, sourceId)) {
        // Position new nodes near existing connected nodes (if any)
        const existingSource = graph.hasNode(sourceId);
        const existingTarget = graph.hasNode(targetId);

        if (!existingSource && existingTarget) {
          // Position source near target
          const targetPos = graph.getNodeAttributes(targetId);
          graph.setNodeAttribute(sourceId, "x", targetPos.x + (Math.random() - 0.5) * 20);
          graph.setNodeAttribute(sourceId, "y", targetPos.y + (Math.random() - 0.5) * 20);
        } else if (existingSource && !existingTarget) {
          // Position target near source
          const sourcePos = graph.getNodeAttributes(sourceId);
          graph.setNodeAttribute(targetId, "x", sourcePos.x + (Math.random() - 0.5) * 20);
          graph.setNodeAttribute(targetId, "y", sourcePos.y + (Math.random() - 0.5) * 20);
        }

        const edgeSize = Math.max(1, edge.confidence / 25);
        graph.addEdge(sourceId, targetId, {
          size: edgeSize,
          baseSize: edgeSize,
          color: `rgba(99, 102, 241, ${Math.max(0.3, edge.confidence / 100)})`,
          confidence: edge.confidence,
          thumbnailUrl: edge.thumbnailUrl,
          contextUrl: edge.contextUrl,
          originalColor: `rgba(99, 102, 241, ${Math.max(0.3, edge.confidence / 100)})`,
        });

        // Skip force layout during live updates - just position new nodes near connected ones
        // This prevents the whole graph from jumping around

        // Trigger pulse animation for the new nodes and edge
        pulseNodes(graph, sigma, [sourceId, targetId], baseSize, debouncedRefreshRef.current);
        const edgeId = graph.edge(sourceId, targetId);
        if (edgeId) {
          pulseEdges(graph, sigma, [edgeId], debouncedRefreshRef.current);
        }

        // Update stats
        setStats({ nodes: graph.order, edges: graph.size });

        debouncedRefreshRef.current(sigma);
      }
    }, [compact]);

    // Subscribe to real-time graph updates via WebSocket
    const { isConnected: wsConnected } = useGraphSubscription({
      onEdgeUpdate: handleEdgeUpdate,
      enabled: true,
    });

    // Update refs when props change and trigger pulse animation
    useEffect(() => {
      const prevNodes = highlightedNodesRef.current;
      const prevEdges = highlightedEdgesRef.current;
      const newNodes = highlightedNodeIds || new Set();
      const newEdges = highlightedEdgeKeys || new Set();

      // Find newly added nodes and edges
      const addedNodes = [...newNodes].filter((id) => !prevNodes.has(id));
      const addedEdges = [...newEdges].filter((id) => !prevEdges.has(id));

      // Only update if something actually changed
      const nodesChanged = newNodes.size !== prevNodes.size || addedNodes.length > 0;
      const edgesChanged = newEdges.size !== prevEdges.size || addedEdges.length > 0;

      if (!nodesChanged && !edgesChanged) return;

      highlightedNodesRef.current = newNodes;
      highlightedEdgesRef.current = newEdges;
      debouncedRefreshRef.current(sigmaRef.current);

      // Trigger pulse animation for newly highlighted nodes
      if (addedNodes.length > 0 && graphRef.current && sigmaRef.current) {
        const baseSize = compact ? 12 : 15;
        pulseNodes(graphRef.current, sigmaRef.current, addedNodes, baseSize * 1.2, debouncedRefreshRef.current);
      }

      // Trigger pulse animation for newly highlighted edges
      if (addedEdges.length > 0 && graphRef.current && sigmaRef.current) {
        // Find actual edge IDs from edge keys
        const graph = graphRef.current;
        const edgeIds: string[] = [];
        addedEdges.forEach((edgeKey) => {
          const [source, target] = edgeKey.split("_");
          if (graph.hasEdge(source, target)) {
            edgeIds.push(graph.edge(source, target) as string);
          } else if (graph.hasEdge(target, source)) {
            edgeIds.push(graph.edge(target, source) as string);
          }
        });
        if (edgeIds.length > 0) {
          pulseEdges(graphRef.current, sigmaRef.current, edgeIds, debouncedRefreshRef.current);
        }
      }
    }, [highlightedNodeIds, highlightedEdgeKeys, compact]);

    // Load graph from database
    const loadGraph = useCallback(async () => {
      if (!containerRef.current) return;

      setIsLoading(true);
      setError(null);

      try {
        const data = await fetchGraph();

        // Clean up existing sigma
        if (sigmaRef.current) {
          sigmaRef.current.kill();
        }

        const graph = new Graph();
        graphRef.current = graph;

        // Add nodes from database
        data.nodes.forEach((node) => {
          if (!graph.hasNode(node.id)) {
            graph.addNode(node.id, {
              label: node.name,
              size: compact ? 12 : 15,
              color: getNodeColor(node.name),
              x: Math.random() * 100,
              y: Math.random() * 100,
              thumbnailUrl: node.thumbnailUrl,
              originalColor: getNodeColor(node.name),
            });
          }
        });

        // Add edges from database
        data.edges.forEach((edge) => {
          if (graph.hasNode(edge.source) && graph.hasNode(edge.target) && !graph.hasEdge(edge.source, edge.target)) {
            const edgeSize = Math.max(1, edge.confidence / 25);
            graph.addEdge(edge.source, edge.target, {
              size: edgeSize,
              baseSize: edgeSize, // Store base size for pulse animations
              color: `rgba(99, 102, 241, ${Math.max(0.3, edge.confidence / 100)})`,
              confidence: edge.confidence,
              evidenceUrl: edge.evidenceUrl,
              thumbnailUrl: edge.thumbnailUrl,
              contextUrl: edge.contextUrl,
              originalColor: `rgba(99, 102, 241, ${Math.max(0.3, edge.confidence / 100)})`,
            });
          }
        });

        // Apply layout
        if (graph.order > 0) {
          circular.assign(graph);
          if (graph.order > 1) {
            const settings = forceAtlas2.inferSettings(graph);
            forceAtlas2.assign(graph, {
              settings: { ...settings, gravity: 1 },
              iterations: 100
            });
          }
        }

        // Create sigma instance with reducers for highlighting
        const sigma = new Sigma(graph, containerRef.current, {
          renderLabels: true,
          labelSize: compact ? 11 : 14,
          labelWeight: "bold",
          labelColor: { color: "#18181b" },
          defaultEdgeType: "line",
          labelRenderedSizeThreshold: 0,
          zoomToSizeRatioFunction: () => 1,
          enableEdgeEvents: true,
          // Increase edge picking distance for easier touch on mobile
          // @ts-expect-error - pickingDistance is a valid sigma option
          pickingDistance: 15, // Larger hit area for edges (default is ~5)
          // Node reducer - highlight current investigation nodes
          nodeReducer: (node, data) => {
            const res = { ...data };
            const hasHighlights = highlightedNodesRef.current.size > 0;

            if (hasHighlights) {
              if (highlightedNodesRef.current.has(node)) {
                // Highlighted node - use original color, slightly larger
                res.color = data.originalColor || data.color;
                res.size = (data.size || 15) * 1.2;
              } else {
                // Non-highlighted node - keep original color but reduce opacity via alpha
                const originalColor = data.originalColor || data.color;
                res.color = originalColor + "80"; // Add 50% alpha
                res.size = (data.size || 15) * 0.8;
              }
            }

            return res;
          },
          // Edge reducer - highlight current investigation edges
          edgeReducer: (edge, data) => {
            const res = { ...data };
            const graph = graphRef.current;
            if (!graph) return res;

            const source = graph.source(edge);
            const target = graph.target(edge);
            const edgeKey1 = `${source}_${target}`;
            const edgeKey2 = `${target}_${source}`;

            const hasHighlights = highlightedEdgesRef.current.size > 0;

            // Hovered edge
            if (edge === hoveredEdgeRef.current) {
              res.color = "#6366f1";
              res.size = Math.max(data.size || 1, 3);
              return res;
            }

            if (hasHighlights) {
              if (highlightedEdgesRef.current.has(edgeKey1) || highlightedEdgesRef.current.has(edgeKey2)) {
                // Highlighted edge - bright color, thicker
                res.color = "#6366f1";
                res.size = Math.max((data.size || 1) * 1.5, 2);
              } else {
                // Non-highlighted edge - keep original color but more transparent
                res.color = "rgba(99, 102, 241, 0.15)";
                res.size = Math.max((data.size || 1) * 0.5, 0.5);
              }
            }

            return res;
          },
        });

        sigmaRef.current = sigma;

        // Event handlers
        sigma.on("enterNode", ({ node }) => {
          setHoveredNode(node);
          document.body.style.cursor = "pointer";
        });

        sigma.on("leaveNode", () => {
          setHoveredNode(null);
          document.body.style.cursor = "default";
        });

        sigma.on("enterEdge", ({ edge }) => {
          hoveredEdgeRef.current = edge;
          setHoveredEdge(edge);
          document.body.style.cursor = "pointer";
          sigma.refresh();
        });

        sigma.on("leaveEdge", () => {
          hoveredEdgeRef.current = null;
          setHoveredEdge(null);
          document.body.style.cursor = "default";
          sigma.refresh();
        });

        sigma.on("clickEdge", ({ edge }) => {
          const attrs = graph.getEdgeAttributes(edge);
          if (attrs.thumbnailUrl || attrs.evidenceUrl) {
            const source = graph.source(edge);
            const target = graph.target(edge);
            const sourceAttrs = graph.getNodeAttributes(source);
            const targetAttrs = graph.getNodeAttributes(target);

            setPreviewModal({
              open: true,
              imageUrl: attrs.evidenceUrl || attrs.thumbnailUrl || undefined,
              sourceUrl: attrs.contextUrl || undefined,
              title: `${sourceAttrs.label} ↔ ${targetAttrs.label}`,
            });
          }
        });

        setStats({ nodes: graph.order, edges: graph.size });
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to load graph");
      } finally {
        setIsLoading(false);
      }
    }, [compact]);

    // Load on mount
    useEffect(() => {
      loadGraph();
      return () => {
        if (sigmaRef.current) {
          sigmaRef.current.kill();
        }
      };
    }, [loadGraph]);

    // Expose methods via ref
    useImperativeHandle(ref, () => ({
      refresh: () => {
        loadGraph();
      },
      highlightNodes: (nodeIds: Set<string>) => {
        highlightedNodesRef.current = nodeIds;
        sigmaRef.current?.refresh();
      },
      highlightEdges: (edgeIds: Set<string>) => {
        highlightedEdgesRef.current = edgeIds;
        sigmaRef.current?.refresh();
      },
    }), [loadGraph]);

    // Zoom controls with smooth animations
    const handleZoomIn = () => {
      sigmaRef.current?.getCamera().animatedZoom({ duration: ANIMATION_DURATION });
    };

    const handleZoomOut = () => {
      sigmaRef.current?.getCamera().animatedUnzoom({ duration: ANIMATION_DURATION });
    };

    const handleReset = () => {
      sigmaRef.current?.getCamera().animatedReset({ duration: ANIMATION_DURATION });
    };

    // Get edge info for tooltip
    const getEdgeInfo = (edgeId: string | null) => {
      if (!edgeId || !graphRef.current) return null;
      const graph = graphRef.current;
      const attrs = graph.getEdgeAttributes(edgeId);
      const source = graph.source(edgeId);
      const target = graph.target(edgeId);
      const sourceAttrs = graph.getNodeAttributes(source);
      const targetAttrs = graph.getNodeAttributes(target);
      return {
        sourceName: sourceAttrs.label,
        targetName: targetAttrs.label,
        confidence: attrs.confidence,
        thumbnailUrl: attrs.thumbnailUrl,
        contextUrl: attrs.contextUrl,
      };
    };

    // Get node info for tooltip
    const getNodeInfo = (nodeId: string | null) => {
      if (!nodeId || !graphRef.current) return null;
      const attrs = graphRef.current.getNodeAttributes(nodeId);
      const neighbors = graphRef.current.neighbors(nodeId);
      return {
        name: attrs.label,
        connections: neighbors.length,
      };
    };

    const activeNodeInfo = getNodeInfo(hoveredNode);
    const activeEdgeInfo = getEdgeInfo(hoveredEdge);

    return (
      <div className={`relative flex flex-col h-full bg-zinc-50 ${className || ""}`}>
        {/* Controls */}
        <div className={`absolute ${compact ? "top-2 left-2" : "top-4 left-4"} z-10 flex gap-1`}>
          <Button
            variant="secondary"
            size="icon"
            onClick={loadGraph}
            disabled={isLoading}
            title="Refresh"
            className={compact ? "h-7 w-7" : ""}
          >
            {isLoading ? (
              <Loader2 className={`${compact ? "h-3 w-3" : "h-4 w-4"} animate-spin`} />
            ) : (
              <RefreshCw className={compact ? "h-3 w-3" : "h-4 w-4"} />
            )}
          </Button>
          <Button
            variant="secondary"
            size="icon"
            onClick={handleZoomIn}
            title="Zoom in"
            className={compact ? "h-7 w-7" : ""}
          >
            <ZoomIn className={compact ? "h-3 w-3" : "h-4 w-4"} />
          </Button>
          <Button
            variant="secondary"
            size="icon"
            onClick={handleZoomOut}
            title="Zoom out"
            className={compact ? "h-7 w-7" : ""}
          >
            <ZoomOut className={compact ? "h-3 w-3" : "h-4 w-4"} />
          </Button>
          <Button
            variant="secondary"
            size="icon"
            onClick={handleReset}
            title="Reset view"
            className={compact ? "h-7 w-7" : ""}
          >
            <Maximize2 className={compact ? "h-3 w-3" : "h-4 w-4"} />
          </Button>
        </div>

        {/* Stats */}
        <div className={`absolute ${compact ? "top-2 right-2" : "top-4 right-4"} z-10 bg-white/90 backdrop-blur-sm rounded-lg px-2 py-1.5 text-xs border border-zinc-200 shadow-sm flex items-center gap-2`}>
          <span className="text-zinc-900 font-medium">{stats.nodes}</span>
          <span className="text-zinc-400">people</span>
          <span className="text-zinc-300">·</span>
          <span className="text-zinc-900 font-medium">{stats.edges}</span>
          <span className="text-zinc-400">connections</span>
          <span className="text-zinc-300">·</span>
          {wsConnected ? (
            <span className="flex items-center gap-1 text-emerald-600" title="Live updates active">
              <Wifi className="h-3 w-3" />
              <span className="hidden sm:inline">Live</span>
            </span>
          ) : (
            <span className="flex items-center gap-1 text-zinc-400" title="Connecting...">
              <WifiOff className="h-3 w-3" />
            </span>
          )}
        </div>

        {/* Node tooltip */}
        {activeNodeInfo && !activeEdgeInfo && (
          <div className="absolute bottom-2 left-2 z-10 bg-white/95 backdrop-blur-sm rounded-lg p-2 max-w-[200px] border border-zinc-200 shadow-sm">
            <div className="font-medium text-zinc-900 text-sm truncate">{activeNodeInfo.name}</div>
            <div className="text-xs text-zinc-500">
              {activeNodeInfo.connections} connection{activeNodeInfo.connections !== 1 ? "s" : ""}
            </div>
          </div>
        )}

        {/* Edge tooltip */}
        {activeEdgeInfo && (
          <div className="absolute bottom-2 left-2 z-10 bg-white/95 backdrop-blur-sm rounded-lg overflow-hidden max-w-[250px] border border-zinc-200 shadow-lg">
            {activeEdgeInfo.thumbnailUrl && (
              <div className="relative w-full aspect-video bg-zinc-100">
                <img
                  src={activeEdgeInfo.thumbnailUrl}
                  alt="Evidence"
                  className="w-full h-full object-cover"
                  onError={(e) => {
                    (e.target as HTMLImageElement).style.display = "none";
                  }}
                />
              </div>
            )}
            <div className="p-2">
              <div className="font-medium text-zinc-900 text-xs">
                {activeEdgeInfo.sourceName} ↔ {activeEdgeInfo.targetName}
              </div>
              <div className="flex items-center gap-2 mt-1">
                <span className="text-[10px] text-zinc-500">
                  {Math.round(activeEdgeInfo.confidence)}% match
                </span>
                {activeEdgeInfo.contextUrl && (
                  <a
                    href={activeEdgeInfo.contextUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-0.5 text-[10px] text-indigo-600 hover:text-indigo-700"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <ExternalLink className="h-2.5 w-2.5" />
                    Source
                  </a>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Loading state */}
        {isLoading && (
          <div className="absolute inset-0 flex items-center justify-center bg-white/80 z-20">
            <div className="flex flex-col items-center gap-2">
              <Loader2 className="h-6 w-6 animate-spin text-indigo-500" />
              <span className="text-zinc-500 text-sm">Loading graph...</span>
            </div>
          </div>
        )}

        {/* Error state */}
        {error && !isLoading && (
          <div className="absolute inset-0 flex items-center justify-center bg-white/80 z-20">
            <div className="text-center px-4">
              <div className="text-red-500 text-sm mb-2">{error}</div>
              <Button variant="secondary" size="sm" onClick={loadGraph}>
                Try again
              </Button>
            </div>
          </div>
        )}

        {/* Empty state */}
        {!isLoading && !error && stats.nodes === 0 && (
          <div className="absolute inset-0 flex items-center justify-center z-10">
            <div className="text-center px-4">
              <div className="text-zinc-400 text-sm">No connections yet</div>
              <div className="text-zinc-300 text-xs mt-1">
                Run investigations to build your graph
              </div>
            </div>
          </div>
        )}

        {/* Graph container */}
        <div
          ref={containerRef}
          className="flex-1 w-full"
        />

        {/* Evidence Image Modal */}
        <EvidenceImageModal
          open={previewModal.open}
          onOpenChange={(open) => setPreviewModal((prev) => ({ ...prev, open }))}
          imageUrl={previewModal.imageUrl}
          sourceUrl={previewModal.sourceUrl}
          title={previewModal.title}
        />
      </div>
    );
  }
);
