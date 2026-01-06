"use client"

import { useRef, useState, useCallback, useEffect } from "react"
import dynamic from "next/dynamic"
import Link from "next/link"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"
import { Search, ArrowRight, Loader2, RotateCcw, Square, Network, PanelRightClose, PanelRightOpen, Expand, Menu, X } from "lucide-react"
import { parseQuery } from "@/lib/query-parser"
import { InvestigationTracker } from "@/components/investigation/investigation-tracker"
import { useIsMobile } from "@/hooks/use-mobile"

// Dynamic import for SocialGraph (requires DOM)
const SocialGraph = dynamic(
  () => import("@/components/social-graph").then((mod) => mod.SocialGraph),
  { ssr: false }
)
import type {
  InvestigationState,
  InvestigationEvent,
  InvestigationStep,
  InvestigationStepId,
  InvestigationSegment,
  StepStatus,
} from "@/types/investigation"
import { createInitialState, STEP_TITLES } from "@/types/investigation"
import {
  startInvestigation,
  createEventPoller,
  parseQueryWithAI,
  findCachedPath,
  InvestigationEvent as WorkerEvent,
  CachedPathResult
} from "@/lib/api-client"

/**
 * Creates a unique segment ID
 */
function createSegmentId(from: string, to: string, hopDepth: number): string {
  return `${from.toLowerCase().replace(/\s+/g, '-')}-to-${to.toLowerCase().replace(/\s+/g, '-')}-h${hopDepth}`;
}

/**
 * Get unique event ID - prefer backend-provided eventId
 */
function getEventId(event: WorkerEvent): string {
  const data = event.data as Record<string, unknown> | undefined;
  if (data?.eventId) {
    return data.eventId as string;
  }
  return `${event.type}:${event.timestamp}:${event.message}`;
}

/**
 * Maps worker events to InvestigationState updates
 */
