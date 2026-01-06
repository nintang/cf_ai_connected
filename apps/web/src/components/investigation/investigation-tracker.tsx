"use client";

import { cn } from "@/lib/utils";
import {
  Check,
  X,
  Loader2,
  Circle,
  ImageIcon,
  ArrowRight,
  ChevronDown,
  Minus,
  Maximize2,
} from "lucide-react";
import type {
  InvestigationState,
  InvestigationStep,
  InvestigationSegment,
  EvidenceItem,
  StepStatus,
} from "@/types/investigation";
import { useState, useEffect } from "react";

// shadcn components
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";

interface InvestigationTrackerProps {
  state: InvestigationState;
  className?: string;
}

// Icon-based status indicator
function StatusIcon({ status, size = 16 }: { status: StepStatus; size?: number }) {
  const iconProps = { size, strokeWidth: 2 };

  switch (status) {
    case "done":
      return (
        <div className="flex items-center justify-center rounded-sm bg-foreground p-0.5">
          <Check size={size - 4} className="text-background" strokeWidth={3} />
        </div>
      );
    case "running":
      return <Loader2 {...iconProps} className="text-foreground/70 animate-spin" />;
    case "failed":
      return (
        <div className="flex items-center justify-center rounded-sm border border-foreground/30 p-0.5">
          <X size={size - 4} className="text-foreground/50" strokeWidth={2.5} />
        </div>
      );
    case "skipped":
      return <Minus {...iconProps} className="text-foreground/25" />;
    case "pending":
    default:
      return <Circle {...iconProps} className="text-foreground/20" strokeWidth={1.5} />;
  }
}

// Status label
function StatusLabel({ status }: { status: InvestigationSegment["status"] }) {
  const config = {
    success: { label: "Found", icon: Check, className: "text-foreground" },
    running: { label: "Searching", icon: Loader2, className: "text-foreground/60" },
    failed: { label: "Not found", icon: X, className: "text-foreground/40" },
    skipped: { label: "Skipped", icon: Minus, className: "text-foreground/30" },
  }[status];

  if (!config) return null;
  const Icon = config.icon;

  return (
    <span className={cn("inline-flex items-center gap-1.5 text-xs font-medium", config.className)}>
      <Icon size={12} className={status === "running" ? "animate-spin" : ""} />
      {config.label}
    </span>
  );
}

