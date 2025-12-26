# 05_integrations_google_pse.md

## Purpose

Define the **image retrieval layer** using **Google Programmable Search Engine (Custom Search JSON API)**. This layer performs **pure retrieval** (no reasoning), returning structured JSON containing candidate images and their source pages.

This is always **Step 1** in the pipeline:
`Text Query → Google PSE (images) → CV verification → LLM planning/narration → path output`

---

## Service

**Google Programmable Search Engine (Custom Search JSON API)**

### Required configuration

* Google API key with Custom Search enabled
* Programmable Search Engine ID (`cx`)
* Image search enabled in the PSE settings
* Web-wide search enabled (no restrictive site filters unless explicitly desired)

---

## Request (HTTP)

### Endpoint

`GET https://www.googleapis.com/customsearch/v1`

### Required query parameters

* `key`: API key
* `cx`: search engine id
* `q`: query string
* `searchType=image`: enables image search
* `num=5`: **MVP fixed limit (process first 5 images only)**

### curl example

```bash
curl -G "https://www.googleapis.com/customsearch/v1" \
  --data-urlencode "key=YOUR_API_KEY" \
  --data-urlencode "cx=YOUR_SEARCH_ENGINE_ID" \
  --data-urlencode "q=donald trump cardi b" \
  --data-urlencode "searchType=image" \
  --data-urlencode "num=5"
```

---

## Response Fields (Authoritative Mapping)

From the JSON response:

* `items[].link`
  **Direct image URL** (primary)
* `items[].image.thumbnailLink`
  **Thumbnail URL** (UI rendering / preview)
* `items[].image.contextLink`
  **Context webpage URL** where the image appears (source/attribution)
* `items[].title`
  **Image title** (optional display)

### Minimal extracted record

```json
{
  "imageUrl": "items[].link",
  "thumbnailUrl": "items[].image.thumbnailLink",
  "contextUrl": "items[].image.contextLink",
  "title": "items[].title"
}
```

---

## Query Templates (MVP)

All queries must enforce `num=5`. The Worker generates queries based on the current state.

### Direct verification query

* `"{A} {B}"`

### Expansion / discovery queries

* `"{A} with celebrities"`
* `"{A} event"`
* `"{A} awards"`
* `"{X} {B}"`
* `"{X} {B} event"`

**Rule:** keep the number of queries small to respect budgets (e.g., 1–3 per state).

---

## Retrieval Rules (Hard)

* Always process **only the first 5 image results** returned (`num=5`)
* De-duplicate by `imageUrl` within a session
* Skip results missing `imageUrl` or `contextUrl`
* No inference at retrieval stage

---

## Error Handling / Gotchas

* Endpoint must be exactly: `/customsearch/v1` (no trailing slash)
* Max `num` supported by API is 10, but MVP uses **5**
* If results are empty:

  * confirm PSE is not restricted by site filters
  * try a fallback query template:

    * add `"event"` or remove extra keywords
* Respect quota and rate limits (budgeted by Worker)

---

## Optional Enhancement (Not Required for MVP)

### Dual request strategy

If you want “article links” in addition to image evidence, issue a second request without `searchType=image`:

* `q="{A} {B} event"`
* Use those results as additional context links (not identity evidence)

MVP does not require this.

---

## Integration Contract (Worker → Downstream)

The retrieval layer produces an ordered list of up to 5 candidate images:

```json
{
  "query": "string",
  "results": [
    {
      "imageUrl": "string",
      "thumbnailUrl": "string",
      "contextUrl": "string",
      "title": "string"
    }
  ]
}
```

These results are passed to CV verification. The system must not treat retrieval results as proof of connection until verified by Rekognition.

---