function mapWorkerEventsToState(
  events: WorkerEvent[],
  _personA: string,
  _personB: string,
  currentState: InvestigationState
): InvestigationState {
  const state = {
    ...currentState,
    steps: [...currentState.steps],
    segments: [...currentState.segments],
    currentPath: [...currentState.currentPath],
  };

  const existingEventIds = new Set(
    state.logs.map(l => l.data?.eventId as string || `${l.type}:${l.timestamp}:${l.message}`)
  );

  for (const event of events) {
    const timestamp = new Date(event.timestamp).getTime();
    const eventId = getEventId(event);

    if (existingEventIds.has(eventId)) {
      continue;
    }
    existingEventIds.add(eventId);

    const logEntry: InvestigationEvent = {
      type: event.type as InvestigationEvent["type"],
      message: event.message,
      data: event.data as InvestigationEvent["data"],
      timestamp,
    };

    state.logs = [...state.logs, logEntry];

    switch (event.type) {
      case "step_start": {
        const stepId = event.data?.stepId as InvestigationStepId;
        const stepNumber = event.data?.stepNumber || state.steps.length + 1;
        const stepTitle = event.data?.stepTitle || STEP_TITLES[stepId] || "Unknown step";
        const fromPerson = event.data?.fromPerson as string | undefined;
        const toPerson = event.data?.toPerson as string | undefined;

        const newStep: InvestigationStep = {
          id: stepId,
          number: stepNumber,
          title: stepTitle,
          status: "running",
          events: [],
          fromPerson,
          toPerson,
          startTime: timestamp,
        };

        state.steps = [...state.steps, newStep];
        state.currentStepNumber = stepNumber;

        if (fromPerson && toPerson) {
          const hopDepth = event.data?.hopDepth as number ?? state.segments.length;
          const segmentId = createSegmentId(fromPerson, toPerson, hopDepth);

          const existingSegmentIdx = state.segments.findIndex(s => s.id === segmentId);

          if (existingSegmentIdx === -1) {
            const newSegment: InvestigationSegment = {
              id: segmentId,
              from: fromPerson,
              to: toPerson,
              hopDepth,
              status: "running",
              steps: [newStep],
              startTime: timestamp,
            };
            state.segments = [...state.segments, newSegment];
            state.activeSegmentId = segmentId;
          } else {
            state.segments[existingSegmentIdx] = {
              ...state.segments[existingSegmentIdx],
              steps: [...state.segments[existingSegmentIdx].steps, newStep],
              status: "running",
            };
            state.activeSegmentId = segmentId;
          }
        }
        break;
      }

      case "step_update": {
        if (state.activeSegmentId) {
          const segmentIdx = state.segments.findIndex(s => s.id === state.activeSegmentId);
          if (segmentIdx >= 0) {
            const segment = state.segments[segmentIdx];
            const lastStepIdx = segment.steps.length - 1;
            if (lastStepIdx >= 0) {
              const existingEventInStep = segment.steps[lastStepIdx].events.some(
                e => getEventId({ type: e.type, timestamp: new Date(e.timestamp).toISOString(), message: e.message, data: e.data } as WorkerEvent) === eventId
              );
              if (!existingEventInStep) {
                segment.steps[lastStepIdx] = {
                  ...segment.steps[lastStepIdx],
                  events: [...segment.steps[lastStepIdx].events, logEntry],
                  message: event.message,
                };
              }
            }
          }
        }
        break;
      }

      case "step_complete": {
        const stepId = event.data?.stepId as InvestigationStepId;
        const stepStatus = event.data?.stepStatus as StepStatus;

        const stepIndex = state.steps.findIndex(s => s.id === stepId && s.status === "running");
        if (stepIndex >= 0) {
          state.steps[stepIndex] = {
            ...state.steps[stepIndex],
            status: stepStatus || "done",
            message: event.message,
            endTime: timestamp,
          };
        }

        if (state.activeSegmentId) {
          const segmentIdx = state.segments.findIndex(s => s.id === state.activeSegmentId);
          if (segmentIdx >= 0) {
            const segment = state.segments[segmentIdx];
            const segmentStepIdx = segment.steps.findIndex(s => s.id === stepId && s.status === "running");
            if (segmentStepIdx >= 0) {
              segment.steps[segmentStepIdx] = {
                ...segment.steps[segmentStepIdx],
                status: stepStatus || "done",
                message: event.message,
                endTime: timestamp,
              };
            }

            if (stepId === "verify_bridge" || stepId === "connect_target" || stepId === "direct_check") {
              state.segments[segmentIdx] = {
                ...segment,
                status: stepStatus === "done" ? "success" : "failed",
                endTime: timestamp,
              };
            }
          }
        }
        break;
      }

      case "image_result": {
        if (state.activeSegmentId) {
          const segmentIdx = state.segments.findIndex(s => s.id === state.activeSegmentId);
          if (segmentIdx >= 0) {
            const segment = state.segments[segmentIdx];
            const lastStepIdx = segment.steps.length - 1;
            if (lastStepIdx >= 0) {
              const existingEventInStep = segment.steps[lastStepIdx].events.some(
                e => getEventId({ type: e.type, timestamp: new Date(e.timestamp).toISOString(), message: e.message, data: e.data } as WorkerEvent) === eventId
              );
              if (!existingEventInStep) {
                segment.steps[lastStepIdx] = {
                  ...segment.steps[lastStepIdx],
                  events: [...segment.steps[lastStepIdx].events, logEntry],
                };
              }
            }
          }
        }
        break;
      }

      case "evidence": {
        if (event.data?.edge) {
          const { edge } = event.data;
          const evidenceItem = {
            id: `e${state.evidence.length + 1}`,
            from: edge.from,
            to: edge.to,
            thumbnailUrl: edge.thumbnailUrl || "",
            sourceUrl: edge.contextUrl || "",
            confidence: edge.confidence,
            description: `${edge.from} and ${edge.to}`,
          };
          state.evidence = [...state.evidence, evidenceItem];

          const segmentIdx = state.segments.findIndex(s =>
            s.from === edge.from && s.to === edge.to
          );
          if (segmentIdx >= 0) {
            state.segments[segmentIdx] = {
              ...state.segments[segmentIdx],
              evidence: evidenceItem,
              status: "success",
            };
          }
        }
        break;
      }

      case "path_update": {
        if (event.data?.path) {
          const pathArray = event.data.path as string[];
          state.currentPath = pathArray;

          const pathHops = [];
          for (let i = 0; i < pathArray.length - 1; i++) {
            const evidence = state.evidence.find(
              e => e.from === pathArray[i] && e.to === pathArray[i + 1]
            );
            pathHops.push({
              from: pathArray[i],
              to: pathArray[i + 1],
              confidence: evidence?.confidence || 95,
            });
          }
          state.path = pathHops;
        }
        break;
      }

      case "backtrack": {
        if (event.data?.path) {
          state.currentPath = event.data.path as string[];
        }
        break;
      }

      case "final": {
        state.status = "completed";
        if (event.data?.result) {
          const result = event.data.result as { edges?: Array<{ from: string; to: string; edgeConfidence: number }> };
          if (result.edges) {
            state.path = result.edges.map((edge) => ({
              from: edge.from,
              to: edge.to,
              confidence: edge.edgeConfidence,
            }));
          }
        }
        break;
      }

      case "no_path":
        state.status = "failed";
        break;

      case "error":
        state.status = "failed";
        break;
    }
  }

  return state;
}