// Bridge candidates display
function BridgeCandidates({ candidates, selected, showReasoning = false }: {
  candidates: Array<{ name: string; score?: number; reasoning?: string }>;
  selected?: string[];
  showReasoning?: boolean;
}) {
  if (!candidates || candidates.length === 0) return null;

  return (
    <div className="space-y-2 mt-1">
      <div className="flex flex-wrap gap-1.5">
        {candidates.map((candidate, idx) => {
          const isSelected = selected?.some(s => s.toLowerCase() === candidate.name.toLowerCase());
          return (
            <span
              key={idx}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs transition-colors",
                isSelected
                  ? "bg-foreground text-background font-medium"
                  : "bg-foreground/5 text-foreground/70"
              )}
            >
              {candidate.name}
              {candidate.score && (
                <span className={cn(
                  "text-[10px]",
                  isSelected ? "text-background/70" : "text-foreground/40"
                )}>
                  {candidate.score}%
                </span>
              )}
            </span>
          );
        })}
      </div>
      {showReasoning && candidates.some(c => c.reasoning) && (
        <div className="space-y-1.5 pl-2 border-l-2 border-foreground/10">
          {candidates.filter(c => c.reasoning).map((candidate, idx) => (
            <div key={idx} className="text-xs text-foreground/40">
              <span className="font-medium text-foreground/60">{candidate.name}:</span>{" "}
              {candidate.reasoning}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// Step event - handles different event types with appropriate UI
function StepEvent({ event }: { event: { type: string; message: string; data?: Record<string, unknown> } }) {
  const candidates = event.data?.candidates as Array<{ name: string; score?: number; reasoning?: string }> | undefined;
  const query = event.data?.query as string | undefined;
  const reasoning = event.data?.reasoning as string | undefined;

  // Check if this is a selection message (contains "Selected:")
  const isSelection = event.message.toLowerCase().includes("selected:");
  const selectedNames = isSelection
    ? event.message.replace(/selected:/i, "").split(",").map(s => s.trim())
    : undefined;

  // Check if this is an AI suggestion message
  const isAISuggestion = event.message.toLowerCase().includes("ai suggested");

  return (
    <div className="space-y-1.5 overflow-hidden">
      <div className="flex items-start gap-2 text-sm text-foreground/50">
        <span className="text-foreground/30 mt-0.5 shrink-0">›</span>
        <div className="flex-1 min-w-0">
          <span className="break-words">{event.message}</span>
          {query && (
            <span className="ml-1.5 text-foreground/30 text-xs">
              ({query})
            </span>
          )}
        </div>
      </div>
      {candidates && candidates.length > 0 && (
        <div className="ml-5">
          <BridgeCandidates
            candidates={candidates}
            selected={selectedNames}
            showReasoning={isAISuggestion}
          />
        </div>
      )}
      {reasoning && (
        <div className="ml-5 text-xs text-foreground/40 italic break-words">
          {reasoning}
        </div>
      )}
    </div>
  );
}

// Image result
function ImageResult({ event }: { event: { type: string; message: string; data?: Record<string, unknown> } }) {
  const [isExpanded, setIsExpanded] = useState(false);
  const status = event.data?.status as string;

  // Don't render errored images
  if (status === "error") return null;

  const imageUrl = event.data?.imageUrl as string;
  const celebrities = event.data?.celebrities as Array<{ name: string; confidence: number }> | undefined;
  const reason = event.data?.reason as string | undefined;

  const StatusIconSmall = {
    evidence: <Check size={12} className="text-foreground" />,
    collage: <X size={12} className="text-foreground/40" />,
    no_match: <Minus size={12} className="text-foreground/30" />,
    error: <X size={12} className="text-red-500" />,
  }[status] || <Circle size={12} className="text-foreground/20" />;

  return (
    <div className="space-y-2">
      <div className="flex items-start gap-2 text-sm text-foreground/60">
        <span className="shrink-0 mt-0.5">{StatusIconSmall}</span>
        <div className="flex-1 min-w-0">
          <span className={status === "error" ? "text-red-500/80" : ""}>{event.message}</span>
          {status === "error" && reason && (
            <div className="mt-1 text-xs text-red-500/60 font-mono break-all">
              {reason}
            </div>
          )}
        </div>
      </div>

      {imageUrl && (
        <div className="ml-5">
          <button
            onClick={() => setIsExpanded(true)}
            className={cn(
              "relative inline-block overflow-hidden rounded-md border cursor-pointer group",
              status === "evidence" ? "border-foreground/40 ring-1 ring-foreground/10" : "border-foreground/10 opacity-60 hover:opacity-80"
            )}
          >
            <img
              src={imageUrl}
              alt="Analyzed image"
              className="h-20 w-auto max-w-[160px] object-cover"
              loading="lazy"
            />
            <div className="absolute inset-0 bg-black/0 group-hover:bg-black/20 transition-colors flex items-center justify-center">
              <Maximize2 size={16} className="text-white opacity-0 group-hover:opacity-100 transition-opacity" />
            </div>
            {status === "evidence" && (
              <div className="absolute top-1 right-1 rounded bg-foreground p-0.5">
                <Check size={10} className="text-background" strokeWidth={3} />
              </div>
            )}
          </button>

          {status === "evidence" && celebrities && celebrities.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {celebrities.map((celeb, idx) => (
                <span
                  key={idx}
                  className="inline-flex items-center gap-1 rounded-md bg-foreground/5 px-2 py-0.5 text-xs"
                >
                  {celeb.name}
                  <span className="text-foreground/40">{celeb.confidence}%</span>
                </span>
              ))}
            </div>
          )}

          {/* Expanded image dialog */}
          <Dialog open={isExpanded} onOpenChange={setIsExpanded}>
            <DialogContent className="max-w-3xl p-2">
              <DialogTitle className="sr-only">Image preview</DialogTitle>
              <div className="relative">
                <img
                  src={imageUrl}
                  alt="Expanded view"
                  className="w-full h-auto max-h-[80vh] object-contain rounded-md"
                />
                {status === "evidence" && celebrities && celebrities.length > 0 && (
                  <div className="absolute bottom-2 left-2 right-2 flex flex-wrap gap-1.5 bg-black/50 backdrop-blur-sm rounded-md p-2">
                    {celebrities.map((celeb, idx) => (
                      <span
                        key={idx}
                        className="inline-flex items-center gap-1 rounded-md bg-white/20 px-2 py-0.5 text-xs text-white"
                      >
                        {celeb.name}
                        <span className="text-white/70">{celeb.confidence}%</span>
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </DialogContent>
          </Dialog>
        </div>
      )}
    </div>
  );
}

// Step item
function StepItem({ step, value }: { step: InvestigationStep; value: string }) {
  // Filter out error image events - don't show or count them
  const visibleEvents = step.events.filter(event => {
    if (event.type === "image_result") {
      const status = (event.data as Record<string, unknown>)?.status as string;
      return status !== "error";
    }
    return true;
  });

  const hasDetails = visibleEvents.length > 0;

  return (
    <AccordionItem value={value} className="border-b border-foreground/8 last:border-0">
      <AccordionTrigger className="py-3 hover:no-underline hover:bg-foreground/[0.02] px-3 -mx-3 rounded-md gap-3 [&[data-state=open]>svg]:rotate-180">
        <div className="flex items-center gap-3 flex-1 min-w-0">
          <StatusIcon status={step.status} />
          <div className="text-left flex-1 min-w-0">
            <span className={cn(
              "text-sm",
              step.status === "pending" && "text-foreground/40",
              step.status === "running" && "text-foreground",
              step.status === "done" && "text-foreground",
              step.status === "failed" && "text-foreground/50"
            )}>
              {step.title}
            </span>
            {step.message && (
              <p className="text-xs text-foreground/50 mt-0.5 truncate">{step.message}</p>
            )}
          </div>
        </div>
        {hasDetails && <ChevronDown size={14} className="text-foreground/30 shrink-0 transition-transform" />}
      </AccordionTrigger>

      {hasDetails && (
        <AccordionContent className="pb-3">
          <div className="ml-7 space-y-2 border-l border-foreground/8 pl-4 overflow-hidden">
            {visibleEvents.map((event, idx) => (
              <div key={idx}>
                {event.type === "image_result" ? (
                  <ImageResult event={event} />
                ) : (
                  <StepEvent event={event} />
                )}
              </div>
            ))}
          </div>
        </AccordionContent>
      )}
    </AccordionItem>
  );
}

// Segment detail
function SegmentDetail({ segment }: { segment: InvestigationSegment }) {
  const defaultOpen = segment.steps
    .filter(s => s.status === "running")
    .map((_, idx) => `step-${idx}`);

  return (
    <div className="space-y-5 overflow-hidden">
      {/* Segment header */}
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-2.5 min-w-0">
          <span className="text-sm font-medium truncate">{segment.from}</span>
          <ArrowRight size={14} className="text-foreground/30 shrink-0" />
          <span className="text-sm font-medium truncate">{segment.to}</span>
        </div>
        <StatusLabel status={segment.status} />
      </div>

      {/* Steps */}
      {segment.steps.length > 0 && (
        <Accordion type="multiple" defaultValue={defaultOpen} className="w-full overflow-hidden">
          {segment.steps.map((step, idx) => (
            <StepItem key={`${step.id}-${idx}`} step={step} value={`step-${idx}`} />
          ))}
        </Accordion>
      )}
    </div>
  );
}

// Current path
function CurrentPath({ path, target }: { path: string[]; target: string }) {
  if (path.length === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {path.map((name, idx) => (
        <div key={idx} className="flex items-center gap-1.5">
          <span className={cn(
            "rounded px-2 py-0.5 text-xs",
            idx === 0 && "bg-foreground text-background font-medium",
            idx === path.length - 1 && path[path.length - 1] === target && "bg-foreground text-background font-medium",
            idx === path.length - 1 && path[path.length - 1] !== target && "bg-foreground/10 text-foreground",
            idx > 0 && idx < path.length - 1 && "bg-foreground/5 text-foreground/70"
          )}>
            {name}
          </span>
          {idx < path.length - 1 && (
            <ArrowRight size={12} className="text-foreground/25" />
          )}
        </div>
      ))}
      {path[path.length - 1] !== target && (
        <>
          <span className="text-foreground/25 text-xs">···</span>
          <ArrowRight size={12} className="text-foreground/25" />
          <span className="rounded bg-foreground/5 px-2 py-0.5 text-xs text-foreground/50">
            {target}
          </span>
        </>
      )}
    </div>
  );
}

// Final path with evidence photos
function FinalPath({ path, evidence }: { path: InvestigationState["path"]; evidence: EvidenceItem[] }) {
  if (path.length === 0) return null;

  const names = [path[0].from, ...path.map((p) => p.to)];

  // Find evidence for each hop
  const getEvidenceForHop = (from: string, to: string) => {
    return evidence.find(e =>
      (e.from.toLowerCase() === from.toLowerCase() && e.to.toLowerCase() === to.toLowerCase()) ||
      (e.from.toLowerCase() === to.toLowerCase() && e.to.toLowerCase() === from.toLowerCase())
    );
  };

  return (
    <div className="space-y-4">
      {/* Compact path overview */}
      <div className="flex flex-wrap items-center gap-2">
        {names.map((name, idx) => (
          <div key={idx} className="flex items-center gap-2">
            <div className={cn(
              "rounded-md px-3 py-1.5 text-sm font-medium",
              (idx === 0 || idx === names.length - 1) && "bg-foreground text-background",
              idx > 0 && idx < names.length - 1 && "border border-foreground/20 text-foreground"
            )}>
              {name}
            </div>
            {idx < names.length - 1 && (
              <ArrowRight size={14} className="text-foreground/30" />
            )}
          </div>
        ))}
      </div>

      {/* Evidence photos for each hop */}
      {path.length > 0 && (
        <div className="flex flex-wrap gap-3 pt-2">
          {path.map((hop, idx) => {
            const hopEvidence = getEvidenceForHop(hop.from, hop.to);
            const isIntermediary = idx > 0 && idx < path.length - 1;

            return (
              <div
                key={idx}
                className={cn(
                  "flex items-center gap-2 rounded-lg border p-2 transition-colors",
                  isIntermediary
                    ? "border-foreground/15 bg-foreground/[0.02]"
                    : "border-foreground/20 bg-foreground/[0.03]"
                )}
              >
                {hopEvidence?.thumbnailUrl ? (
                  <a
                    href={hopEvidence.sourceUrl || hopEvidence.thumbnailUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="relative shrink-0 overflow-hidden rounded-md hover:opacity-90 transition-opacity"
                  >
                    <img
                      src={hopEvidence.thumbnailUrl}
                      alt={`${hop.from} with ${hop.to}`}
                      className="size-12 object-cover"
                    />
                    <div className="absolute bottom-0.5 right-0.5 rounded bg-foreground/80 p-0.5">
                      <Check size={8} className="text-background" strokeWidth={3} />
                    </div>
                  </a>
                ) : (
                  <div className="flex size-12 items-center justify-center rounded-md bg-foreground/5 shrink-0">
                    <ImageIcon size={16} className="text-foreground/30" />
                  </div>
                )}
                <div className="min-w-0">
                  <div className="flex items-center gap-1 text-xs font-medium">
                    <span className="truncate max-w-[60px]">{hop.from.split(' ').pop()}</span>
                    <ArrowRight size={10} className="text-foreground/40 shrink-0" />
                    <span className="truncate max-w-[60px]">{hop.to.split(' ').pop()}</span>
                  </div>
                  <div className="text-[10px] text-foreground/50 mt-0.5">
                    {Math.ceil(hop.confidence)}% match
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// Progress bar
function ProgressBar({ segments }: { segments: InvestigationSegment[] }) {
  if (segments.length === 0) return null;

  return (
    <div className="flex items-center gap-0.5 h-1 rounded-full overflow-hidden bg-foreground/5">
      {segments.map((segment) => (
        <div
          key={segment.id}
          className={cn(
            "h-full flex-1 transition-all",
            segment.status === "success" && "bg-foreground",
            segment.status === "running" && "bg-foreground/50 animate-pulse",
            segment.status === "failed" && "bg-foreground/15",
            segment.status === "skipped" && "bg-foreground/8",
          )}
        />
      ))}
    </div>
  );
}

export function InvestigationTracker({
  state,
  className,
}: InvestigationTrackerProps) {
  const isRunning = state.status === "running";
  const isCompleted = state.status === "completed";
  const isFailed = state.status === "failed";

  const [activeSegmentId, setActiveSegmentId] = useState<string | null>(null);
  const [userSelectedTab, setUserSelectedTab] = useState(false);

  // Only auto-switch tabs if user hasn't manually selected one
  useEffect(() => {
    if (userSelectedTab) return;

    if (state.activeSegmentId) {
      setActiveSegmentId(state.activeSegmentId);
    } else if (state.segments.length > 0) {
      const runningSegment = state.segments.find(s => s.status === "running");
      setActiveSegmentId(runningSegment?.id || state.segments[state.segments.length - 1].id);
    }
  }, [state.activeSegmentId, state.segments, userSelectedTab]);

  // Handle user tab selection
  const handleTabChange = (segmentId: string) => {
    setUserSelectedTab(true);
    setActiveSegmentId(segmentId);
  };

  const hasSegments = state.segments.length > 0;
  const activeSegment = hasSegments ? state.segments.find(s => s.id === activeSegmentId) : null;

  return (
    <div className={cn("w-full h-full", className)}>
      {/* Two-column layout for wider screens */}
      <div className="flex flex-col lg:flex-row gap-6 h-full">
        {/* Left column - Status and Path */}
        <div className="lg:w-[400px] xl:w-[480px] shrink-0 space-y-4">
          {/* Header Card */}
          <Card className={cn(
            "rounded-xl border py-0 shadow-sm",
            isCompleted && "border-foreground/30"
          )}>
            <CardHeader className="pb-3 pt-4">
              <div className="flex items-start justify-between gap-4">
                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    {isRunning && <Loader2 size={16} className="text-foreground/60 animate-spin" />}
                    {isCompleted && (
                      <div className="flex items-center justify-center rounded bg-foreground p-0.5">
                        <Check size={12} className="text-background" strokeWidth={3} />
                      </div>
                    )}
                    {isFailed && (
                      <div className="flex items-center justify-center rounded border border-foreground/30 p-0.5">
                        <X size={12} className="text-foreground/50" strokeWidth={2.5} />
                      </div>
                    )}

                    <CardTitle className="text-base font-semibold">
                      {isRunning && "Investigating"}
                      {isCompleted && "Connection Found"}
                      {isFailed && "No Connection"}
                    </CardTitle>
                  </div>

                  <CardDescription className="text-sm">
                    {state.query.personA}
                    <span className="mx-1.5 text-foreground/30">→</span>
                    {state.query.personB}
                  </CardDescription>
                </div>

                {hasSegments && (
                  <div className="text-right">
                    <div className="text-2xl font-semibold tabular-nums tracking-tight">
                      {state.segments.filter((s) => s.status === "success").length}
                      <span className="text-foreground/20 mx-0.5">/</span>
                      <span className="text-foreground/50">{state.segments.length}</span>
                    </div>
                    <div className="text-[10px] text-foreground/40 uppercase tracking-wide">segments</div>
                  </div>
                )}
              </div>

              {hasSegments && (
                <div className="pt-3">
                  <ProgressBar segments={state.segments} />
                </div>
              )}
            </CardHeader>

            {isRunning && state.currentPath.length > 0 && (
              <CardContent className="pt-0 pb-4 border-t border-dashed border-foreground/8">
                <div className="text-[10px] text-foreground/40 uppercase tracking-wide mb-2 pt-3">
                  Exploring
                </div>
                <CurrentPath path={state.currentPath} target={state.query.personB} />
              </CardContent>
            )}

            {isCompleted && state.path.length > 0 && (
              <CardContent className="pt-0 pb-4 border-t border-foreground/10">
                <div className="pt-4">
                  <FinalPath path={state.path} evidence={state.evidence} />
                </div>
              </CardContent>
            )}
          </Card>

          {/* Segment selector - vertical list on desktop */}
          {hasSegments && (
            <div className="space-y-1.5">
              <div className="text-[10px] text-foreground/40 uppercase tracking-wide px-1">
                Segments
              </div>
              <div className="flex flex-col gap-1">
                {state.segments.map((segment) => (
                  <button
                    key={segment.id}
                    onClick={() => handleTabChange(segment.id)}
                    className={cn(
                      "w-full rounded-lg px-3 py-2.5 text-left text-sm border transition-all",
                      "flex items-center justify-between gap-2",
                      activeSegmentId === segment.id
                        ? "bg-foreground text-background border-foreground shadow-sm"
                        : "border-foreground/10 text-foreground/70 hover:border-foreground/20 hover:bg-foreground/[0.02]",
                      segment.status === "failed" && activeSegmentId !== segment.id && "opacity-50"
                    )}
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="truncate">{segment.from}</span>
                      <ArrowRight size={12} className="opacity-40 shrink-0" />
                      <span className="truncate">{segment.to}</span>
                    </div>
                    <div className="shrink-0">
                      {segment.status === "running" && <Loader2 size={12} className="animate-spin" />}
                      {segment.status === "success" && <Check size={12} strokeWidth={2.5} />}
                      {segment.status === "failed" && <X size={12} className="opacity-50" />}
                    </div>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Right column - Segment Details */}
        <div className="flex-1 min-w-0 overflow-hidden lg:overflow-auto">
          {activeSegment ? (
            <Card className="rounded-xl border shadow-sm h-full overflow-hidden">
              <CardContent className="pt-5 pb-5 overflow-auto max-h-full">
                <SegmentDetail segment={activeSegment} />
              </CardContent>
            </Card>
          ) : !hasSegments && state.steps.length > 0 ? (
            /* Legacy steps */
            <Card className="rounded-xl border shadow-sm">
              <CardHeader className="pb-2">
                <CardTitle className="text-xs text-foreground/40 uppercase tracking-wide">
                  Progress
                </CardTitle>
              </CardHeader>
              <CardContent className="pb-4">
                <Accordion
                  type="multiple"
                  defaultValue={state.steps.filter(s => s.status === "running").map((_, i) => `legacy-step-${i}`)}
                >
                  {state.steps.map((step, idx) => (
                    <StepItem key={`${step.id}-${idx}`} step={step} value={`legacy-step-${idx}`} />
                  ))}
                </Accordion>
              </CardContent>
            </Card>
          ) : (
            <div className="h-full flex items-center justify-center text-foreground/30">
              <div className="text-center">
                <Loader2 size={24} className="animate-spin mx-auto mb-2" />
                <p className="text-sm">Starting investigation...</p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
