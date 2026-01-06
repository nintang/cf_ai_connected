export interface ParsedQuery {
  personA: string;
  personB: string;
  originalQuery: string;
  isValid: boolean;
}

export function parseQuery(query: string): ParsedQuery {
  // Normalize whitespace
  const cleanQuery = query.trim().replace(/\s+/g, " ");
  
  // Patterns to match:
  // 1. "Connect Person A to Person B"
  // 2. "How is Person A connected to Person B?"
  // 3. "Find path from Person A to Person B"
  // 4. "Person A <-> Person B"
  // 5. "Person A and Person B"
  
  const patterns = [
    /connect\s+(.+?)\s+to\s+(.+)/i,
    /how\s+is\s+(.+?)\s+connected\s+to\s+(.+)/i,
    /find\s+path\s+from\s+(.+?)\s+to\s+(.+)/i,
    /(.+?)\s+(?:↔|<->|to)\s+(.+)/i,
    /(.+?)\s+and\s+(.+)/i
  ];

  for (const pattern of patterns) {
    const match = cleanQuery.match(pattern);
    if (match && match[1] && match[2]) {
      // Clean up matched names (remove trailing question marks, etc.)
      const personA = match[1].replace(/[?.,!]+$/, "").trim();
      const personB = match[2].replace(/[?.,!]+$/, "").trim();
      
      if (personA && personB) {
        return {
          personA,
          personB,
          originalQuery: query,
          isValid: true
        };
      }
    }
  }

  return {
    personA: "",
    personB: "",
    originalQuery: query,
    isValid: false
  };
}

