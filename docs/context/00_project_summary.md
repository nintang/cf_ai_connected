# 00_project_summary.md

## Project Name

**Visual Degrees** (working name)

## One-sentence Summary

A chat-first product that finds **visual, evidence-backed “degrees of separation”** between **public figures** using **live image search** + **celebrity face verification**, building the connection graph **on-demand** (no preprocessing) and optionally rendering a **graph view** after the agent completes.

---

## Product Goal

Given two public figures (Person A, Person B), the system returns:

* A **verified path** connecting them within **≤ 6 hops** (if available)
* A **confidence map** for each hop and for the full path
* **Image evidence** + **source link** per hop (explainable by construction)
* A **graph view** users can open after completion (optional, later view)

This is **not** a social network graph. It is an **investigation-style reasoning system** with receipts.

---

## Non-goals

* No precomputed global celebrity relationship graph
* No claims about personal relationships, intent, or private associations
* No face identification by the LLM (identity is verified by CV only)
* No “crowd penalty rules” (explicitly disabled)
* No storage of biometric identifiers beyond ephemeral query/session needs

---

## Core User Experience

### Primary interface: Chat

The user asks naturally:

> “How is A connected to B?”

The agent:

* Streams reasoning steps (“Searching… verifying… expanding…”)
* Shows **evidence cards** as soon as verified edges are found
* Explains *why* it chooses intermediates (LLM as planner)
* Produces a final, concise connection path with confidence

### Secondary interface: Graph View (optional)

After the agent finishes (or on demand):

* Show a graph of **only verified nodes/edges**
* Edge thickness (or label) reflects confidence
* Clicking an edge reveals the image evidence + source links

---

## Key Constraints (Locked)

* **Public figures only** (initially)
* **Hop limit:** 6
* **Image retrieval:** Google Programmable Search Engine (Custom Search JSON API)

  * Process **first 5 images only** per search expansion
* **CV verification:** Amazon Rekognition **RecognizeCelebrities**
* **Confidence threshold:** **80%**
* **Crowd penalty rules:** **None**
* **Evidence requirement:** each accepted edge must include ≥1 image where both endpoints are detected at ≥80%
* **LLM usage:** planning + narration only (no identity inference)

---

## System Mental Model

* **Pages** = chat UI
* **Workers** = investigator (orchestrator/state machine)
* **LLM** = advisor/planner (chooses next expansions, narrates)
* **Rekognition** = witness (identity verifier)
* **Google PSE** = evidence retrieval (image URLs + context pages)
* **KV** = notepad (ephemeral memory for this query/session)
* **Graph view** = case summary (post-run visualization)

---

## High-level Architecture (Cloudflare-first)

### Frontend

* **Cloudflare Pages** hosts the chat web app.
* UI supports:

  * chat stream
  * evidence cards
  * final summary
  * “View Graph” post-completion

### Backend Orchestration

* **Cloudflare Workers** runs the full investigation loop:

  * hop control (≤6)
  * budgets/timeouts
  * calls to retrieval + CV + LLM
  * confidence calculations
  * streaming status updates back to UI

### LLM

* **Now:** Gemini (external LLM)
* **Later:** **Llama 3.3 via Workers AI**
* LLM tasks:

  * choose high-value intermediates
  * decide next search query templates
  * produce concise narration and final explanation
* LLM is never the authority for identity or relationships.

### Memory / State

* **Cloudflare KV** for ephemeral per-session/per-query state (TTL minutes):

  * visited queries
  * verified edges and evidence
  * candidate intermediate rankings
  * partial paths + hop depth

Optional later:

* **Cloudflare Vectorize** to rank intermediates or dedupe expansions
* **Cloudflare R2** only for temporary image blobs (if needed), not required for MVP

### External Services

* **Google Programmable Search Engine** (image retrieval)
* **Amazon Rekognition** (celebrity detection + confidence)

---

## Runtime Workflow (Conceptual)

1. **Input**: PersonA, PersonB
2. **Direct attempt**:

   * Search images for `"A B"` (top 5)
   * Verify with Rekognition
   * If evidence exists → accept direct edge and finish
3. **Expansion** (no prebuilt graph):

   * Search images for queries that include A (e.g., `"A with celebrities"`, `"A event"`)
   * Rekognition returns other celebrities co-appearing with A → candidate intermediates
   * LLM ranks/chooses best intermediate(s) to try
   * For chosen intermediate X:

     * Verify edge A–X via images
     * Verify edge X–B via images
   * Repeat until path found or hop=6
4. **Output**:

   * Verified path (≤6 hops) OR “no verified path”
   * Evidence per edge
   * Confidence map per edge and path
   * Graph payload for optional visualization

---

## Evidence & Confidence Model

### Evidence acceptance

An image is valid for edge (P, Q) if Rekognition detects:

* P at confidence ≥ 80
* Q at confidence ≥ 80

### Per-image evidence score

`image_score = min(conf(P), conf(Q))`

### Edge confidence

`edge_conf = max(image_score over all valid images for that edge)`

### Path confidence (two metrics)

* **Bottleneck**: `min(edge_conf_i)`
* **Cumulative**: `Π(edge_conf_i / 100)`

Both are returned to the UI.

---

## Output Format (User-facing)

The final answer must include:

* Path steps with confidence:

  * A → X → … → B
* One evidence card per edge:

  * image thumbnail + image URL
  * context/source page link
  * edge confidence
* Overall path confidence (bottleneck + cumulative)
* Clear disclaimer:

  * “This shows visual co-presence in public images, not necessarily a personal relationship.”

If no path found:

* Provide an honest message:

  * “No verified visual connection found within 6 degrees at ≥80% confidence.”

---

## UI States (Chat-first; graph optional)

1. Idle / landing
2. User message (query)
3. Streaming reasoning (status updates)
4. Evidence cards appear per verified edge
5. Completion summary (path + confidence)
6. Optional graph view overlay/panel (only verified nodes/edges)
7. Failure state (no path)

---

## Implementation Priorities (MVP)

1. Pages chat UI with streaming updates
2. Worker orchestration with hop control and budgets
3. Google PSE integration (top 5 images)
4. Rekognition verification + confidence math
5. LLM planner loop (Gemini now, Llama 3.3 later)
6. Ephemeral KV memory (TTL minutes)
7. Final result + graph JSON payload (graph UI can be a later feature)

---
