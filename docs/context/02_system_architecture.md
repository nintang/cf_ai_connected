# 02_system_architecture.md

## Architecture Overview

**Visual Degrees** is a chat-first, on-demand “visual six degrees” system that produces a **verified connection path** between two **public figures** using:

- **Google Programmable Search (PSE / Custom Search JSON API)** for **image retrieval**
- **Amazon Rekognition (RecognizeCelebrities)** for **celebrity identity verification**
- **LLM (Gemini now; Llama 3.3 via Workers AI later)** for **guided expansion + narration**
- **Cloudflare Worker** as the **orchestrator/state machine**
- **Cloudflare KV** as **ephemeral query/session memory (TTL minutes)**
- **Next.js** for the frontend chat UI, deployed on **Cloudflare Pages**

No precomputed global graph is stored. The graph is constructed **lazily at query time** and emitted as a **post-run artifact** for optional graph view.

---

## Repository Model

**Monorepo (recommended)** with two deploy targets:
- `apps/web` → Next.js on Cloudflare Pages
- `apps/worker` → Cloudflare Worker (orchestrator API)

Shared packages:
- `packages/contracts` (schemas/types)
- `packages/core` (confidence math, query templates)
- `packages/integrations` (Google PSE, Rekognition, LLM clients)

This avoids contract drift between UI and orchestration logic.

---

## Components and Responsibilities

### Frontend (Next.js on Cloudflare Pages)

**Responsibilities**
- Chat UI (input + streaming messages)
- Evidence cards (thumbnail, confidence, source link)
- Final summary (path + confidence map)
- Optional graph view (client-side rendering from backend-provided graph JSON)

**Non-responsibilities**
- No image retrieval logic
- No CV verification
- No direct calls to external APIs (all via Worker API)

---

### Orchestrator API (Cloudflare Worker)

**Responsibilities**
- Implements bounded exploration (≤6 hops)
- Enforces constraints:
  - Process **first 5 images** per search expansion
  - Accept evidence only if both endpoints are detected at **≥ 80%**
  - **No crowd penalty rules**
- Coordinates external calls:
  - Google PSE (retrieval)
  - Rekognition (verification)
  - LLM (planning/narration)
- Maintains session/query state via KV
- Streams progress + evidence events back to the UI
- Produces final artifact:
  - verified path
  - evidence set
  - confidence map
  - graph JSON payload

**Implementation note**
The Worker is a **state machine** (not an LLM app). It controls hop budget, retries, dedupe, and termination.

---

### Ephemeral State (Cloudflare KV)

**Responsibilities**
- Stores session/query-scoped state with TTL minutes:
  - visited queries
  - processed image URLs
  - candidate intermediates
  - verified edges (with evidence pointers)
  - partial paths and hop depth
- Prevents repeated work across turns in the same session

**Constraints**
- Not a global relationship graph
- Not long-term storage

---

### LLM (Gemini now → Llama 3.3 via Workers AI later)

**Responsibilities**
- Guided expansion:
  - select next intermediate(s) from candidate list
  - propose next query templates
- Narration:
  - status updates
  - concise explanation of why a candidate was chosen
- Summarization:
  - final explanation strictly tied to verified evidence

**Prohibitions**
- No face identification
- No relationship claims beyond visual co-presence
- No edge creation without verified evidence

---

### Image Retrieval (Google Programmable Search Engine)

**Responsibilities**
- Retrieve candidate image URLs + thumbnails + context links for a query

**Constraints**
- Use `searchType=image`
- Process **only first 5 results** per expansion step

---

### Verification (Amazon Rekognition RecognizeCelebrities)

**Responsibilities**
- Detect celebrities present in an image
- Return name + confidence + bounding box per detected celebrity
- Acts as the only authority for “who is in the image”

**Constraints**
- Accept evidence only if both endpoints are detected at **≥ 80%**

---

## Data Flow (Text)

1. User enters query (Person A, Person B) in the Next.js chat UI.
2. UI calls the Worker API endpoint (session-based) requesting a connection.
3. Worker attempts direct retrieval: Google PSE `"A B"` → first 5 images.
4. Worker verifies each image via Rekognition:
   - If a direct edge is verified, produce final result.
   - Otherwise, Worker gathers candidate intermediates from Rekognition detections and uses the LLM to select next expansions.
5. Worker repeats bounded expansion up to 6 hops.
6. Worker streams updates (status, evidence cards, partial paths) to the UI.
7. Worker emits the final result with confidence map and a graph JSON payload.
8. Next.js UI optionally renders the graph view from that payload.

---

## Mermaid Diagram (End-to-End Dataflow)

```mermaid
flowchart TD
  U[User] --> UI["Next.js Chat UI<br/>Cloudflare Pages"]
  UI -->|"POST /api/chat/query<br/>SSE/stream"| W["Cloudflare Worker<br/>Orchestrator / State Machine"]

  W -->|Read/Write TTL state| KV["Cloudflare KV<br/>Ephemeral Session Memory"]

  W -->|"Image search<br/>q + searchType=image + num=5"| PSE["Google Programmable Search<br/>Custom Search JSON API"]
  PSE -->|"items[].link<br/>items[].image.thumbnailLink<br/>items[].image.contextLink"| W

  W -->|Fetch image bytes (top 5)| IMG[Image Fetch]
  IMG --> W

  W -->|"RecognizeCelebrities(image)"| REK["AWS Rekognition<br/>Celebrity Recognition"]
  REK -->|Celebrities + confidence| W

  W -->|Planning/narration only| LLM["LLM Planner<br/>Gemini now → Llama 3.3 (Workers AI)"]
  LLM -->|Next candidates + query templates| W

  W -->|Stream status/evidence/path updates| UI
  W -->|Final result + confidence map + graph JSON| UI

  UI -->|Optional| GV["Graph View (client-side)"]