export function InvestigationApp() {
  const [query, setQuery] = useState("")
  const [isLoading, setIsLoading] = useState(false)
  const [investigationState, setInvestigationState] = useState<InvestigationState | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [showGraph, setShowGraph] = useState(true)
  const [graphWidth, setGraphWidth] = useState(400)
  const [isResizing, setIsResizing] = useState(false)
  const stopPollingRef = useRef<(() => void) | null>(null)
  const [cachedPath, setCachedPath] = useState<CachedPathResult | null>(null)
  const [graphStats, setGraphStats] = useState({ nodes: 0, edges: 0 })
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)
  const isMobile = useIsMobile()

  // On mobile, graph should be hidden by default during investigation
  useEffect(() => {
    if (isMobile && investigationState) {
      setShowGraph(false)
    }
  }, [isMobile, investigationState])

  // Handle resize drag (supports both mouse and touch)
  const handleResizeStart = useCallback((e: React.MouseEvent | React.TouchEvent) => {
    e.preventDefault()
    setIsResizing(true)

    const isTouch = 'touches' in e
    const startX = isTouch ? e.touches[0].clientX : e.clientX
    const startWidth = graphWidth

    const handleMove = (e: MouseEvent | TouchEvent) => {
      const clientX = 'touches' in e ? e.touches[0].clientX : e.clientX
      const delta = startX - clientX
      const newWidth = Math.min(Math.max(startWidth + delta, 250), 800)
      setGraphWidth(newWidth)
    }

    const handleEnd = () => {
      setIsResizing(false)
      document.removeEventListener('mousemove', handleMove)
      document.removeEventListener('mouseup', handleEnd)
      document.removeEventListener('touchmove', handleMove)
      document.removeEventListener('touchend', handleEnd)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }

    document.addEventListener('mousemove', handleMove)
    document.addEventListener('mouseup', handleEnd)
    document.addEventListener('touchmove', handleMove, { passive: false })
    document.addEventListener('touchend', handleEnd)
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
  }, [graphWidth])

  // Run a fresh investigation (no cache)
  const runFreshInvestigation = useCallback(async (personA: string, personB: string) => {
    const initialState = createInitialState(personA, personB);
    setInvestigationState(initialState);
    setCachedPath(null);
    setError(null);

    try {
      const response = await startInvestigation(personA, personB);
      const { runId } = response;

      stopPollingRef.current = createEventPoller(
        runId,
        (events, complete) => {
          setInvestigationState(prev => {
            if (!prev) return prev;
            return mapWorkerEventsToState(events, personA, personB, prev);
          });

          if (complete) {
            setIsLoading(false);
          }
        },
        (err) => {
          console.error("Polling error:", err);
          setInvestigationState(prev => {
            if (!prev) return prev;
            const errorLog: InvestigationEvent = {
              type: "error",
              message: `Error: ${err.message}`,
              timestamp: Date.now()
            };
            return {
              ...prev,
              status: "failed" as const,
              logs: [...prev.logs, errorLog]
            };
          });
          setIsLoading(false);
        },
        500
      );
    } catch (err) {
      console.error("Failed to start investigation:", err);
      const errorLog: InvestigationEvent = {
        type: "error",
        message: `Failed to connect: ${err instanceof Error ? err.message : 'Unknown error'}`,
        timestamp: Date.now()
      };
      setInvestigationState(prev => {
        if (!prev) return prev;
        return {
          ...prev,
          status: "failed" as const,
          logs: [...prev.logs, errorLog]
        };
      });
      setIsLoading(false);
    }
  }, []);

  // Main investigation function - checks cache first
  const runInvestigation = useCallback(async (personA: string, personB: string) => {
    setError(null);
    setCachedPath(null);

    try {
      // First, check if we have a cached path
      const cached = await findCachedPath(personA, personB);

      if (cached.found) {
        // Found a cached path - show it immediately
        setCachedPath(cached);

        // Create a state that shows the cached result
        const cachedState = createInitialState(personA, personB);
        cachedState.status = "completed";
        cachedState.currentPath = cached.path;

        // Build the path array (hop-by-hop with confidence) that FinalPath expects
        cachedState.path = cached.steps.map((step) => ({
          from: step.fromName,
          to: step.toName,
          confidence: step.confidence,
        }));

        // Add evidence from cached steps
        cachedState.evidence = cached.steps.map((step, index) => ({
          id: `cached-${index}`,
          from: step.fromName,
          to: step.toName,
          confidence: step.confidence,
          thumbnailUrl: step.thumbnailUrl || "",
          sourceUrl: step.contextUrl || "",
          description: `${step.fromName} photographed with ${step.toName}`,
        }));

        // Add a log entry for the cached result
        cachedState.logs = [{
          type: "final",
          message: `Found cached ${cached.hops}-hop connection with ${Math.round(cached.minConfidence)}% confidence`,
          timestamp: Date.now(),
          data: {
            path: cached.path,
            hopDepth: cached.hops,
          }
        }];

        setInvestigationState(cachedState);
        setIsLoading(false);
        return;
      }

      // No cached path found - run fresh investigation
      runFreshInvestigation(personA, personB);
    } catch (err) {
      console.warn("Cache lookup failed, running fresh investigation:", err);
      // If cache lookup fails, just run the investigation
      runFreshInvestigation(personA, personB);
    }
  }, [runFreshInvestigation]);

  const handleSubmit = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!query.trim()) return;

    // Stop any existing polling
    if (stopPollingRef.current) {
      stopPollingRef.current();
      stopPollingRef.current = null;
    }

    const userQuery = query.trim();
    setIsLoading(true);
    setError(null);

    try {
      const parsed = await parseQueryWithAI(userQuery);

      if (parsed.isValid && parsed.personA && parsed.personB) {
        runInvestigation(parsed.personA, parsed.personB);
      } else {
        setError(parsed.reason || "Please enter two people to connect, like 'Elon Musk to Beyonce'");
        setIsLoading(false);
      }
    } catch (err) {
      console.warn("AI parsing failed, falling back to regex:", err);
      const regexParsed = parseQuery(userQuery);

      if (regexParsed.isValid) {
        runInvestigation(regexParsed.personA, regexParsed.personB);
      } else {
        setError("Please enter two people to connect, like 'Elon Musk to Beyonce'");
        setIsLoading(false);
      }
    }
  };

  const handleStop = () => {
    if (stopPollingRef.current) {
      stopPollingRef.current();
      stopPollingRef.current = null;
    }
    // Mark the investigation as stopped but keep the results
    setInvestigationState(prev => {
      if (!prev) return prev;
      return {
        ...prev,
        status: "failed" as const,
        logs: [...prev.logs, {
          type: "error" as const,
          message: "Investigation stopped by user",
          timestamp: Date.now()
        }]
      };
    });
    setIsLoading(false);
  };

  const handleNewSearch = () => {
    if (stopPollingRef.current) {
      stopPollingRef.current();
      stopPollingRef.current = null;
    }
    setInvestigationState(null);
    setCachedPath(null);
    setQuery("");
    setError(null);
    setIsLoading(false);
  };

  return (
    <div className="h-screen bg-background flex flex-col overflow-hidden">
      {/* Header */}
      <header className="border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60 shrink-0 z-50">
        <div className="px-3 sm:px-6 py-2 sm:py-3 flex items-center justify-between gap-2 sm:gap-4">
          {/* Logo and nav */}
          <div className="flex items-center gap-2 sm:gap-3 shrink-0">
            <div className="bg-primary/10 size-8 sm:size-9 rounded-lg flex items-center justify-center">
              <Search className="size-3.5 sm:size-4 text-primary" />
            </div>
            <h1 className="text-base sm:text-lg font-semibold tracking-tight hidden xs:block">Visual Degrees</h1>
            <div className="hidden sm:block h-5 w-px bg-border ml-2" />
            <Link href="/graph" className="hidden sm:block">
              <Button variant="ghost" size="sm" className="gap-2 text-muted-foreground hover:text-foreground">
                <Network className="size-4" />
                Graph
              </Button>
            </Link>
          </div>

          {/* Search bar in header when investigation is active - hidden on mobile */}
          {investigationState && (
            <form onSubmit={handleSubmit} className="hidden md:flex flex-1 max-w-md mx-4 lg:mx-8">
              <div className="relative w-full">
                <Input
                  type="text"
                  placeholder="e.g., Sarkodie and Obama together"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  className="h-9 pr-10 rounded-lg bg-muted/50 text-sm"
                  disabled={isLoading}
                />
                <Button
                  type="submit"
                  size="icon"
                  disabled={!query.trim() || isLoading}
                  className="absolute right-1 top-1/2 -translate-y-1/2 size-7 rounded-md"
                  variant="ghost"
                >
                  {isLoading ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <ArrowRight className="size-4" />
                  )}
                </Button>
              </div>
            </form>
          )}

          {/* Action buttons */}
          <div className="flex items-center gap-1.5 sm:gap-2">
            {investigationState && (
              <>
                {isLoading && (
                  <Button
                    variant="destructive"
                    size="sm"
                    onClick={handleStop}
                    className="gap-1.5 sm:gap-2 h-7 sm:h-8 px-2 sm:px-3"
                  >
                    <Square className="size-3 fill-current" />
                    <span className="hidden sm:inline">Stop</span>
                  </Button>
                )}
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleNewSearch}
                  className="gap-1.5 sm:gap-2 h-7 sm:h-8 px-2 sm:px-3"
                >
                  <RotateCcw className="size-3" />
                  <span className="hidden sm:inline">New</span>
                </Button>
              </>
            )}
            {/* Mobile menu button */}
            <Button
              variant="ghost"
              size="sm"
              className="sm:hidden h-7 w-7 p-0"
              onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
            >
              {mobileMenuOpen ? <X className="size-4" /> : <Menu className="size-4" />}
            </Button>
          </div>
        </div>

        {/* Mobile dropdown menu */}
        {mobileMenuOpen && (
          <div className="sm:hidden border-t bg-background px-3 py-2 space-y-2 animate-in slide-in-from-top-2 duration-200">
            <Link href="/graph" onClick={() => setMobileMenuOpen(false)}>
              <Button variant="ghost" size="sm" className="w-full justify-start gap-2">
                <Network className="size-4" />
                View Graph
              </Button>
            </Link>
            {investigationState && (
              <form onSubmit={(e) => { handleSubmit(e); setMobileMenuOpen(false); }} className="relative">
                <Input
                  type="text"
                  placeholder="New search..."
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  className="h-9 pr-10 rounded-lg bg-muted/50 text-sm"
                  disabled={isLoading}
                />
                <Button
                  type="submit"
                  size="icon"
                  disabled={!query.trim() || isLoading}
                  className="absolute right-1 top-1/2 -translate-y-1/2 size-7 rounded-md"
                  variant="ghost"
                >
                  {isLoading ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <ArrowRight className="size-4" />
                  )}
                </Button>
              </form>
            )}
          </div>
        )}
      </header>

      {/* Main Content */}
      <main className="flex-1 overflow-hidden">
        {!investigationState ? (
          /* Search Form - Centered when no investigation */
          <div className="h-full flex flex-col items-center justify-center px-3 sm:px-4 pb-16 sm:pb-24">
            <div className="w-full max-w-xl space-y-5 sm:space-y-8">
              <div className="text-center space-y-1.5 sm:space-y-2">
                <h2 className="text-2xl sm:text-3xl font-bold tracking-tight">Who is connected to who?</h2>
                <p className="text-sm sm:text-base text-muted-foreground px-2">
                  Find visual proof of connections between any two people through photos
                </p>
              </div>

              <form onSubmit={handleSubmit} className="space-y-3 sm:space-y-4">
                <div className="relative">
                  <Input
                    type="text"
                    placeholder="e.g., Sarkodie and Obama together"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    className={cn(
                      "h-12 sm:h-14 text-base sm:text-lg px-4 sm:px-5 pr-12 sm:pr-14 rounded-xl sm:rounded-2xl",
                      "bg-muted/50 border-muted-foreground/20",
                      "focus:bg-background focus:border-primary/50",
                      "transition-all duration-200"
                    )}
                    disabled={isLoading}
                  />
                  <Button
                    type="submit"
                    size="icon"
                    disabled={!query.trim() || isLoading}
                    className="absolute right-1.5 sm:right-2 top-1/2 -translate-y-1/2 size-9 sm:size-10 rounded-lg sm:rounded-xl"
                  >
                    {isLoading ? (
                      <Loader2 className="size-4 sm:size-5 animate-spin" />
                    ) : (
                      <ArrowRight className="size-4 sm:size-5" />
                    )}
                  </Button>
                </div>

                {error && (
                  <p className="text-sm text-destructive text-center">{error}</p>
                )}
              </form>

              <div className="text-center">
                <p className="text-xs sm:text-sm text-muted-foreground mb-2 sm:mb-3">Try these examples:</p>
                <div className="flex flex-wrap justify-center gap-1.5 sm:gap-2">
                  {[
                    "Donald Trump to Cardi B",
                    "Elon Musk to Beyonce",
                    "Taylor Swift to Joe Biden"
                  ].map((example) => (
                    <Button
                      key={example}
                      variant="secondary"
                      size="sm"
                      className="rounded-full text-xs h-7 sm:h-8 px-2.5 sm:px-3"
                      onClick={() => {
                        setQuery(example);
                      }}
                    >
                      {example}
                    </Button>
                  ))}
                </div>
              </div>
            </div>
          </div>
        ) : (
          /* Investigation View - Split layout */
          <div className="h-full flex flex-col md:flex-row relative">
            {/* Main panel - Investigation tracker */}
            <div className={cn(
              "h-full overflow-auto transition-all duration-300 w-full",
              showGraph && !isMobile ? "md:flex-1" : "w-full"
            )}>
              {error && (
                <p className="text-sm text-destructive px-4 sm:px-6 pt-3 sm:pt-4">{error}</p>
              )}
              <InvestigationTracker
                state={investigationState}
                className="p-3 sm:p-4 md:p-6"
                onSearchDeeper={cachedPath ? () => {
                  setIsLoading(true);
                  runFreshInvestigation(investigationState.query.personA, investigationState.query.personB);
                } : undefined}
              />
            </div>

            {/* Desktop: Side panel graph */}
            {showGraph && !isMobile && (
              <>
                {/* Resize handle - desktop only */}
                <div
                  className={cn(
                    "hidden md:block w-1 hover:w-1.5 bg-transparent hover:bg-primary/20 cursor-col-resize transition-all shrink-0 relative group touch-none",
                    isResizing && "w-1.5 bg-primary/30"
                  )}
                  onMouseDown={handleResizeStart}
                  onTouchStart={handleResizeStart}
                >
                  <div className={cn(
                    "absolute inset-y-0 left-1/2 -translate-x-1/2 w-px bg-border group-hover:bg-primary/40 transition-colors",
                    isResizing && "bg-primary/50"
                  )} />
                </div>

                <div
                  className="hidden md:flex border-l bg-zinc-50 flex-col shrink-0"
                  style={{ width: graphWidth }}
                >
                  {/* Graph header */}
                  <div className="px-3 py-2 border-b bg-white flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <Network className="size-4 text-primary shrink-0" />
                      <span className="text-sm font-medium truncate">Live Graph</span>
                      <span className="text-xs text-muted-foreground whitespace-nowrap hidden lg:inline">
                        {graphStats.nodes} people, {graphStats.edges} connections
                      </span>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      <Link href="/graph" target="_blank">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7"
                          title="Open full graph"
                        >
                          <Expand className="size-4" />
                        </Button>
                      </Link>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7"
                        onClick={() => setShowGraph(false)}
                        title="Hide graph"
                      >
                        <PanelRightClose className="size-4" />
                      </Button>
                    </div>
                  </div>

                  {/* Graph visualization */}
                  <div className="flex-1 min-h-0">
                    <SocialGraph className="h-full" compact onStatsChange={setGraphStats} />
                  </div>
                </div>
              </>
            )}

            {/* Mobile: Full-screen graph overlay */}
            {showGraph && isMobile && (
              <div className="fixed inset-0 z-50 bg-background flex flex-col animate-in slide-in-from-bottom duration-300">
                {/* Mobile graph header */}
                <div className="px-3 py-2 border-b bg-white flex items-center justify-between gap-2 shrink-0">
                  <div className="flex items-center gap-2 min-w-0">
                    <Network className="size-4 text-primary shrink-0" />
                    <span className="text-sm font-medium">Live Graph</span>
                    <span className="text-xs text-muted-foreground">
                      {graphStats.nodes} people
                    </span>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <Link href="/graph" target="_blank">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8"
                        title="Open full graph"
                      >
                        <Expand className="size-4" />
                      </Button>
                    </Link>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      onClick={() => setShowGraph(false)}
                      title="Close graph"
                    >
                      <X className="size-4" />
                    </Button>
                  </div>
                </div>

                {/* Graph visualization - mobile */}
                <div className="flex-1 min-h-0 bg-zinc-50">
                  <SocialGraph className="h-full" compact onStatsChange={setGraphStats} />
                </div>
              </div>
            )}

            {/* Floating toggle button when graph is hidden */}
            {!showGraph && (
              <Button
                variant="outline"
                size="sm"
                className={cn(
                  "fixed bottom-4 right-4 gap-2 shadow-lg z-40",
                  "h-10 sm:h-9 px-3 sm:px-4"
                )}
                onClick={() => setShowGraph(true)}
              >
                <Network className="size-4" />
                <span className="hidden sm:inline">Show Graph</span>
                <span className="sm:hidden">Graph</span>
              </Button>
            )}
          </div>
        )}
      </main>
    </div>
  )
}
