-- Social Graph Schema for Visual Degrees
-- Stores all discovered people and their verified connections

-- People who have been searched or discovered as intermediates
CREATE TABLE IF NOT EXISTS nodes (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  thumbnail_url TEXT
);

-- Index for fast name lookups
CREATE INDEX IF NOT EXISTS idx_nodes_normalized_name ON nodes(normalized_name);

-- Verified connections between people
CREATE TABLE IF NOT EXISTS edges (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  confidence INTEGER NOT NULL,
  discovered_at TEXT NOT NULL DEFAULT (datetime('now')),
  best_evidence_url TEXT,
  best_evidence_thumbnail TEXT,
  context_url TEXT,
  FOREIGN KEY (source_id) REFERENCES nodes(id),
  FOREIGN KEY (target_id) REFERENCES nodes(id)
);

-- Index for efficient graph traversal
CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(source_id);
CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target_id);

-- Unique constraint to prevent duplicate edges (either direction)
CREATE UNIQUE INDEX IF NOT EXISTS idx_edges_unique ON edges(
  MIN(source_id, target_id),
  MAX(source_id, target_id)
);
