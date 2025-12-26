# 03_runtime_workflow_state_machine.md

## Purpose

Define the **exact runtime workflow** for the on-demand “visual degrees” agent, implemented as a **Cloudflare Worker state machine** with **ephemeral KV memory**. This document is the execution spec Cursor should follow.

---

## Fixed Parameters (MVP Defaults)

* **Max hops:** 6
* **Images per search expansion:** 5 (first 5 only)
* **CV verification:** Amazon Rekognition `RecognizeCelebrities`
* **Confidence threshold:** 80%
* **Crowd penalty rules:** none
* **Memory:** Cloudflare KV (TTL minutes)
* **LLM:** Gemini now; later Llama 3.3 via Workers AI
* **Edge acceptance:** requires ≥1 evidence image where both endpoints detected ≥80%

---

## Worker State Machine (Top-Level States)

### State S0: Initialize Session

**Inputs**

* `sessionId`
* `personA`, `personB`
* optional `options` (future)

**Actions**

* Normalize names (trim, collapse spaces)
* Initialize run metadata:

  * `runId`
  * `hopLimit = 6`
  * `confidenceThreshold = 80`
  * `imagesPerQuery = 5`
  * budgets (see below)
* Write initial state to KV with TTL (e.g., 10–30 minutes)

**Outputs (stream)**

* `status`: “Starting investigation…”

---

### State S1: Direct Edge Attempt (A ↔ B)

**Goal**
Try to verify a direct visual edge between A and B.

**Actions**

1. Generate query list:

   * `q1 = "{A} {B}"`
   * (optional fallback query templates if empty results)
2. Call Google PSE image search with `num=5`.
3. For each returned image URL (up to 5):

   * De-dup (skip if already processed in this session)
   * Fetch image bytes
   * Call Rekognition `RecognizeCelebrities(imageBytes)`
   * Parse results and check if both A and B are present with confidence ≥80

**If verified**

* Accept edge `A-B`
* Store evidence in KV
* Transition to **S6 (Finalize Success)**

**If not verified**

* Transition to **S2 (Candidate Discovery)**

**Outputs (stream)**

* `status`: “Searching for direct visual connections…”
* Optional `evidence` events if any partial evidence found (e.g., A present but not B)

---

### State S2: Candidate Discovery (from A-side or current frontier)

**Goal**
Find strong intermediate candidates that visually connect with the current frontier node(s).

**Actions**

1. Choose a frontier node to expand (initially `A`)
2. Generate candidate-discovery queries, e.g.:

   * `"{frontier} with celebrities"`
   * `"{frontier} event"`
   * `"{frontier} awards"`
     (Keep list short to respect budgets.)
3. For each discovery query:

   * Call PSE (num=5)
   * For each image:

     * Fetch bytes
     * Rekognition
     * Collect co-appearing celebrities with confidence ≥80

**Candidate set construction**

* Build a map:

  * `candidateName -> {count, bestConfWithFrontier, evidenceRefs[]}`
* Only include candidates that:

  * co-appear with frontier in ≥1 image
  * have confidence ≥80

**Store**

* Save candidates + supporting evidence references to KV

**Transition**

* to **S3 (LLM Select Next Expansion)**

**Outputs (stream)**

* `status`: “Expanding search to find strong intermediates…”

---

### State S3: LLM Select Next Expansion

**Goal**
Use LLM to choose which intermediate(s) to try next and which search templates to run.

**Inputs to LLM**

* Current target: `B`
* Frontier: `frontier` (initially A)
* Candidate list with counts/confidence summaries
* Remaining hop budget
* Budget remaining (search calls, Rekognition calls)

**LLM Output (strict JSON)**

* `nextCandidates`: ordered list (1–2 items recommended)
* `searchQueries`: templated queries to run next
* `narration`: short text

**Validation**

* If LLM output invalid JSON → fallback heuristic:

  * pick candidate with highest `bestConfWithFrontier`, tie-breaker by count

**Transition**

* to **S4 (Verify Next Edge)**

**Outputs (stream)**

* `status`: LLM narration (e.g., “Trying an expansion via Kanye West…”)

---

### State S4: Verify Next Edge (Frontier ↔ Candidate)

**Goal**
Verify that the chosen intermediate `X` has a valid evidence edge with the current frontier `F`.

**Actions**

