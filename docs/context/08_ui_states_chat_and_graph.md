# 08_ui_states_chat_and_graph.md

## Purpose

Define the exact UI states for the **chat-first** experience with an **optional graph view** shown after completion (or on-demand). This is the UI contract Cursor should implement in the Next.js frontend.

---

## Core UX Principles

* Chat is the **investigation window** (progressive disclosure).
* Evidence is shown as **receipts** (image + source + confidence).
* Graph is a **post-run inspection artifact**, never the default.
* Only **verified** nodes/edges are rendered (no speculative candidates).

---

## UI State List (Authoritative)

### State 0 — Idle / Landing

**User sees**

* Product title
* One-line instructions
* Example prompts
* Input box enabled

**UI elements**

* Header: “Visual Degrees”
* Placeholder examples:

  * “How is A connected to B?”
  * “Connect Elon Musk to Beyoncé”

**No graph UI visible**

---

### State 1 — User Input Submitted

Triggered when the user submits a query.

**UI changes**

* Input locked briefly (or allow typing but queue messages)
* Append user message bubble to chat log
* Create a new “run” in UI state (runId, timestamps)

---

### State 2 — Streaming Reasoning (Status Events)

Represents the agent actively running.

**Driven by backend `status` streaming events**

**UI behavior**

* Show assistant message bubbles that update/append:

  * “Searching for direct visual connections…”
  * “No verified direct images found.”
  * “Expanding via high-confidence intermediates…”
* Show lightweight progress indicator (e.g., spinner)
* Optional: “Stop” button (cancels run client-side; backend may continue or stop if supported)

**No evidence cards yet unless verified edges appear**

---

### State 3 — Evidence Card Appears (Per Verified Edge)

Triggered by backend `evidence` events.

**UI behavior**

* Append an assistant message that includes an **evidence card**.
* Evidence cards are persistent in the chat log.

**Evidence Card (required fields)**

* Edge label: `From ↔ To`
* Confidence: `edgeConfidence`
* Thumbnail image (thumbnailUrl)
* Actions:

  * “Open image” (imageUrl)
  * “Open source” (contextUrl)
* Optional: show detected celebrities with confidence (collapsed by default)

**Evidence Card Layout (suggested)**

* Title row: “Donald Trump ↔ Kanye West”
* Sub-row: “Confidence: 96%”
* Thumbnail
* Links row: “Source” | “Image”

---

### State 4 — Path Update (Partial Chain)

Triggered by backend `path_update` events.

**UI behavior**

* Update a pinned “Current path” chip above the input, or append a small assistant line:

  * “Current chain: A → X”
* Keep it lightweight; do not spam.

---

### State 5 — Completion: Success

Triggered by backend `final` event.

**UI behavior**

* Stop spinner/progress indicator
* Append a final assistant message with:

  * The path (ordered)
  * Confidence map:

    * path bottleneck
    * path cumulative
  * Buttons:

    * **View Graph**
    * Show Evidence (scroll/jump to cards)
    * Ask Follow-up (focus input)

**Required final summary content**

* Path:

  * `A → X → … → B`
* Confidence:

  * `Bottleneck: 94%`
  * `Cumulative: 0.9024`
* Disclaimer text

---

### State 6 — Completion: No Path

Triggered by backend `no_path` event.

**UI behavior**

* Stop spinner/progress indicator
* Append assistant message:

  * “No verified visual connection found within 6 degrees at ≥80% confidence.”
* Optional suggestions (non-speculative):

  * “Try alternative spelling”
  * “Try a different pair”
  * “Try again later”

**No graph view offered** (or offered but disabled with explanation)

---

### State 7 — Graph View (Optional Overlay / Panel)

Triggered by clicking **View Graph** after success.

**Inputs**

* Graph payload from `final.result.graph`

**Graph rules**

* Render only:

  * Verified nodes
  * Verified edges
* Edge label or thickness reflects `edgeConfidence`
* Node label = celebrity name
* Clicking an edge opens an **Edge Evidence Drawer**

**Graph view behavior**

* Presented as modal overlay or right-side panel (recommended)
* “Back to Chat” button returns to chat without losing scroll position

---

### State 8 — Edge Evidence Drawer (Graph Interaction)

Triggered when a user clicks an edge in the graph.

**UI behavior**

* Show:

  * Edge: From ↔ To
  * Edge confidence
  * Evidence list (at least bestEvidence):

    * thumbnail
    * image link
    * source link
* Provide close control

---

## Follow-up Chat (Post-Run)

After completion, user can ask follow-ups:

* “Show me a stronger path”
* “Explain why you chose Kanye”
* “Try a different intermediate”

**UI handling**

* Same chat log, same sessionId
* Backend decides whether to reuse session memory (KV TTL) or start a new run

---

## Minimal Component Map (Next.js)

* `ChatLayout`
* `MessageList`
* `MessageBubble` (user/assistant)
* `StatusMessage` (assistant streaming)
* `EvidenceCard`
* `PathChip` (optional pinned path indicator)
* `FinalSummaryCard`
* `GraphModal` or `GraphPanel`
* `EdgeEvidenceDrawer`

---

## Event → UI Mapping

* `status` → append/update assistant status bubble
* `evidence` → append EvidenceCard message
* `path_update` → update PathChip (or append minimal message)
* `final` → append FinalSummaryCard + enable View Graph button
* `no_path` → append failure message
* `error` → append error message, stop spinner

---
