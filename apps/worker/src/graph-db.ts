/**
 * Graph Database operations for D1
 * Handles storing and retrieving nodes and edges for the social graph
 */

export interface GraphNode {
  id: string;
  name: string;
  normalized_name: string;
  first_seen_at: string;
  thumbnail_url: string | null;
}

export interface GraphEdge {
  id: string;
  source_id: string;
  target_id: string;
  confidence: number;
  discovered_at: string;
  best_evidence_url: string | null;
  best_evidence_thumbnail: string | null;
  context_url: string | null;
}

/**
 * Normalize a person's name for consistent lookups
 */
export function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ');
}

/**
 * Generate a deterministic ID for a node based on normalized name
 */
export function generateNodeId(name: string): string {
  const normalized = normalizeName(name);
  // Simple hash-like ID from name
  let hash = 0;
  for (let i = 0; i < normalized.length; i++) {
    const char = normalized.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  return `node_${Math.abs(hash).toString(36)}`;
}

/**
 * Generate a deterministic ID for an edge
 */
export function generateEdgeId(sourceId: string, targetId: string): string {
  // Always order alphabetically to ensure same ID regardless of direction
  const [first, second] = [sourceId, targetId].sort();
  return `edge_${first}_${second}`;
}

/**
 * Upsert a node into the graph database
 */
export async function upsertNode(
  db: D1Database,
  name: string,
  thumbnailUrl?: string
): Promise<GraphNode> {
  const id = generateNodeId(name);
  const normalizedName = normalizeName(name);

  // Use INSERT OR REPLACE to upsert
  await db.prepare(`
    INSERT INTO nodes (id, name, normalized_name, thumbnail_url)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      thumbnail_url = COALESCE(excluded.thumbnail_url, nodes.thumbnail_url)
  `).bind(id, name, normalizedName, thumbnailUrl || null).run();

  // Fetch the node
  const result = await db.prepare('SELECT * FROM nodes WHERE id = ?').bind(id).first<GraphNode>();
  return result!;
}

/**
 * Upsert an edge into the graph database
 * Updates confidence if new confidence is higher
 */
export async function upsertEdge(
  db: D1Database,
  sourceName: string,
  targetName: string,
  confidence: number,
  bestEvidenceUrl?: string,
  bestEvidenceThumbnail?: string,
  contextUrl?: string
): Promise<GraphEdge> {
  // Ensure both nodes exist
  const sourceNode = await upsertNode(db, sourceName);
  const targetNode = await upsertNode(db, targetName);

  const id = generateEdgeId(sourceNode.id, targetNode.id);

  // Upsert edge, keeping higher confidence
  await db.prepare(`
    INSERT INTO edges (id, source_id, target_id, confidence, best_evidence_url, best_evidence_thumbnail, context_url)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      confidence = MAX(excluded.confidence, edges.confidence),
      best_evidence_url = CASE WHEN excluded.confidence > edges.confidence THEN excluded.best_evidence_url ELSE edges.best_evidence_url END,
      best_evidence_thumbnail = CASE WHEN excluded.confidence > edges.confidence THEN excluded.best_evidence_thumbnail ELSE edges.best_evidence_thumbnail END,
      context_url = CASE WHEN excluded.confidence > edges.confidence THEN excluded.context_url ELSE edges.context_url END
  `).bind(
    id,
    sourceNode.id,
    targetNode.id,
    confidence,
    bestEvidenceUrl || null,
    bestEvidenceThumbnail || null,
    contextUrl || null
  ).run();

  const result = await db.prepare('SELECT * FROM edges WHERE id = ?').bind(id).first<GraphEdge>();
  return result!;
}

/**
 * Get all nodes in the graph
 */
export async function getAllNodes(db: D1Database): Promise<GraphNode[]> {
  const result = await db.prepare('SELECT * FROM nodes ORDER BY first_seen_at DESC').all<GraphNode>();
  return result.results;
}

/**
 * Get all edges in the graph
 */
export async function getAllEdges(db: D1Database): Promise<GraphEdge[]> {
  const result = await db.prepare('SELECT * FROM edges ORDER BY discovered_at DESC').all<GraphEdge>();
  return result.results;
}

/**
 * Get the full graph (nodes and edges) for visualization
 */
export async function getFullGraph(db: D1Database): Promise<{
  nodes: Array<{
    id: string;
    name: string;
    thumbnailUrl: string | null;
  }>;
  edges: Array<{
    id: string;
    source: string;
    target: string;
    confidence: number;
    evidenceUrl: string | null;
    thumbnailUrl: string | null;
    contextUrl: string | null;
  }>;
}> {
  const [nodesResult, edgesResult] = await Promise.all([
    getAllNodes(db),
    getAllEdges(db)
  ]);

  return {
    nodes: nodesResult.map(n => ({
      id: n.id,
      name: n.name,
      thumbnailUrl: n.thumbnail_url
    })),
    edges: edgesResult.map(e => ({
      id: e.id,
      source: e.source_id,
      target: e.target_id,
      confidence: e.confidence,
      evidenceUrl: e.best_evidence_url,
      thumbnailUrl: e.best_evidence_thumbnail,
      contextUrl: e.context_url
    }))
  };
}

/**
 * Get graph statistics
 */
export async function getGraphStats(db: D1Database): Promise<{
  nodeCount: number;
  edgeCount: number;
  avgConfidence: number;
}> {
  const [nodeCount, edgeStats] = await Promise.all([
    db.prepare('SELECT COUNT(*) as count FROM nodes').first<{ count: number }>(),
    db.prepare('SELECT COUNT(*) as count, AVG(confidence) as avg FROM edges').first<{ count: number; avg: number | null }>()
  ]);

  return {
    nodeCount: nodeCount?.count || 0,
    edgeCount: edgeStats?.count || 0,
    avgConfidence: Math.round(edgeStats?.avg || 0)
  };
}

/**
 * Path step with edge evidence
 */
export interface PathStep {
  from: string;
  fromName: string;
  to: string;
  toName: string;
  confidence: number;
  evidenceUrl: string | null;
  thumbnailUrl: string | null;
  contextUrl: string | null;
}

/**
 * Result of a path search
 */
export interface PathResult {
  found: boolean;
  path: string[];  // Node names in order
  pathIds: string[];  // Node IDs in order
  steps: PathStep[];  // Edge details for each hop
  hops: number;
  minConfidence: number;  // Bottleneck confidence
}

/**
 * Find the shortest path between two people using BFS
 * Returns the path with all evidence for each hop
 */
export async function findPath(
  db: D1Database,
  fromName: string,
  toName: string
): Promise<PathResult> {
  const fromId = generateNodeId(fromName);
  const toId = generateNodeId(toName);

  // Check if both nodes exist
  const [fromNode, toNode] = await Promise.all([
    db.prepare('SELECT * FROM nodes WHERE id = ?').bind(fromId).first<GraphNode>(),
    db.prepare('SELECT * FROM nodes WHERE id = ?').bind(toId).first<GraphNode>()
  ]);

  if (!fromNode || !toNode) {
    return {
      found: false,
      path: [],
      pathIds: [],
      steps: [],
      hops: 0,
      minConfidence: 0
    };
  }

  // If same person, return trivial path
  if (fromId === toId) {
    return {
      found: true,
      path: [fromNode.name],
      pathIds: [fromId],
      steps: [],
      hops: 0,
      minConfidence: 100
    };
  }

  // Get all edges for BFS
  const edgesResult = await db.prepare(`
    SELECT e.*,
           n1.name as source_name,
           n2.name as target_name
    FROM edges e
    JOIN nodes n1 ON e.source_id = n1.id
    JOIN nodes n2 ON e.target_id = n2.id
  `).all<GraphEdge & { source_name: string; target_name: string }>();

  // Build adjacency list
  const adjacency = new Map<string, Array<{
    neighborId: string;
    neighborName: string;
    edge: GraphEdge & { source_name: string; target_name: string };
  }>>();

  for (const edge of edgesResult.results) {
    // Add both directions since edges are undirected
    if (!adjacency.has(edge.source_id)) {
      adjacency.set(edge.source_id, []);
    }
    if (!adjacency.has(edge.target_id)) {
      adjacency.set(edge.target_id, []);
    }
    adjacency.get(edge.source_id)!.push({
      neighborId: edge.target_id,
      neighborName: edge.target_name,
      edge
    });
    adjacency.get(edge.target_id)!.push({
      neighborId: edge.source_id,
      neighborName: edge.source_name,
      edge
    });
  }

  // BFS to find shortest path
  const visited = new Set<string>([fromId]);
  const queue: Array<{ nodeId: string; path: string[]; pathIds: string[] }> = [{
    nodeId: fromId,
    path: [fromNode.name],
    pathIds: [fromId]
  }];
  const parentEdge = new Map<string, GraphEdge & { source_name: string; target_name: string }>();

  while (queue.length > 0) {
    const current = queue.shift()!;

    if (current.nodeId === toId) {
      // Found the target - reconstruct steps
      const steps: PathStep[] = [];
      for (let i = 0; i < current.pathIds.length - 1; i++) {
        const currId = current.pathIds[i];
        const nextId = current.pathIds[i + 1];

        // Find the edge for this step
        const neighbors = adjacency.get(currId) || [];
        const neighbor = neighbors.find(n => n.neighborId === nextId);
        if (neighbor) {
          const edge = neighbor.edge;
          steps.push({
            from: currId,
            fromName: current.path[i],
            to: nextId,
            toName: current.path[i + 1],
            confidence: edge.confidence,
            evidenceUrl: edge.best_evidence_url,
            thumbnailUrl: edge.best_evidence_thumbnail,
            contextUrl: edge.context_url
          });
        }
      }

      const minConfidence = steps.length > 0
        ? Math.min(...steps.map(s => s.confidence))
        : 100;

      return {
        found: true,
        path: current.path,
        pathIds: current.pathIds,
        steps,
        hops: steps.length,
        minConfidence
      };
    }

    // Explore neighbors
    const neighbors = adjacency.get(current.nodeId) || [];
    for (const neighbor of neighbors) {
      if (!visited.has(neighbor.neighborId)) {
        visited.add(neighbor.neighborId);
        queue.push({
          nodeId: neighbor.neighborId,
          path: [...current.path, neighbor.neighborName],
          pathIds: [...current.pathIds, neighbor.neighborId]
        });
      }
    }
  }

  // No path found
  return {
    found: false,
    path: [],
    pathIds: [],
    steps: [],
    hops: 0,
    minConfidence: 0
  };
}
