/**
 * Query template generators for image search
 * Based on 05_integrations_google_pse.md
 * 
 * NOTE: These are FALLBACK templates only. The intelligent planner should
 * generate contextually relevant queries based on who the person is.
 * Use generateFrontierQueries from the planner when available.
 */

/**
 * Generate a direct verification query for two people
 * Used when attempting to find a direct edge
 */
export function directQuery(personA: string, personB: string): string {
  return `${personA} ${personB}`;
}

/**
 * FALLBACK: Generate minimal discovery queries for a frontier person
 * 
 * Prefer using IntelligentPlannerClient.generateFrontierQueries() which
 * dynamically generates contextual queries based on who the person is
 * (e.g., "concert" for musicians, "premiere" for actors, "summit" for politicians)
 */
export function discoveryQueries(frontier: string): string[] {
  // Minimal fallback - just the person's name in photo contexts
  return [
    `${frontier} photo`,
    `${frontier} with`,
  ];
}

/**
 * Generate verification queries for an intermediate
 * Used when trying to verify a specific edge
 */
export function verificationQueries(
  person1: string,
  person2: string
): string[] {
  return [`${person1} ${person2}`, `${person1} ${person2} together`];
}

/**
 * Generate bridge queries to connect intermediate to target
 */
export function bridgeQueries(intermediate: string, target: string): string[] {
  return [`${intermediate} ${target}`, `${intermediate} ${target} together`];
}

