"use client"

import {
  ChatContainerContent,
  ChatContainerRoot,
} from "@/components/ui/chat-container"
import {
  Message,
  MessageAction,
  MessageActions,
  MessageContent,
} from "@/components/ui/message"
import {
  PromptInput,
  PromptInputAction,
  PromptInputActions,
  PromptInputTextarea,
} from "@/components/ui/prompt-input"
import { ScrollButton } from "@/components/ui/scroll-button"
import { Button } from "@/components/ui/button"
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar"
import { cn } from "@/lib/utils"
import {
  ArrowUp,
  Copy,
  Globe,
  PlusIcon,
  Search,
} from "lucide-react"
import { useRef, useState, useCallback } from "react"
import { parseQuery } from "@/lib/query-parser"
import { InvestigationTracker } from "@/components/investigation/investigation-tracker"
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
  createEventStream,
  parseQueryWithAI,
  InvestigationEvent as WorkerEvent
} from "@/lib/api-client"

// Initial conversation history
const conversationHistory = [
  {
    period: "Today",
    conversations: [
      {
        id: "t1",
        title: "Donald Trump ↔ Cardi B",
        lastMessage: "2-hop path found via Jimmy Fallon",
        timestamp: new Date().setHours(new Date().getHours() - 2),
      }
    ],
  },
  {
    period: "Yesterday",
    conversations: [],
  }
]

// Initial chat messages
const initialMessages: Array<{
  id: number;
  role: "user" | "assistant";
  content: string;
  investigationState?: InvestigationState;
}> = [
  {
    id: 1,
    role: "assistant",
    content: "Hi! I can find verified visual connections between any two people. Try asking:\n\n* \"Connect Elon Musk to Beyoncé\"\n* \"How is Donald Trump connected to Cardi B?\"",
  },
];

// Demo investigation state removed - using live API now

function ChatSidebar() {
  return (
    <Sidebar>
      <SidebarHeader className="flex flex-row items-center justify-between gap-2 px-2 py-4">
        <div className="flex flex-row items-center gap-2 px-2">
          <div className="bg-primary/10 size-8 rounded-md flex items-center justify-center">
            <Search className="size-4 text-primary" />
          </div>
          <div className="text-md font-base text-foreground tracking-tight">
            Connected<span className="text-primary">?</span>
          </div>
        </div>
        <Button variant="ghost" className="size-8">
          <Search className="size-4" />
        </Button>
      </SidebarHeader>
      <SidebarContent className="pt-4">
        <div className="px-4">
          <Button
            variant="outline"
            className="mb-4 flex w-full items-center gap-2"
          >
            <PlusIcon className="size-4" />
            <span>New Investigation</span>
          </Button>
        </div>
        {conversationHistory.map((group) => (
          group.conversations.length > 0 && (
            <SidebarGroup key={group.period}>
              <SidebarGroupLabel>{group.period}</SidebarGroupLabel>
              <SidebarMenu>
                {group.conversations.map((conversation) => (
                  <SidebarMenuButton key={conversation.id}>
                    <span>{conversation.title}</span>
                  </SidebarMenuButton>
                ))}
              </SidebarMenu>
            </SidebarGroup>
          )
        ))}
      </SidebarContent>
    </Sidebar>
  )
}

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
  // Use backend-provided unique eventId if available
  const data = event.data as Record<string, unknown> | undefined;
  if (data?.eventId) {
    return data.eventId as string;
  }
  // Fallback for older events
  return `${event.type}:${event.timestamp}:${event.message}`;
}

