"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import Graph from "graphology";
import Sigma from "sigma";
import { circular } from "graphology-layout";
import forceAtlas2 from "graphology-layout-forceatlas2";
import { fetchGraph } from "@/lib/api-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { EvidenceImageModal } from "@/components/ui/evidence-image-modal";
import { useGraphSubscription, GraphEdgeUpdate } from "@/hooks/use-graph-subscription";
import { RefreshCw, ZoomIn, ZoomOut, Maximize2, Loader2, ExternalLink, Search, X, Wifi, WifiOff } from "lucide-react";

// Animation duration for smooth transitions
const ANIMATION_DURATION = 500;

// Muted color palette - 4 sophisticated colors
const NODE_COLORS = [
  "#6366f1", // indigo - primary
  "#8b5cf6", // violet
  "#0ea5e9", // sky blue
  "#10b981", // emerald
];

function getNodeColor(index: number): string {
  return NODE_COLORS[index % NODE_COLORS.length];
}

// Node sizing
const NODE_SIZE_DEFAULT = 5;
const NODE_SIZE_FOCUS = 8;
const NODE_SIZE_HOVER_MULTIPLIER = 1.3;

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
  const [previewModal, setPreviewModal] = useState<{
    open: boolean;
    url: string;
    thumbnailUrl?: string;
    title?: string;
  }>({ open: false, url: "" });
  const fullGraphDataRef = useRef<Awaited<ReturnType<typeof fetchGraph>> | null>(null);
  const focusedNodeRef = useRef<string | null>(null);

  // Keep focusedNodeRef in sync
  useEffect(() => {
    focusedNodeRef.current = focusedNode;
  }, [focusedNode]);

  // Handle real-time edge updates from WebSocket
  const handleEdgeUpdate = useCallback((edge: GraphEdgeUpdate) => {
    // Update fullGraphDataRef with new edge
    if (fullGraphDataRef.current) {
      const data = fullGraphDataRef.current;

      // Add nodes if they don't exist
      if (!data.nodes.find(n => n.id === edge.source)) {
        data.nodes.push({ id: edge.source, name: edge.source, thumbnailUrl: null });
        setAllNodes(prev => [...prev, { id: edge.source, name: edge.source }]);
      }
      if (!data.nodes.find(n => n.id === edge.target)) {
        data.nodes.push({ id: edge.target, name: edge.target, thumbnailUrl: null });
        setAllNodes(prev => [...prev, { id: edge.target, name: edge.target }]);
      }

      // Add edge if it doesn't exist
      const existingEdge = data.edges.find(
        e => (e.source === edge.source && e.target === edge.target) ||
             (e.source === edge.target && e.target === edge.source)
      );
      if (!existingEdge) {
        data.edges.push({
          id: `${edge.source}-${edge.target}`,
          source: edge.source,
          target: edge.target,
          confidence: edge.confidence,
          evidenceUrl: null,
          thumbnailUrl: edge.thumbnailUrl || null,
          contextUrl: edge.contextUrl || null,
        });
      }
    }

    // Update the graph directly for smooth real-time updates
    const graph = graphRef.current;
    const sigma = sigmaRef.current;
    if (!graph || !sigma) return;

    // Check if we should show this edge (depends on focus state)
    const currentFocus = focusedNodeRef.current;
    if (currentFocus) {
      // In focus mode - only add if edge connects to focused node
      const isConnectedToFocus = edge.source === currentFocus || edge.target === currentFocus;
      if (!isConnectedToFocus) return;
    }

    // Add source node if it doesn't exist
    if (!graph.hasNode(edge.source)) {
      const nodeCount = graph.order;
      graph.addNode(edge.source, {
        label: edge.source,
        size: NODE_SIZE_DEFAULT,
        color: getNodeColor(nodeCount),
        x: Math.random() * 100,
        y: Math.random() * 100,
      });
    }

    // Add target node if it doesn't exist
    if (!graph.hasNode(edge.target)) {
      const nodeCount = graph.order;
      graph.addNode(edge.target, {
        label: edge.target,
        size: NODE_SIZE_DEFAULT,
        color: getNodeColor(nodeCount),
        x: Math.random() * 100,
        y: Math.random() * 100,
      });
    }

    // Add edge if it doesn't exist
    if (!graph.hasEdge(edge.source, edge.target) && !graph.hasEdge(edge.target, edge.source)) {
      const edgeSize = Math.max(1, edge.confidence / 25);
      graph.addEdge(edge.source, edge.target, {
        size: edgeSize,
        baseSize: edgeSize,
        color: `rgba(156, 163, 175, ${edge.confidence / 100})`,
        confidence: edge.confidence,
        thumbnailUrl: edge.thumbnailUrl,
        contextUrl: edge.contextUrl,
      });

      // Re-apply force layout
      if (graph.order > 1) {
        const settings = forceAtlas2.inferSettings(graph);
        forceAtlas2.assign(graph, {
          settings: { ...settings, gravity: 1 },
          iterations: 50
        });
      }

      // Update stats
      const newStats = { nodes: graph.order, edges: graph.size };
      setStats(newStats);
      onStatsChange?.(newStats);

      sigma.refresh();
    }
  }, [onStatsChange]);

  // Subscribe to real-time graph updates via WebSocket
  const { isConnected: wsConnected } = useGraphSubscription({
    onEdgeUpdate: handleEdgeUpdate,
    enabled: true,
  });

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
        size: isFocusNode ? NODE_SIZE_FOCUS : NODE_SIZE_DEFAULT,
        color: getNodeColor(index),
        x: isFocusNode ? 50 : Math.random() * 100,
        y: isFocusNode ? 50 : Math.random() * 100,
        thumbnailUrl: node.thumbnailUrl,
      });
    });

    // Add edges with attributes - thicker edges for mobile touch
    const isMobileDevice = typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches;
    filteredEdges.forEach((edge) => {
      if (graph.hasNode(edge.source) && graph.hasNode(edge.target)) {
        // Make edges thicker on mobile for easier touch
        const baseEdgeSize = isMobileDevice ? 3 : 1.5;
        const edgeSize = Math.max(baseEdgeSize, edge.confidence / (isMobileDevice ? 20 : 30));
        graph.addEdge(edge.source, edge.target, {
          size: edgeSize,
          baseSize: edgeSize,
          color: `rgba(100, 116, 139, ${0.4 + (edge.confidence / 200)})`, // More visible: slate color with higher opacity
          confidence: edge.confidence,
          thumbnailUrl: edge.thumbnailUrl,
          evidenceUrl: edge.evidenceUrl, // Full-res image
          contextUrl: edge.contextUrl,
        });
      }
    });

    // Size nodes by connection count (degree)
    graph.forEachNode((node) => {
      const degree = graph.degree(node);
      const baseSize = graph.getNodeAttribute(node, "size") || NODE_SIZE_DEFAULT;
      // Scale size: more connections = slightly larger (max 2x)
      const sizeMultiplier = 1 + Math.min(degree * 0.15, 1);
      graph.setNodeAttribute(node, "size", baseSize * sizeMultiplier);
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
      renderLabels: !compact, // Hide labels in compact mode by default
      labelSize: 12,
      labelWeight: "500",
      labelColor: { color: "#27272a" },
      defaultEdgeType: "line",
      labelRenderedSizeThreshold: compact ? 100 : 0, // In compact mode, only show labels for very large nodes (effectively none)
      zoomToSizeRatioFunction: () => 1,
      enableEdgeEvents: true,
      // Increase edge picking distance for easier touch on mobile
      edgeLabelSize: 12,
      // @ts-expect-error - pickingDistance is a valid sigma option
      pickingDistance: 15, // Larger hit area for edges (default is ~5)
      // Node reducer - show labels on hover in compact mode, dim non-connected nodes
      nodeReducer: (node, data) => {
        const res = { ...data };
        const hovered = hoveredNodeRef.current;

        if (hovered) {
          if (node === hovered) {
            // Hovered node - highlight and show label
            res.size = (data.size || NODE_SIZE_DEFAULT) * NODE_SIZE_HOVER_MULTIPLIER;
            res.zIndex = 10;
            res.forceLabel = true; // Force show label on hover
          } else if (hoveredNeighborsRef.current.has(node)) {
            // Connected neighbor - keep visible, show label in compact mode
            res.zIndex = 5;
            if (compact) res.forceLabel = true;
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
          res.size = Math.max(data.size || 1, 4);
          return res;
        }

        if (hovered) {
          const source = graph.source(edge);
          const target = graph.target(edge);

          if (source === hovered || target === hovered) {
            // Edge connected to hovered node - highlight
            res.color = "#6366f1";
            res.size = Math.max(data.size || 1, 2.5);
          } else {
            // Not connected - dim
            res.color = "rgba(156, 163, 175, 0.15)";
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
      sigma.refresh();
    });

    sigma.on("leaveNode", () => {
      hoveredNodeRef.current = null;
      hoveredNeighborsRef.current = new Set();
      setHoveredNode(null);
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
      sigma.refresh();
    });

    sigma.on("leaveEdge", () => {
      hoveredEdgeRef.current = null;
      setHoveredEdge(null);
      sigma.refresh();
    });

    sigma.on("clickEdge", ({ edge }) => {
      // Open evidence image in preview modal
      const attrs = graph.getEdgeAttributes(edge);
      const source = graph.source(edge);
      const target = graph.target(edge);
      const sourceAttrs = graph.getNodeAttributes(source);
      const targetAttrs = graph.getNodeAttributes(target);

      setPreviewModal({
        open: true,
        url: attrs.contextUrl,
        // Use full-res evidenceUrl if available, fallback to thumbnail
        thumbnailUrl: attrs.evidenceUrl || attrs.thumbnailUrl || undefined,
        title: `${sourceAttrs.label} ↔ ${targetAttrs.label}`,
      });
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

  // Zoom controls with smooth animations
  const handleZoomIn = () => {
    if (sigmaRef.current) {
      const camera = sigmaRef.current.getCamera();
      camera.animatedZoom({ duration: ANIMATION_DURATION });
    }
  };

  const handleZoomOut = () => {
    if (sigmaRef.current) {
      const camera = sigmaRef.current.getCamera();
      camera.animatedUnzoom({ duration: ANIMATION_DURATION });
    }
  };

  const handleReset = () => {
    if (sigmaRef.current) {
      const camera = sigmaRef.current.getCamera();
      camera.animatedReset({ duration: ANIMATION_DURATION });
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
              <span className="text-zinc-300">·</span>
              {wsConnected ? (
                <span className="flex items-center gap-1 text-emerald-600" title="Live updates active">
                  <Wifi className="h-3 w-3" />
                </span>
              ) : (
                <span className="flex items-center gap-1 text-zinc-400" title="Connecting...">
                  <WifiOff className="h-3 w-3" />
                </span>
              )}
            </div>
          ) : (
            <div className="flex items-center gap-1 sm:gap-1.5 text-zinc-500 whitespace-nowrap">
              <span className="text-zinc-900 font-medium">{stats.nodes}</span>
              <span className="hidden xs:inline">people</span>
              <span className="text-zinc-300">·</span>
              <span className="text-zinc-900 font-medium">{stats.edges}</span>
              <span className="hidden xs:inline">connections</span>
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
        style={{
          minHeight: "min(500px, 60vh)",
          cursor: hoveredEdge || hoveredNode ? "pointer" : isDragging ? "grabbing" : "grab"
        }}
      />

      {/* Evidence Image Modal */}
      <EvidenceImageModal
        open={previewModal.open}
        onOpenChange={(open: boolean) => setPreviewModal((prev) => ({ ...prev, open }))}
        imageUrl={previewModal.thumbnailUrl}
        sourceUrl={previewModal.url}
        title={previewModal.title}
      />
    </div>
  );
}