1. Build verification queries (keep minimal):

   * `"{F} {X}"`
   * `"{F} {X} event"`
2. PSE search (num=5 each query, but enforce budgets)
3. For each of the first 5 images per query:

   * Fetch bytes
   * Rekognition
   * Check if both F and X appear ≥80

**If verified**

* Accept edge `F-X`, store evidence
* Update frontier/path state
* Transition to **S5 (Bridge Toward Target)**

**If not verified**

* Mark candidate X as failed for this frontier
* If more candidates available → back to **S3**
* Else → back to **S2** with an alternate frontier strategy (see “Frontier Strategy”)

**Outputs (stream)**

* `evidence`: edge card if verified
* `status`: “Unable to verify this intermediate; trying another…”

---

### State S5: Bridge Toward Target (Candidate ↔ B) or Continue Expansion

**Goal**
Attempt to connect from the newly verified node toward the target B.

**Actions**
Given current verified chain ending at `X`:

1. Direct attempt `"{X} {B}"`:

   * PSE num=5
   * Rekognition verify
   * If verified → accept `X-B` edge and finish
2. If not verified:

   * Set frontier = X
   * Increment hop depth
   * If hop depth < 6:

     * Go to **S2** (candidate discovery from X)
   * Else:

     * Go to **S7 (Finalize Failure)**

**Outputs (stream)**

* `status`: “Checking whether {X} connects directly to {B}…”
* `status`: “No direct edge found; expanding again…”

---

### State S6: Finalize Success

**Goal**
Return final path, confidence map, and graph payload.

**Actions**

* Build ordered `path[]` from KV stored edges
* Compute confidence:

  * per edge: `edge_conf = max(min(confA, confB))` over valid images
  * path bottleneck: `min(edge_conf_i)`
  * path cumulative: product(edge_conf_i / 100)
* Build graph payload:

  * nodes = unique persons in path (optionally include verified side nodes)
  * edges = verified edges only
  * evidence refs per edge
* Return final event `final`

**Outputs (stream)**

* `final`: `{ path, edges, confidenceMap, graph }`

---

### State S7: Finalize Failure

**Goal**
Return an honest failure message.

**Actions**

* Provide failure result including:

  * attempted hop depth
  * budgets exhausted vs hop limit reached
* No speculative path

**Outputs (stream)**

* `no_path`: “No verified visual connection found within 6 degrees at ≥80% confidence.”

---

## Frontier Strategy (MVP)

* Default: expand from `A` toward `B` (one-sided search)
* When repeated failures occur (optional):

  * switch to expanding from `B` (reverse) and attempt meet-in-the-middle
  * still no precomputed graph; still evidence-driven

MVP can remain one-sided to keep costs predictable.

---

## KV Data Model (Recommended)

All keys prefixed with: `vd:{sessionId}:{runId}:...`

### Session / run metadata

* `meta`:

  * `{ personA, personB, startedAt, hopLimit, threshold, budgets }`

### Dedup sets

* `seen:queries` (string set serialized)
* `seen:images` (string set serialized)

### Candidates

* `candidates:{frontier}`:

  * `{ candidateName: {count, bestConf, evidenceRefs[]} }`

### Verified edges

* `edge:{from}:{to}`:

  * `{ edgeConf, evidence[] }`

### Current path

* `path`:

  * ordered list of node names/ids

TTL: 10–30 minutes (configurable).

---

## Budgets / Safety Caps (Recommended Defaults)

These prevent runaway costs and keep latency reasonable.

* `maxSearchCalls`: 8–20 per run (depending on cost tolerance)
* `maxRekognitionCalls`: 40–120 per run (5 images × searches)
* `maxLLMCalls`: 6–12 per run
* `maxRuntimeMs`: enforce Worker time budget via early termination

On budget exhaustion → go to S7 failure with explanation.

---

## Streaming Events (Worker → UI)

Suggested event types:

* `status`: human-readable progress update
* `evidence`: verified edge card (image + source + confidence)
* `path_update`: current best chain
* `final`: final payload
* `no_path`: failure payload
* `error`: unexpected error (sanitized)

---

## Notes on Determinism

To keep behavior stable and testable:

* Enforce strict maximums (queries, images, hops)
* Validate LLM outputs (JSON only)
* Use deterministic fallback ranking when LLM fails
* Store all intermediate decisions in KV for replay/debugging
