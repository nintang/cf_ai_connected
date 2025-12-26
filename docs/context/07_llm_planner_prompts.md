# 07_llm_planner_prompts.md

## Purpose

Define how the LLM is used for **guided expansion** and **chat narration** without ever becoming the authority for identity or relationships.

The LLM is a **planner + narrator**.
**Amazon Rekognition is the sole identity verifier.**
Edges exist **only** when backed by verified image evidence (confidence ≥ 80).

---

## LLM Providers

* **Now (MVP):** Gemini (external)
* **Later:** **Llama 3.3 via Cloudflare Workers AI**

Both providers must follow identical I/O contracts and safety constraints.

---

## LLM Allowed Tasks

The LLM MAY:

1. Choose the next intermediate candidate(s) to explore from a provided list
2. Suggest the next Google PSE queries (templates) to run
3. Provide short narration/status updates for the chat UI
4. Provide a final explanation strictly tied to verified evidence

The LLM MUST NOT:

* Identify faces
* Guess who is in an image
* Invent events, dates, or “relationships”
* Create an edge without verified evidence
* Override Rekognition names/confidence
* Reference “private” or non-public sources

---

## Inputs to the LLM (What the Worker Provides)

### Core inputs

* `personA`, `personB`
* `frontier`: current node being expanded (e.g., A, or an intermediate)
* `hopUsed`, `hopLimit`
* Budget status:

  * search calls used/remaining
  * rekognition calls used/remaining
  * llm calls used/remaining
* Candidate intermediates extracted from Rekognition results (not guessed)
* Known verified edges so far (if any)
* Failed candidates list (to avoid repeating)

### Candidate schema (LLM input)

Each candidate must be grounded in CV outputs:

```json
{
  "name": "Kanye West",
  "coappearCount": 2,
  "bestCoappearConfidence": 96,
  "evidenceContextUrls": ["https://..."],
  "notes": "Detected with frontier in at least one image"
}
```

---

## Output Contract (Strict JSON Only)

The LLM must output **only** JSON matching this schema:

```json
{
  "nextCandidates": ["string"],
  "searchQueries": ["string"],
  "narration": "string",
  "stop": false,
  "reason": "string"
}
```

### Field rules

* `nextCandidates`: 1–2 names max (ordered)
* `searchQueries`: 1–4 query strings max (ordered)
* `narration`: one short sentence for chat (no claims beyond “visual evidence search”)
* `stop`: `true` only if budgets/hops make continuing pointless
* `reason`: brief justification referencing candidate stats (count/confidence), not speculation

---

## Prompt Template: Planner (Used Every Expansion Step)

### System message (fixed)

* You are a planning assistant for a visual evidence pipeline.
* You do not identify faces.
* You only choose what to search next using the candidates provided.
* You must output strict JSON and nothing else.
* You must not invent relationships, events, or facts.
* Select candidates that maximize probability of finding verified image co-presence with the target.

### User message (example payload)

```json
{
  "task": "select_next_expansion",
  "personA": "Donald Trump",
  "personB": "Cardi B",
  "frontier": "Donald Trump",
  "hopUsed": 0,
  "hopLimit": 6,
  "confidenceThreshold": 80,
  "budgets": {
    "searchCallsRemaining": 8,
    "rekognitionCallsRemaining": 50,
    "llmCallsRemaining": 6
  },
  "verifiedEdges": [],
  "failedCandidates": ["Some Candidate"],
  "candidates": [
    {
      "name": "Kanye West",
      "coappearCount": 2,
      "bestCoappearConfidence": 96,
      "evidenceContextUrls": ["https://example.com/a"]
    },
    {
      "name": "Ivanka Trump",
      "coappearCount": 3,
      "bestCoappearConfidence": 99,
      "evidenceContextUrls": ["https://example.com/b"]
    }
  ]
}
```

---

## Query Generation Rules (LLM Guidance)

The LLM may propose search queries using only these patterns:

### Verification queries

* `"{frontier} {candidate}"`
* `"{frontier} {candidate} event"`

### Bridging queries toward target

* `"{candidate} {personB}"`
* `"{candidate} {personB} event"`

### Discovery queries (only if candidates list is empty)

* `"{frontier} with celebrities"`
* `"{frontier} event"`

**Constraint:** the Worker always enforces `num=5` images per query.

---

## Worker Validation of LLM Output (Required)

Before using the LLM output, the Worker must validate:

* Output is valid JSON
* `nextCandidates` contains names that exist in the provided `candidates` list
* `searchQueries` count is within limits
* No disallowed language (e.g., “they are friends”, “they collaborated”)
* If invalid → fallback heuristic selection:

  * choose candidate with highest `bestCoappearConfidence`, tie-break by `coappearCount`

---

## Narration Guidance (Chat Style)

Narration must remain conservative and evidence-based, e.g.:

* “No direct verified images found. Expanding via high-confidence intermediates.”
* “Trying an expansion via Kanye West due to repeated verified co-appearances.”
* “Verifying co-presence with new image evidence…”

Avoid:

* “They are connected because…”
* “They attended…”
* Any claim beyond the pipeline’s verified steps

---

## Final Explanation Prompt (Only After Success)

The Worker may call the LLM once at the end to produce a concise explanation **strictly from the verified path**.

### Input

* The verified path nodes
* The verified edges with best evidence summary (confidence + context URLs)

### Output (strict JSON)

```json
{
  "summary": "string",
  "disclaimer": "string"
}
```

### Required disclaimer

“This result indicates visual co-presence in public images, not necessarily a personal relationship.”

---

## Migration Note (Gemini → Llama 3.3 on Workers AI)

* Keep the same schema and validation.
* Treat the LLM as interchangeable behind the Worker.
* Do not change the planner’s authority boundaries when migrating providers.
