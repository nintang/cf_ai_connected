/**
 * Query template generators for image search
 * Based on 05_integrations_google_pse.md
 */

/**
 * Generate a direct verification query for two people
 * Used when attempting to find a direct edge
 */
export function directQuery(personA: string, personB: string): string {
  return `${personA} ${personB}`;
}

/**
 * Generate candidate discovery queries for a frontier person
 * Used to find potential intermediates
 */
export function discoveryQueries(frontier: string): string[] {
  return [
    `${frontier} with celebrities`,
    `${frontier} event`,
    `${frontier} awards`,
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
  return [`${person1} ${person2}`, `${person1} ${person2} event`];
}

/**
 * Generate bridge queries to connect intermediate to target
 */
export function bridgeQueries(intermediate: string, target: string): string[] {
  return [`${intermediate} ${target}`, `${intermediate} ${target} event`];
}