/**
 * Maps worker events to InvestigationState updates (segment + step based)
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

  // Build a set of existing event IDs for fast deduplication
  const existingEventIds = new Set(
    state.logs.map(l => l.data?.eventId as string || `${l.type}:${l.timestamp}:${l.message}`)
  );

  // Track the most recent candidate reasoning to apply to next verify_bridge segment
  let pendingCandidateReasoning: string | undefined;

  for (const event of events) {
    const timestamp = new Date(event.timestamp).getTime();
    const eventId = getEventId(event);

    // Skip duplicate events
    if (existingEventIds.has(eventId)) {
      continue;
    }
    existingEventIds.add(eventId);

    // Map event to log entry
    const logEntry: InvestigationEvent = {
      type: event.type as InvestigationEvent["type"],
      message: event.message,
      data: event.data as InvestigationEvent["data"],
      timestamp,
    };

    // Add to logs
    state.logs = [...state.logs, logEntry];

    // Handle step events
    switch (event.type) {
      case "step_start": {
        const stepId = event.data?.stepId as InvestigationStepId;
        const stepNumber = event.data?.stepNumber || state.steps.length + 1;
        const stepTitle = event.data?.stepTitle || STEP_TITLES[stepId] || "Unknown step";
        const fromPerson = event.data?.fromPerson as string | undefined;
        const toPerson = event.data?.toPerson as string | undefined;

        // Create new step
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

        // Create or update segment based on step type
        if (fromPerson && toPerson) {
          const hopDepth = event.data?.hopDepth as number ?? state.segments.length;
          const segmentId = createSegmentId(fromPerson, toPerson, hopDepth);

          // Check if segment already exists
          const existingSegmentIdx = state.segments.findIndex(s => s.id === segmentId);

          if (existingSegmentIdx === -1) {
            // Create new segment
            const newSegment: InvestigationSegment = {
              id: segmentId,
              from: fromPerson,
              to: toPerson,
              hopDepth,
              status: "running",
              steps: [newStep],
              startTime: timestamp,
              // Apply pending candidate reasoning for verify_bridge segments
              candidateReasoning: (stepId === "verify_bridge" || stepId === "connect_target") ? pendingCandidateReasoning : undefined,
            };
            // Clear the pending reasoning after applying it
            if (stepId === "verify_bridge" || stepId === "connect_target") {
              pendingCandidateReasoning = undefined;
            }
            state.segments = [...state.segments, newSegment];
            state.activeSegmentId = segmentId;
          } else {
            // Add step to existing segment
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
        // Capture candidate reasoning when "Selected:" event comes through
        if (event.message.toLowerCase().includes("selected:") && event.data?.reasoning) {
          pendingCandidateReasoning = event.data.reasoning as string;
        }

        // Update the step in the active segment only (segments are what we display)
        if (state.activeSegmentId) {
          const segmentIdx = state.segments.findIndex(s => s.id === state.activeSegmentId);
          if (segmentIdx >= 0) {
            const segment = state.segments[segmentIdx];
            const lastStepIdx = segment.steps.length - 1;
            if (lastStepIdx >= 0) {
              // Check if this event already exists in step.events
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

        // Find and update the step
        const stepIndex = state.steps.findIndex(s => s.id === stepId && s.status === "running");
        if (stepIndex >= 0) {
          state.steps[stepIndex] = {
            ...state.steps[stepIndex],
            status: stepStatus || "done",
            message: event.message,
            endTime: timestamp,
          };
        }

        // Update segment status based on step completion
        if (state.activeSegmentId) {
          const segmentIdx = state.segments.findIndex(s => s.id === state.activeSegmentId);
          if (segmentIdx >= 0) {
            const segment = state.segments[segmentIdx];
            // Update the step in the segment
            const segmentStepIdx = segment.steps.findIndex(s => s.id === stepId && s.status === "running");
            if (segmentStepIdx >= 0) {
              segment.steps[segmentStepIdx] = {
                ...segment.steps[segmentStepIdx],
                status: stepStatus || "done",
                message: event.message,
                endTime: timestamp,
              };
            }

            // If this is a verify_bridge or connect_target completion, mark segment status
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
        // Update segment only (segments are what we display)
        if (state.activeSegmentId) {
          const segmentIdx = state.segments.findIndex(s => s.id === state.activeSegmentId);
          if (segmentIdx >= 0) {
            const segment = state.segments[segmentIdx];
            const lastStepIdx = segment.steps.length - 1;
            if (lastStepIdx >= 0) {
              // Check if this event already exists in step.events
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
            evidenceUrl: (edge as { evidenceUrl?: string }).evidenceUrl || undefined,
            sourceUrl: edge.contextUrl || "",
            confidence: edge.confidence,
            description: `${edge.from} and ${edge.to}`,
          };
          state.evidence = [...state.evidence, evidenceItem];

          // Add evidence to the matching segment
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
            // Find matching evidence for confidence
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
        // Update current path on backtrack
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

function ChatContent() {
  const [prompt, setPrompt] = useState("")
  const [isLoading, setIsLoading] = useState(false)
  const [chatMessages, setChatMessages] = useState(initialMessages)
  const chatContainerRef = useRef<HTMLDivElement>(null)
  const stopPollingRef = useRef<(() => void) | null>(null)

  /**
   * Start a real investigation using the worker API
   */
  const runRealInvestigation = useCallback(async (personA: string, personB: string) => {
    const initialState = createInitialState(personA, personB);

    // Add assistant message with initial tracker
    setChatMessages(prev => [...prev, {
      id: prev.length + 1,
      role: "assistant",
      content: "Starting visual investigation...",
      investigationState: initialState
    }]);

    try {
      // Start the investigation
      const response = await startInvestigation(personA, personB);
      const { runId } = response;

      // Start SSE stream for events
      stopPollingRef.current = createEventStream(
        runId,
        (event) => {
          // Update the last message with the new event
          setChatMessages(prev => {
            const lastMsg = prev[prev.length - 1];
            if (lastMsg.role === "assistant" && lastMsg.investigationState) {
              const newState = mapWorkerEventsToState(
                [event],
                personA,
                personB,
                lastMsg.investigationState
              );
              return [
                ...prev.slice(0, -1),
                { ...lastMsg, investigationState: newState }
              ];
            }
            return prev;
          });
        },
        () => {
          // Stream complete
          setIsLoading(false);
        },
        (error) => {
          console.error("Stream error:", error);
          // Update state to show error
          setChatMessages(prev => {
            const lastMsg = prev[prev.length - 1];
            if (lastMsg.role === "assistant" && lastMsg.investigationState) {
              const errorLog: InvestigationEvent = {
                type: "error",
                message: `Error: ${error.message}`,
                timestamp: Date.now()
              };
              return [
                ...prev.slice(0, -1),
                {
                  ...lastMsg,
                  investigationState: {
                    ...lastMsg.investigationState,
                    status: "failed" as const,
                    logs: [...lastMsg.investigationState.logs, errorLog]
                  }
                }
              ];
            }
            return prev;
          });
          setIsLoading(false);
        }
      );
    } catch (error) {
      console.error("Failed to start investigation:", error);
      // Show error in UI
      setChatMessages(prev => {
        const lastMsg = prev[prev.length - 1];
        if (lastMsg.role === "assistant" && lastMsg.investigationState) {
          const errorLog: InvestigationEvent = {
            type: "error",
            message: `Failed to connect to worker: ${error instanceof Error ? error.message : 'Unknown error'}`,
            timestamp: Date.now()
          };
          return [
            ...prev.slice(0, -1),
            {
              ...lastMsg,
              investigationState: {
                ...lastMsg.investigationState,
                status: "failed" as const,
                logs: [...lastMsg.investigationState.logs, errorLog]
              }
            }
          ];
        }
        return prev;
      });
      setIsLoading(false);
    }
  }, []);

  const handleSubmit = async () => {
    if (!prompt.trim()) return

    // Stop any existing polling
    if (stopPollingRef.current) {
      stopPollingRef.current();
      stopPollingRef.current = null;
    }

    const userQuery = prompt.trim();

    // Add user message
    setChatMessages(prev => [...prev, {
      id: prev.length + 1,
      role: "user",
      content: userQuery,
    }]);

    setPrompt("");
    setIsLoading(true);

    try {
      // Use AI to parse the query
      const parsed = await parseQueryWithAI(userQuery);

      if (parsed.isValid && parsed.personA && parsed.personB) {
        // Start investigation with AI-extracted names
        runRealInvestigation(parsed.personA, parsed.personB);
      } else {
        // AI couldn't extract two people - show helpful message
        setChatMessages(prev => [...prev, {
          id: prev.length + 1,
          role: "assistant",
          content: parsed.reason
            ? `I couldn't find two people to connect: ${parsed.reason}\n\nTry something like "Connect Elon Musk to Beyoncé" or just type two names.`
            : "I can help you find visual connections between people. Try asking me to \"connect [Person A] to [Person B]\" or just type two names!",
        }]);
        setIsLoading(false);
      }
    } catch (error) {
      // Fallback to regex parsing if AI fails
      console.warn("AI parsing failed, falling back to regex:", error);
      const regexParsed = parseQuery(userQuery);

      if (regexParsed.isValid) {
        runRealInvestigation(regexParsed.personA, regexParsed.personB);
      } else {
        setChatMessages(prev => [...prev, {
          id: prev.length + 1,
          role: "assistant",
          content: "I can help you find visual connections. Try asking me to \"connect [Person A] to [Person B]\"!",
        }]);
        setIsLoading(false);
      }
    }
  }

  return (
    <main className="flex h-screen flex-col overflow-hidden">
      <header className="bg-background z-10 flex h-16 w-full shrink-0 items-center gap-2 border-b px-4">
        <SidebarTrigger className="-ml-1" />
        <div className="text-foreground">Connected? Investigation</div>
      </header>

      <div ref={chatContainerRef} className="relative flex-1 overflow-y-auto">
        <ChatContainerRoot className="h-full">
          <ChatContainerContent className="space-y-0 px-5 py-12">
            {chatMessages.map((message, index) => {
              const isAssistant = message.role === "assistant"
              const isLastMessage = index === chatMessages.length - 1

              return (
                <Message
                  key={message.id}
                  className={cn(
                    "mx-auto flex w-full max-w-3xl flex-col gap-2 px-6",
                    isAssistant ? "items-start" : "items-end"
                  )}
                >
                  {isAssistant ? (
                    <div className="group flex w-full flex-col gap-2">
                      {message.investigationState ? (
                        <InvestigationTracker state={message.investigationState} />
                      ) : (
                        <MessageContent
                          className="text-foreground prose flex-1 rounded-lg bg-transparent p-0"
                          markdown
                        >
                          {message.content}
                        </MessageContent>
                      )}
                      
                      {!message.investigationState && (
                        <MessageActions
                          className={cn(
                            "-ml-2.5 flex gap-0 opacity-0 transition-opacity duration-150 group-hover:opacity-100",
                            isLastMessage && "opacity-100"
                          )}
                        >
                          <MessageAction tooltip="Copy" delayDuration={100}>
                            <Button variant="ghost" size="icon" className="rounded-full">
                              <Copy />
                            </Button>
                          </MessageAction>
                        </MessageActions>
                      )}
                    </div>
                  ) : (
                    <div className="group flex flex-col items-end gap-1">
                      <MessageContent className="bg-muted text-primary max-w-[85%] rounded-3xl px-5 py-2.5 sm:max-w-[75%]">
                        {message.content}
                      </MessageContent>
                    </div>
                  )}
                </Message>
              )
            })}
          </ChatContainerContent>
          <div className="absolute bottom-4 left-1/2 flex w-full max-w-3xl -translate-x-1/2 justify-end px-5">
            <ScrollButton className="shadow-sm" />
          </div>
        </ChatContainerRoot>
      </div>

      <div className="bg-background z-10 shrink-0 px-3 pb-3 md:px-5 md:pb-5">
        <div className="mx-auto max-w-3xl">
          <PromptInput
            isLoading={isLoading}
            value={prompt}
            onValueChange={setPrompt}
            onSubmit={handleSubmit}
            className="border-input bg-popover relative z-10 w-full rounded-3xl border p-0 pt-1 shadow-xs"
          >
            <div className="flex flex-col">
              <PromptInputTextarea
                placeholder="Connect Person A to Person B..."
                className="min-h-[44px] pt-3 pl-4 text-base leading-[1.3] sm:text-base md:text-base"
              />

              <PromptInputActions className="mt-5 flex w-full items-center justify-between gap-2 px-3 pb-3">
                <div className="flex items-center gap-2">
                  <PromptInputAction tooltip="Search">
                    <Button variant="outline" className="rounded-full">
                      <Globe size={18} />
                      Search
                    </Button>
                  </PromptInputAction>
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    size="icon"
                    disabled={!prompt.trim() || isLoading}
                    onClick={handleSubmit}
                    className="size-9 rounded-full"
                  >
                    {!isLoading ? (
                      <ArrowUp size={18} />
                    ) : (
                      <span className="size-3 rounded-xs bg-white" />
                    )}
                  </Button>
                </div>
              </PromptInputActions>
            </div>
          </PromptInput>
        </div>
      </div>
    </main>
  )
}

export function FullChatApp() {
  return (
    <SidebarProvider>
      <ChatSidebar />
      <SidebarInset>
        <ChatContent />
      </SidebarInset>
    </SidebarProvider>
  )
}

