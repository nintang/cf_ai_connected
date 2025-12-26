# 06_integrations_rekognition.md

## Purpose

Define the **computer vision verification layer** using **Amazon Rekognition — RecognizeCelebrities**. This layer is the **sole authority** for identifying which public figures appear in an image and at what confidence.

Pipeline position:
`Google PSE (candidate images) → Gemini Flash (verify co-presence) → Rekognition (verify identities) → edge acceptance + confidence math → LLM planning/narration`

---

## Service

**Amazon Rekognition**
API: `RecognizeCelebrities`

### Why this service

* Specifically optimized for **public figure recognition**
* Returns:

  * celebrity name
  * confidence score
  * face bounding box
* Eliminates the need to train or host face models for MVP

---

## Input Contract (Worker → Rekognition)

Each call processes **one image** (from Google PSE top 5).

**Input options**

* `Image.Bytes` (recommended): pass fetched image bytes
* `Image.S3Object` (optional): if using temporary R2→S3 bridge (not required for MVP)

**MVP recommendation**

* Fetch image bytes in Worker
* Submit as `Image.Bytes` to `RecognizeCelebrities`

---

## Output Contract (Rekognition → Worker)

Rekognition returns (conceptually):

* `CelebrityFaces[]`: recognized celebrities

  * `Name`
  * `MatchConfidence`
  * `Face.BoundingBox`
* (Ignore or log `UnrecognizedFaces` for MVP)

### Minimal extracted record (per celebrity)

```json
{
  "name": "string",
  "confidence": 0,
  "boundingBox": { "Left": 0, "Top": 0, "Width": 0, "Height": 0 }
}
```

---

## Evidence Acceptance Rules (Hard)

### Confidence threshold

* **Minimum confidence:** **80%**

### Image is valid evidence for edge (P, Q) iff:

* `P` is detected with confidence ≥ 80
* `Q` is detected with confidence ≥ 80
* **AND** the image passes the Gemini Flash **visual co-presence check** (confirming it is not a collage/split-screen).

No crowd penalty rules. No group-size weighting.

---

## Name Matching Rules (MVP)

Rekognition provides canonical celebrity names. Matching should be:

* Case-insensitive exact match
* Whitespace-trimmed
* Do not invent aliases
* If user-provided name differs from Rekognition canonical name, treat as **not matched** unless you have an explicit mapping (optional later)

---

## Per-image Scoring

For a candidate edge (P, Q) in a given image:

* Let `confP = confidence returned for P`
* Let `confQ = confidence returned for Q`

**Per-image evidence score**
`image_score = min(confP, confQ)`

Reason: weakest detection is the bottleneck.

---

## Edge Confidence Aggregation

An edge (P, Q) can have multiple valid evidence images.

**Edge confidence**
`edge_conf = max(image_score over all valid evidence images)`

Also store optional supporting metrics (recommended for debugging/UI):

* `validEvidenceCount`
* `bestEvidence` (the image with max `image_score`)

---

## Path Confidence Aggregation

Given a path with edges `e1..ek`:

**Bottleneck confidence**
`path_bottleneck = min(edge_conf_i)`

**Cumulative confidence**
`path_cumulative = Π(edge_conf_i / 100)`

Return cumulative as a decimal 0–1 (e.g., `0.9024`).

---

## Evidence Record Schema (Per Valid Image)

When a valid image supports an edge (P, Q), persist an evidence record in KV (TTL minutes):

```json
{
  "from": "P",
  "to": "Q",
  "imageUrl": "string",
  "thumbnailUrl": "string",
  "contextUrl": "string",
  "title": "string",
  "detectedCelebs": [
    { "name": "P", "confidence": 98 },
    { "name": "Q", "confidence": 96 }
  ],
  "imageScore": 96
}
```

---

## Failure Modes and Handling

### 1) Rekognition returns no celebrities

* Mark image as “no signal”
* Continue with remaining images
* Do not create edges

### 2) One endpoint detected, the other missing

* Not valid evidence
* May still be useful for candidate discovery (co-appearing celebs with frontier)

### 3) Low confidence (<80)

* Not valid evidence
* Do not “average up” or infer

### 4) API errors/timeouts

* Retry once if safe under budget
* Otherwise fail gracefully and continue with remaining images
* Surface an internal status event (sanitized) for observability

---

## Usage Patterns in the Workflow

### Direct verification

* Search `"A B"` → top 5 images
* For each image → Rekognition
* Accept edge A–B if any image meets acceptance rules

### Candidate discovery

* Search `"A with celebrities"` → top 5 images
* For each image → Rekognition
* Collect other celebs co-appearing with A at ≥80 into candidate set:

  * track counts
  * track best co-appearance confidence

### Intermediate verification

* Verify A–X and X–B edges using the same process

---

## Security / Privacy Constraints (MVP)

* Do not store face embeddings
* Do not store image bytes long-term
* Store only:

  * URLs and metadata
  * minimal evidence records (TTL minutes)
* Treat Rekognition results as authoritative for identity and confidence

