# Runtime Workflow State Machine

This diagram illustrates the optimized investigation workflow, including the **Intelligent Planner**, **Bridge Suggestions**, and **Early Stopping** optimizations.

```mermaid
stateDiagram-v2
    direction TB
    
    [*] --> Init
    
    state "Phase 0: Research" as Phase0 {
        Init --> ResearchConnection: LLM Research
        ResearchConnection --> SuggestBridges: LLM Suggests Real People
        SuggestBridges --> GenerateQueries: Prioritize Bridge Queries
    }

    state "Phase 1: Discovery (DFS Optimized)" as Phase1 {
        GenerateQueries --> RunQuery: Pick Top Priority Query
        
        state "Search Loop" as SearchLoop {
            RunQuery --> AnalyzeImages: Google PSE + Gemini + Rekognition
            AnalyzeImages --> EvaluateCandidates: Check for High Confidence
            
            EvaluateCandidates --> StopSearching: Found Strong Candidates (>90%)
            EvaluateCandidates --> NextQuery: No Strong Candidates
            NextQuery --> RunQuery: Try Next Query
        }
        
        StopSearching --> AggregateResults
        NextQuery --> AggregateResults: All Queries Exhausted
    }

    state "Phase 2: Selection" as Phase2 {
        AggregateResults --> RankStrategically: LLM Re-ranks by Strategy
        RankStrategically --> SelectCandidate: Pick Best Candidate
    }

    state "Phase 3: Verification" as Phase3 {
        SelectCandidate --> VerifyEdge: Verify Frontier ↔ Candidate
        
        VerifyEdge --> VerificationFailed: Edge Invalid
        VerificationFailed --> SelectCandidate: Try Next Candidate
        
        VerifyEdge --> EdgeVerified: Edge Valid
    }

    state "Phase 4: Expansion" as Phase4 {
        EdgeVerified --> CheckBridge: Check Candidate ↔ Target
        
        CheckBridge --> PathFound: Connection Verified!
        CheckBridge --> UpdateFrontier: No Direct Connection
        
        UpdateFrontier --> GenerateQueries: Recurse from New Frontier
    }

    PathFound --> [*]: Success
    
    SelectCandidate --> Backtrack: No Candidates Left
    Backtrack --> GenerateQueries: Retry with Different Queries?
    Backtrack --> [*]: Failure (Max Hops/Budget)
```

## Key Optimizations

1. **Bridge Suggestions:**
   - Before searching, LLM suggests specific real people (e.g., "Kanye West") who likely connect the two targets.
   - These generate high-priority queries (`"Frontier Kanye West"`).

2. **Early Stopping (DFS):**
   - The search loop processes queries one-by-one.
   - If a query yields high-confidence candidates (e.g., >90%), we **stop searching** immediately.
   - This saves API budget by skipping lower-priority queries.

3. **Strategic Ranking:**
   - Candidates are re-ranked by the LLM based on their likelihood to connect to the final target (industry, social circles), not just visual confidence.
