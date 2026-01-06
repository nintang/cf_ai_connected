"use client";

import { useEffect, useRef, useState, useCallback, useImperativeHandle, forwardRef } from "react";
import Graph from "graphology";
import Sigma from "sigma";
import { circular } from "graphology-layout";
import forceAtlas2 from "graphology-layout-forceatlas2";
import { fetchGraph } from "@/lib/api-client";
import { Button } from "@/components/ui/button";
import { ZoomIn, ZoomOut, Maximize2, ExternalLink, RefreshCw, Loader2 } from "lucide-react";

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

    // Store highlight sets in refs for use in reducers
    const highlightedNodesRef = useRef<Set<string>>(new Set());
    const highlightedEdgesRef = useRef<Set<string>>(new Set());

    // Update refs when props change
    useEffect(() => {
      highlightedNodesRef.current = highlightedNodeIds || new Set();
      highlightedEdgesRef.current = highlightedEdgeKeys || new Set();
      sigmaRef.current?.refresh();
    }, [highlightedNodeIds, highlightedEdgeKeys]);

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
            graph.addEdge(edge.source, edge.target, {
              size: Math.max(1, edge.confidence / 25),
              color: `rgba(99, 102, 241, ${Math.max(0.3, edge.confidence / 100)})`,
              confidence: edge.confidence,
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
          if (attrs.contextUrl) {
            window.open(attrs.contextUrl, "_blank");
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

    // Zoom controls
    const handleZoomIn = () => {
      sigmaRef.current?.getCamera().animatedZoom({ duration: 300 });
    };

    const handleZoomOut = () => {
      sigmaRef.current?.getCamera().animatedUnzoom({ duration: 300 });
    };

    const handleReset = () => {
      sigmaRef.current?.getCamera().animatedReset({ duration: 300 });
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
        <div className={`absolute ${compact ? "top-2 right-2" : "top-4 right-4"} z-10 bg-white/90 backdrop-blur-sm rounded-lg px-2 py-1.5 text-xs border border-zinc-200 shadow-sm`}>
          <span className="text-zinc-900 font-medium">{stats.nodes}</span>
          <span className="text-zinc-400 ml-1">people</span>
          <span className="text-zinc-300 mx-1.5">·</span>
          <span className="text-zinc-900 font-medium">{stats.edges}</span>
          <span className="text-zinc-400 ml-1">connections</span>
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
      </div>
    );
  }
);
