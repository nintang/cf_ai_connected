# 01_scope_constraints.md

## Scope

Build an **on-demand visual connection finder** for **public figures** that returns **evidence-backed paths** (≤6 hops) based on **co-appearance in public images**.

The system operates as:

* **Retrieval (Google PSE)** → **Verification (Rekognition)** → **LLM planning** → **Explainable output**
* No precomputed global relationship graph.

---

## Hard Constraints (Must Not Change)

### Entities

* **Public figures only** (initial scope)
* People are represented by **names** (plus optional internal IDs later)

### Degrees / Path Limits

* **Max hops:** 6
* Search/expansion must respect hop budget at all times.

### Image Retrieval

* Use **Google Programmable Search Engine (Custom Search JSON API)**:

  * `searchType=image`
  * Process **only the first 5 images** returned per search expansion
* Must collect for each image:

  * direct image URL
  * thumbnail URL
  * context/source page URL
  * title (optional)

### Computer Vision Verification

* Use **Amazon Rekognition — RecognizeCelebrities**
* Rekognition is the **sole authority** for “who is in the image”
* The system must not “guess” identities.

### Confidence Threshold

* **Minimum confidence:** **80%**
* For an image to count as evidence for edge (P, Q):

  * P detected with confidence ≥ 80
  * Q detected with confidence ≥ 80

### Crowd Penalty Rules

* **None**
* Do not apply crowd-size penalties, face-count heuristics, or “small group boosts” in MVP.

### Evidence Requirement

* Every accepted edge must have:

  * ≥1 valid evidence image
  * confidence computed from that evidence
  * source context link

### LLM Role Restrictions

LLM may be Gemini now, later Llama 3.3 via Workers AI.

LLM is allowed to:

* Choose next intermediate(s) to explore
* Propose next search query templates
* Narrate the investigation
* Summarize verified results into explanations

LLM is not allowed to:

* Identify faces
* Infer relationships beyond **visual co-presence**
* Invent events, dates, or facts
* Override Rekognition identity results
* Create edges without verified evidence

### Memory / Graph Storage

* **No precomputed global graph**
* Store only **ephemeral, query-scoped state** (TTL minutes)
* No long-term biometric storage
* Do not persist face embeddings as a primary mechanism (Rekognition is used)

---

## Output Requirements (User-Facing)

### Success Output

Must return:

* Path (≤6 hops)
* Per-edge evidence card:

  * image thumbnail + image URL
  * context/source page link
  * edge confidence
* Confidence map:

  * edge confidences
  * path bottleneck confidence
  * path cumulative confidence
* Clear disclaimer:

  * “This indicates visual co-presence in public images, not necessarily a personal relationship.”

### Failure Output

If no verified path within constraints:

* Return an honest “no verified visual connection found within 6 degrees at ≥80% confidence”
* No speculative “maybe connected via…” suggestions without evidence

---

## Operational Constraints (Recommended)

* Enforce per-request budgets:

  * max expansions / searches
  * max Rekognition calls
  * timeouts per hop
* De-dup:

  * avoid repeating the same query
  * avoid reprocessing identical image URLs within a session

---

## Explicit Non-Goals

* No inference of private relationships
* No scraping private sources
* No “social graph” claims
* No guarantee every pair can be connected
* No global ranking of celebrity influence (out of scope)

---
