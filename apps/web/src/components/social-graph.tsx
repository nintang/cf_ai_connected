"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import Graph from "graphology";
import Sigma from "sigma";
import { circular } from "graphology-layout";
import forceAtlas2 from "graphology-layout-forceatlas2";
import { fetchGraph } from "@/lib/api-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { RefreshCw, ZoomIn, ZoomOut, Maximize2, Loader2, ExternalLink, Search, X } from "lucide-react";

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

function getNodeColor(index: number): string {
  return NODE_COLORS[index % NODE_COLORS.length];
}

interface SocialGraphProps {
  className?: string;
  compact?: boolean;
  onStatsChange?: (stats: { nodes: number; edges: number }) => void;
  /** When true, the graph will auto-refresh every few seconds to pick up new edges */
  autoRefresh?: boolean;
  /** Auto-refresh interval in milliseconds (default: 3000) */
  autoRefreshInterval?: number;
}

export function SocialGraph({ className, compact = false, onStatsChange, autoRefresh = false, autoRefreshInterval = 3000 }: SocialGraphProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const sigmaRef = useRef<Sigma | null>(null);
  const graphRef = useRef<Graph | null>(null);
  const hoveredEdgeRef = useRef<string | null>(null);
  const hoveredNodeRef = useRef<string | null>(null);
  const hoveredNeighborsRef = useRef<Set<string>>(new Set());

  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [stats, setStats] = useState({ nodes: 0, edges: 0 });
  const [selectedNode, setSelectedNode] = useState<string | null>(null);
  const [hoveredNode, setHoveredNode] = useState<string | null>(null);
  const [hoveredEdge, setHoveredEdge] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [allNodes, setAllNodes] = useState<Array<{ id: string; name: string }>>([]);
  const [focusedNode, setFocusedNode] = useState<string | null>(null);
  const fullGraphDataRef = useRef<Awaited<ReturnType<typeof fetchGraph>> | null>(null);

  // Render graph with optional focus node filter
  const renderGraph = useCallback((data: Awaited<ReturnType<typeof fetchGraph>>, focusNodeId: string | null) => {
    if (!containerRef.current) return;

    // Create or clear the graph
    const graph = new Graph();
    graphRef.current = graph;

    // If focusing on a node, filter to only show that node and its neighbors
    let filteredNodes = data.nodes;
    let filteredEdges = data.edges;

    if (focusNodeId) {
      // Find edges connected to the focus node
      const connectedNodeIds = new Set<string>([focusNodeId]);
      data.edges.forEach((edge) => {
        if (edge.source === focusNodeId) connectedNodeIds.add(edge.target);
        if (edge.target === focusNodeId) connectedNodeIds.add(edge.source);
      });

      filteredNodes = data.nodes.filter((n) => connectedNodeIds.has(n.id));
      filteredEdges = data.edges.filter(
        (e) => connectedNodeIds.has(e.source) && connectedNodeIds.has(e.target)
      );
    }

    // Add nodes with attributes
    filteredNodes.forEach((node, index) => {
      const isFocusNode = node.id === focusNodeId;
      graph.addNode(node.id, {
        label: node.name,
        size: isFocusNode ? 20 : 15,
        color: getNodeColor(index),
        x: isFocusNode ? 50 : Math.random() * 100,
        y: isFocusNode ? 50 : Math.random() * 100,
        thumbnailUrl: node.thumbnailUrl,
      });
    });

    // Add edges with attributes
    filteredEdges.forEach((edge) => {
      if (graph.hasNode(edge.source) && graph.hasNode(edge.target)) {
        graph.addEdge(edge.source, edge.target, {
          size: Math.max(1, edge.confidence / 25),
          color: `rgba(156, 163, 175, ${edge.confidence / 100})`,
          confidence: edge.confidence,
          thumbnailUrl: edge.thumbnailUrl,
          contextUrl: edge.contextUrl,
        });
      }
    });

    // Apply layouts
    if (graph.order > 0) {
      // Start with circular layout
      circular.assign(graph);

      // Then apply force-directed layout
      if (graph.order > 1) {
        const settings = forceAtlas2.inferSettings(graph);
        forceAtlas2.assign(graph, {
          settings: { ...settings, gravity: 1 },
          iterations: 100
        });
      }
    }

    // Clean up existing sigma instance
    if (sigmaRef.current) {
      sigmaRef.current.kill();
    }

    // Create new sigma instance
    const sigma = new Sigma(graph, containerRef.current, {
      renderLabels: true,
      labelSize: 14,
      labelWeight: "bold",
      labelColor: { color: "#18181b" },
      defaultEdgeType: "line",
      labelRenderedSizeThreshold: 0,
      zoomToSizeRatioFunction: () => 1,
      enableEdgeEvents: true,
      // Node reducer - dim nodes not connected to hovered node
      nodeReducer: (node, data) => {
        const res = { ...data };
        const hovered = hoveredNodeRef.current;

        if (hovered) {
          if (node === hovered) {
            // Hovered node - highlight
            res.size = (data.size || 15) * 1.3;
            res.zIndex = 10;
          } else if (hoveredNeighborsRef.current.has(node)) {
            // Connected neighbor - keep visible
            res.zIndex = 5;
          } else {
            // Not connected - dim
            res.color = data.color + "40"; // 25% opacity
            res.label = "";
            res.zIndex = 0;
          }
        }

        return res;
      },
      // Edge reducer - dim edges not connected to hovered node
      edgeReducer: (edge, data) => {
        const res = { ...data };
        const hovered = hoveredNodeRef.current;

        // Highlight hovered edge
        if (edge === hoveredEdgeRef.current) {
          res.color = "#6366f1";
          res.size = Math.max(data.size || 1, 3);
          return res;
        }

        if (hovered) {
          const source = graph.source(edge);
          const target = graph.target(edge);

          if (source === hovered || target === hovered) {
            // Edge connected to hovered node - highlight
            res.color = "#6366f1";
            res.size = Math.max(data.size || 1, 2);
          } else {
            // Not connected - dim
            res.color = "rgba(156, 163, 175, 0.1)";
          }
        }

        return res;
      },
    });

    sigmaRef.current = sigma;

    // Set up hover/click handlers
    sigma.on("enterNode", ({ node }) => {
      hoveredNodeRef.current = node;
      hoveredNeighborsRef.current = new Set(graph.neighbors(node));
      setHoveredNode(node);
      document.body.style.cursor = "pointer";
      sigma.refresh();
    });

    sigma.on("leaveNode", () => {
      hoveredNodeRef.current = null;
      hoveredNeighborsRef.current = new Set();
      setHoveredNode(null);
      document.body.style.cursor = "default";
      sigma.refresh();
    });

    sigma.on("clickNode", ({ node }) => {
      setSelectedNode(node);
    });

    sigma.on("clickStage", () => {
      setSelectedNode(null);
    });

    // Edge events
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
      // Open context URL if available
      const attrs = graph.getEdgeAttributes(edge);
      if (attrs.contextUrl) {
        window.open(attrs.contextUrl, "_blank");
      }
    });

    // Drag cursor events
    sigma.on("downStage", () => {
      setIsDragging(true);
    });

    sigma.on("upStage", () => {
      setIsDragging(false);
    });

    const newStats = { nodes: graph.order, edges: graph.size };
    setStats(newStats);
    onStatsChange?.(newStats);
  }, [onStatsChange]);

  // Load graph data from API
  const loadGraph = useCallback(async () => {
    if (!containerRef.current) return;

    setIsLoading(true);
    setError(null);

    try {
      const data = await fetchGraph();
      fullGraphDataRef.current = data;

      // Store all nodes for search (from full data)
      const nodeList: Array<{ id: string; name: string }> = [];
      data.nodes.forEach((node) => {
        nodeList.push({ id: node.id, name: node.name });
      });
      setAllNodes(nodeList);

      // Render the full graph initially
      renderGraph(data, null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load graph");
    } finally {
      setIsLoading(false);
    }
  }, [renderGraph]);

  // Initial load
  useEffect(() => {
    loadGraph();

    return () => {
      if (sigmaRef.current) {
        sigmaRef.current.kill();
      }
    };
  }, [loadGraph]);

  // Auto-refresh when enabled (e.g., during investigation)
  useEffect(() => {
    if (!autoRefresh) return;

    const intervalId = setInterval(() => {
      loadGraph();
    }, autoRefreshInterval);

    return () => {
      clearInterval(intervalId);
    };
  }, [autoRefresh, autoRefreshInterval, loadGraph]);

  // Zoom controls
  const handleZoomIn = () => {
    if (sigmaRef.current) {
      const camera = sigmaRef.current.getCamera();
      camera.animatedZoom({ duration: 300 });
    }
  };

  const handleZoomOut = () => {
    if (sigmaRef.current) {
      const camera = sigmaRef.current.getCamera();
      camera.animatedUnzoom({ duration: 300 });
    }
  };

  const handleReset = () => {
    if (sigmaRef.current) {
      const camera = sigmaRef.current.getCamera();
      camera.animatedReset({ duration: 300 });
    }
  };

  // Get node info for display
  const getNodeInfo = (nodeId: string | null) => {
    if (!nodeId || !graphRef.current) return null;
    const attrs = graphRef.current.getNodeAttributes(nodeId);
    const neighbors = graphRef.current.neighbors(nodeId);
    return {
      name: attrs.label,
      connections: neighbors.length,
      thumbnailUrl: attrs.thumbnailUrl,
    };
  };

  // Get edge info for display
  const getEdgeInfo = (edgeId: string | null) => {
    if (!edgeId || !graphRef.current) return null;
    const attrs = graphRef.current.getEdgeAttributes(edgeId);
    const source = graphRef.current.source(edgeId);
    const target = graphRef.current.target(edgeId);
    const sourceAttrs = graphRef.current.getNodeAttributes(source);
    const targetAttrs = graphRef.current.getNodeAttributes(target);
    return {
      sourceName: sourceAttrs.label,
      targetName: targetAttrs.label,
      confidence: attrs.confidence,
      thumbnailUrl: attrs.thumbnailUrl,
      contextUrl: attrs.contextUrl,
    };
  };

  const activeNodeInfo = getNodeInfo(selectedNode || hoveredNode);
  const activeEdgeInfo = getEdgeInfo(hoveredEdge);

  // Filter nodes for search
  const filteredNodes = searchQuery
    ? allNodes.filter((n) =>
        n.name.toLowerCase().includes(searchQuery.toLowerCase())
      )
    : [];

  // Focus on a node - shows only that person and their connections
  const focusNode = (nodeId: string) => {
    if (!fullGraphDataRef.current) return;
    setFocusedNode(nodeId);
    setSearchQuery("");
    renderGraph(fullGraphDataRef.current, nodeId);
  };

  // Show all nodes (clear focus filter)
  const showAllNodes = () => {
    if (!fullGraphDataRef.current) return;
    setFocusedNode(null);
    renderGraph(fullGraphDataRef.current, null);
  };

  return (
    <div className={`relative flex flex-col h-full ${className || ""}`}>
      {/* Search bar - hidden in compact mode */}
      {!compact && (
        <div className="absolute top-3 sm:top-4 left-2 right-2 sm:left-1/2 sm:right-auto sm:-translate-x-1/2 z-10 sm:w-72 max-w-[calc(100%-1rem)]">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-zinc-400" />
            <Input
              type="text"
              placeholder="Search people..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-9 pr-8 bg-white/95 backdrop-blur-sm border-zinc-200 shadow-sm text-sm h-9 sm:h-10"
            />
            {searchQuery && (
              <button
                onClick={() => setSearchQuery("")}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-zinc-400 hover:text-zinc-600"
              >
                <X className="h-4 w-4" />
              </button>
            )}
          </div>
          {/* Search results dropdown */}
          {filteredNodes.length > 0 && (
            <div className="absolute top-full left-0 right-0 mt-1 bg-white/95 backdrop-blur-sm border border-zinc-200 rounded-lg shadow-lg max-h-40 sm:max-h-48 overflow-y-auto">
              {filteredNodes.slice(0, 10).map((node) => (
                <button
                  key={node.id}
                  onClick={() => focusNode(node.id)}
                  className="w-full text-left px-3 py-2 text-xs sm:text-sm hover:bg-zinc-100 first:rounded-t-lg last:rounded-b-lg"
                >
                  {node.name}
                </button>
              ))}
              {filteredNodes.length > 10 && (
                <div className="px-3 py-2 text-xs text-zinc-400">
                  +{filteredNodes.length - 10} more
                </div>
              )}
            </div>
          )}
          {searchQuery && filteredNodes.length === 0 && (
            <div className="absolute top-full left-0 right-0 mt-1 bg-white/95 backdrop-blur-sm border border-zinc-200 rounded-lg shadow-lg px-3 py-2 text-xs sm:text-sm text-zinc-500">
              No people found
            </div>
          )}
        </div>
      )}

      {/* Controls */}
      <div className={`absolute ${compact ? "top-2 left-2" : "top-14 sm:top-4 left-2 sm:left-4"} z-10 flex gap-1`}>
        <Button
          variant="secondary"
          size="icon"
          onClick={loadGraph}
          disabled={isLoading}
          title="Refresh"
          className={compact ? "h-7 w-7" : "h-8 w-8 sm:h-10 sm:w-10"}
        >
          {isLoading ? (
            <Loader2 className={`${compact ? "h-3 w-3" : "h-3.5 w-3.5 sm:h-4 sm:w-4"} animate-spin`} />
          ) : (
            <RefreshCw className={compact ? "h-3 w-3" : "h-3.5 w-3.5 sm:h-4 sm:w-4"} />
          )}
        </Button>
        <Button
          variant="secondary"
          size="icon"
          onClick={handleZoomIn}
          title="Zoom in"
          className={compact ? "h-7 w-7" : "h-8 w-8 sm:h-10 sm:w-10"}
        >
          <ZoomIn className={compact ? "h-3 w-3" : "h-3.5 w-3.5 sm:h-4 sm:w-4"} />
        </Button>
        <Button
          variant="secondary"
          size="icon"
          onClick={handleZoomOut}
          title="Zoom out"
          className={compact ? "h-7 w-7" : "h-8 w-8 sm:h-10 sm:w-10"}
        >
          <ZoomOut className={compact ? "h-3 w-3" : "h-3.5 w-3.5 sm:h-4 sm:w-4"} />
        </Button>
        <Button
          variant="secondary"
          size="icon"
          onClick={handleReset}
          title="Reset view"
          className={compact ? "h-7 w-7" : "h-8 w-8 sm:h-10 sm:w-10"}
        >
          <Maximize2 className={compact ? "h-3 w-3" : "h-3.5 w-3.5 sm:h-4 sm:w-4"} />
        </Button>
      </div>

      {/* Stats & Focus indicator - hidden in compact mode (shown in header) */}
      {!compact && (
        <div className="absolute top-14 sm:top-4 right-2 sm:right-4 z-10 bg-white/90 backdrop-blur-sm rounded-lg px-2 py-1 sm:py-1.5 text-[10px] sm:text-xs border border-zinc-200 shadow-sm">
          {focusedNode ? (
            <div className="flex items-center gap-1.5 sm:gap-2 min-w-0">
              <span className="text-zinc-500 truncate min-w-0 max-w-[100px] sm:max-w-none">
                <span className="text-zinc-900 font-medium">{allNodes.find(n => n.id === focusedNode)?.name}</span>
              </span>
              <button
                onClick={showAllNodes}
                className="text-indigo-600 hover:text-indigo-700 font-medium shrink-0"
              >
                All
              </button>
            </div>
          ) : (
            <div className="text-zinc-500 whitespace-nowrap">
              <span className="text-zinc-900 font-medium">{stats.nodes}</span>
              <span className="ml-0.5 sm:ml-1 hidden xs:inline">people</span>
              <span className="mx-1 sm:mx-1.5 text-zinc-300">·</span>
              <span className="text-zinc-900 font-medium">{stats.edges}</span>
              <span className="ml-0.5 sm:ml-1 hidden xs:inline">connections</span>
            </div>
          )}
        </div>
      )}

      {/* Node info tooltip */}
      {activeNodeInfo && !activeEdgeInfo && (
        <div className="absolute bottom-2 sm:bottom-4 left-2 sm:left-4 right-2 sm:right-auto z-10 bg-white/95 backdrop-blur-sm rounded-lg p-2.5 sm:p-4 sm:max-w-xs border border-zinc-200 shadow-sm">
          <div className="font-semibold text-zinc-900 text-sm sm:text-base truncate">{activeNodeInfo.name}</div>
          <div className="text-xs sm:text-sm text-zinc-500 mt-0.5 sm:mt-1">
            {activeNodeInfo.connections} connection{activeNodeInfo.connections !== 1 ? "s" : ""}
          </div>
        </div>
      )}

      {/* Edge info tooltip with evidence image */}
      {activeEdgeInfo && (
        <div className="absolute bottom-2 sm:bottom-4 left-2 sm:left-4 right-2 sm:right-auto z-10 bg-white/95 backdrop-blur-sm rounded-lg overflow-hidden sm:max-w-sm border border-zinc-200 shadow-lg">
          {/* Evidence image */}
          {activeEdgeInfo.thumbnailUrl && (
            <div className="relative w-full aspect-video bg-zinc-100 max-h-32 sm:max-h-none">
              <img
                src={activeEdgeInfo.thumbnailUrl}
                alt="Evidence"
                className="w-full h-full object-cover"
                onError={(e) => {
                  // Hide broken images
                  (e.target as HTMLImageElement).style.display = "none";
                }}
              />
            </div>
          )}

          {/* Edge details */}
          <div className="p-2.5 sm:p-4">
            <div className="font-semibold text-zinc-900 text-xs sm:text-sm truncate">
              {activeEdgeInfo.sourceName} ↔ {activeEdgeInfo.targetName}
            </div>
            <div className="flex items-center gap-2 mt-1.5 sm:mt-2 flex-wrap">
              <div className="text-[10px] sm:text-xs text-zinc-500">
                Confidence: <span className="font-medium text-zinc-700">{Math.round(activeEdgeInfo.confidence)}%</span>
              </div>
              {activeEdgeInfo.contextUrl && (
                <a
                  href={activeEdgeInfo.contextUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-[10px] sm:text-xs text-indigo-600 hover:text-indigo-700"
                  onClick={(e) => e.stopPropagation()}
                >
                  <ExternalLink className="h-3 w-3" />
                  View source
                </a>
              )}
            </div>
            {!activeEdgeInfo.thumbnailUrl && (
              <div className="text-[10px] sm:text-xs text-zinc-400 mt-1.5 sm:mt-2">Click edge to open source</div>
            )}
          </div>
        </div>
      )}

      {/* Loading state */}
      {isLoading && (
        <div className="absolute inset-0 flex items-center justify-center bg-white/80 z-20">
          <div className="flex flex-col items-center gap-2 sm:gap-3">
            <Loader2 className="h-6 w-6 sm:h-8 sm:w-8 animate-spin text-indigo-500" />
            <span className="text-zinc-500 text-sm sm:text-base">Loading graph...</span>
          </div>
        </div>
      )}

      {/* Error state */}
      {error && (
        <div className="absolute inset-0 flex items-center justify-center bg-white/80 z-20 p-4">
          <div className="text-center">
            <div className="text-red-500 mb-2 text-sm sm:text-base">{error}</div>
            <Button variant="secondary" size="sm" onClick={loadGraph}>
              Try again
            </Button>
          </div>
        </div>
      )}

      {/* Empty state */}
      {!isLoading && !error && stats.nodes === 0 && (
        <div className="absolute inset-0 flex items-center justify-center z-20 p-4">
          <div className="text-center max-w-md">
            <div className="text-zinc-600 text-base sm:text-lg mb-1 sm:mb-2">No connections yet</div>
            <div className="text-zinc-500 text-xs sm:text-sm">
              Run some investigations to discover connections between people.
              Each verified connection will appear here in the social graph.
            </div>
          </div>
        </div>
      )}

      {/* Graph container */}
      <div
        ref={containerRef}
        className="flex-1 w-full bg-zinc-50"
        style={{ minHeight: "min(500px, 60vh)", cursor: isDragging ? "grabbing" : "grab" }}
      />
    </div>
  );
}
