# 04_api_contracts.md

## Purpose

Define stable API contracts between:

* **Next.js chat UI (Cloudflare Pages)**
* **Cloudflare Worker orchestrator**
* Downstream integrations (Google PSE, Rekognition, LLM)

These contracts are designed for:

* Streaming investigation updates
* Evidence-first outputs
* Optional graph view payload at completion

---

## 1) Public API: Chat Query

### Endpoint

`POST /api/chat/query`

### Request (JSON)

```json
{
  "sessionId": "string",
  "personA": "string",
  "personB": "string",
  "options": {
    "hopLimit": 6,
    "confidenceThreshold": 80,
    "imagesPerQuery": 5
  }
}
```

#### Notes

* `options` is optional; defaults are enforced server-side:

  * `hopLimit=6`, `confidenceThreshold=80`, `imagesPerQuery=5`
* `sessionId` persists multi-turn context for the same user session.

---

## 2) Response: Streaming Events (SSE or chunked NDJSON)

### Transport Recommendation

* **SSE (Server-Sent Events)** for browser simplicity:

  * `Content-Type: text/event-stream`
* Alternative: newline-delimited JSON (NDJSON)

This spec uses **SSE** semantics.

---

## 3) Streaming Event Types

### Event: `status`

Used frequently to narrate progress.

```json
{
  "type": "status",
  "runId": "string",
  "timestamp": "ISO-8601",
  "message": "Searching for direct visual connections…",
  "meta": {
    "hop": 0,
    "frontier": "Person A",
    "budget": {
      "searchCallsUsed": 2,
      "rekognitionCallsUsed": 10,
      "llmCallsUsed": 1
    }
  }
}
```

---

### Event: `evidence`

Emitted only when an edge is **verified** (≥80% for both endpoints in at least one image).

```json
{
  "type": "evidence",
  "runId": "string",
  "timestamp": "ISO-8601",
  "edge": {
    "from": "Donald Trump",
    "to": "Kanye West",
    "edgeConfidence": 96,
    "evidence": [
      {
        "imageUrl": "https://...",
        "thumbnailUrl": "https://...",
        "contextUrl": "https://...",
        "title": "string",
        "detectedCelebs": [
          { "name": "Donald Trump", "confidence": 98 },
          { "name": "Kanye West", "confidence": 96 }
        ],
        "imageScore": 96
      }
    ]
  }
}
```

#### Notes

* `edgeConfidence` is computed (see confidence section below).
* `evidence[]` can include multiple images, but UI can render only the best one.

---

### Event: `path_update`

Emitted when the system updates the currently best known partial path.

```json
{
  "type": "path_update",
  "runId": "string",
  "timestamp": "ISO-8601",
  "path": ["Donald Trump", "Kanye West"],
  "meta": {
    "hop": 1
  }
}
```

---

### Event: `final`

Emitted once at completion on success.

```json
{
  "type": "final",
  "runId": "string",
  "timestamp": "ISO-8601",
  "result": {
    "status": "success",
    "personA": "Donald Trump",
    "personB": "Cardi B",
    "path": ["Donald Trump", "Kanye West", "Cardi B"],
    "edges": [
      {
        "from": "Donald Trump",
        "to": "Kanye West",
        "edgeConfidence": 96,
        "bestEvidence": {
          "imageUrl": "https://...",
          "thumbnailUrl": "https://...",
          "contextUrl": "https://...",
          "title": "string",
          "detectedCelebs": [
            { "name": "Donald Trump", "confidence": 98 },
            { "name": "Kanye West", "confidence": 96 }
          ],
          "imageScore": 96
        }
      },
      {
        "from": "Kanye West",
        "to": "Cardi B",
        "edgeConfidence": 94,
        "bestEvidence": {
          "imageUrl": "https://...",
          "thumbnailUrl": "https://...",
          "contextUrl": "https://...",
          "title": "string",
          "detectedCelebs": [
            { "name": "Kanye West", "confidence": 96 },
            { "name": "Cardi B", "confidence": 94 }
          ],
          "imageScore": 94
        }
      }
    ],
    "confidence": {
      "pathBottleneck": 94,
      "pathCumulative": 0.9024
    },
    "graph": {
      "nodes": [
        { "id": "n1", "name": "Donald Trump" },
        { "id": "n2", "name": "Kanye West" },
        { "id": "n3", "name": "Cardi B" }
      ],
      "edges": [
        {
          "id": "e1",
          "from": "n1",
          "to": "n2",
          "edgeConfidence": 96,
          "evidenceRefs": ["ev1"]
        },
        {
          "id": "e2",
          "from": "n2",
          "to": "n3",
          "edgeConfidence": 94,
          "evidenceRefs": ["ev2"]
        }
      ],
      "evidence": [
        {
          "id": "ev1",
          "imageUrl": "https://...",
          "thumbnailUrl": "https://...",
          "contextUrl": "https://...",
          "title": "string"
        },
        {
          "id": "ev2",
          "imageUrl": "https://...",
          "thumbnailUrl": "https://...",
          "contextUrl": "https://...",
          "title": "string"
        }
      ]
    },
    "disclaimer": "This result shows visual co-presence in public images, not necessarily a personal relationship."
  }
}
```

---

### Event: `no_path`

Emitted once at completion when no path is verified under constraints.

```json
{
  "type": "no_path",
  "runId": "string",
  "timestamp": "ISO-8601",
  "result": {
    "status": "no_path",
    "personA": "string",
    "personB": "string",
    "message": "No verified visual connection found within 6 degrees at ≥80% confidence.",
    "meta": {
      "hopLimit": 6,
      "confidenceThreshold": 80,
      "budgets": {
        "searchCallsUsed": 10,
        "rekognitionCallsUsed": 50,
        "llmCallsUsed": 6
      }
    }
  }
}
```

---

### Event: `error`

Emitted if an unexpected error occurs.

```json
{
  "type": "error",
  "runId": "string",
  "timestamp": "ISO-8601",
  "message": "An unexpected error occurred.",
  "meta": {
    "category": "INTEGRATION_ERROR | TIMEOUT | VALIDATION_ERROR"
  }
}
```

---

## 4) Confidence Calculation Contract (Backend)

Backend must compute and include confidence values consistently.

### Evidence acceptance

An image is valid evidence for edge (P, Q) if:

* Rekognition detects P with confidence ≥ 80
* Rekognition detects Q with confidence ≥ 80

### Per-image evidence score

`imageScore = min(conf(P), conf(Q))`

### Edge confidence

`edgeConfidence = max(imageScore over all valid evidence images for that edge)`

### Path confidence

* `pathBottleneck = min(edgeConfidence_i)`
* `pathCumulative = Π(edgeConfidence_i / 100)`
  Returned as a decimal (0–1), e.g. `0.9024`.

---

## 5) Name Normalization (Minimal Contract)

To reduce mismatch:

* Trim whitespace
* Collapse repeated spaces
* Case-insensitive comparison for matching Rekognition names
* Do not invent aliases; treat Rekognition’s returned celebrity names as canonical for verification

---

## 6) Client Rendering Requirements

The Next.js UI must support:

* Streaming status messages
* Evidence cards keyed by `(from,to)` edge
* Path updates
* Final result summary
* Optional graph view rendering from `result.graph`

Graph view must display **only verified nodes/edges** from `final.result.graph`.

---
