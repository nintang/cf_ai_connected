import { Env } from "../env";
import { searchImages } from "./search";
import { detectCelebrities } from "./detect";
import { verifyCopresence } from "./verify";
import { verifyCelebritiesWithAI } from "./verify-celebrities";

export const getTools = (env: Env) => [
  {
    name: "search_images",
    description: "Search for images of two people together",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
      },
      required: ["query"],
    },
    function: searchImages(env),
  },
  {
    name: "detect_celebrities",
    description: "Detect celebrities in an image URL",
    parameters: {
      type: "object",
      properties: {
        imageUrl: { type: "string", description: "Image URL to analyze" },
      },
      required: ["imageUrl"],
    },
    function: detectCelebrities(env),
  },
  {
    name: "verify_copresence",
    description: "Verify image shows real co-presence, not a collage",
    parameters: {
      type: "object",
      properties: {
        imageUrl: { type: "string", description: "Image URL to verify" },
      },
      required: ["imageUrl"],
    },
    function: verifyCopresence(env),
  },
  {
    name: "verify_celebrities_ai",
    description: "AI-based celebrity verification - use when Rekognition fails",
    parameters: {
      type: "object",
      properties: {
        imageUrl: { type: "string", description: "Image URL to analyze" },
        personA: { type: "string", description: "First person to look for" },
        personB: { type: "string", description: "Second person to look for" },
      },
      required: ["imageUrl", "personA", "personB"],
    },
    function: verifyCelebritiesWithAI(env),
  },
];
