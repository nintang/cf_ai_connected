/**
 * CLI Test Harness for Visual Degrees Pipeline
 *
 * Usage:
 *   pnpm test:pipeline "Person A" "Person B"
 *
 * Example:
 *   pnpm test:pipeline "Donald Trump" "Kanye West"
 *
 * Environment variables required:
 *   GOOGLE_API_KEY - Google API key with Custom Search enabled
 *   GOOGLE_CX - Programmable Search Engine ID
 *   GEMINI_API_KEY - Google Gemini API key for visual verification
 *   AWS_ACCESS_KEY_ID - AWS access key
 *   AWS_SECRET_ACCESS_KEY - AWS secret key
 *   AWS_REGION - AWS region (default: us-east-1)
 */

import "dotenv/config";

import { createGooglePSEClient } from "../packages/integrations/src/google-pse/client.js";
import { createRekognitionClient } from "../packages/integrations/src/rekognition/client.js";
import { createGeminiClient } from "../packages/integrations/src/gemini/client.js";
import {
  directQuery,
  isValidEvidence,
  createEvidenceRecord,
  createVerifiedEdge,
} from "../packages/core/src/index.js";
import type {
  ImageSearchResult,
  ImageAnalysisResult,
  EvidenceRecord,
  VerifiedEdge,
} from "../packages/contracts/src/index.js";

const CONFIDENCE_THRESHOLD = 80;

interface TestResult {
  personA: string;
  personB: string;
  query: string;
  imagesSearched: number;
  imagesPassedVisualCheck: number;
  imagesAnalyzed: number;
  verifiedEdge: VerifiedEdge | null;
  allAnalyses: Array<{
    imageUrl: string;
    visualCheck: { passed: boolean; reason: string } | null;
    celebrities: Array<{ name: string; confidence: number }>;
    isValidForEdge: boolean;
  }>;
}

async function runPipeline(personA: string, personB: string): Promise<TestResult> {
  console.log("\n🔍 Visual Degrees Pipeline Test");
  console.log("================================");
  console.log(`Person A: ${personA}`);
  console.log(`Person B: ${personB}`);
  console.log(`Confidence threshold: ${CONFIDENCE_THRESHOLD}%`);
  console.log("");

  // Initialize clients
  console.log("📡 Initializing clients...");
  const pseClient = createGooglePSEClient();
  const geminiClient = createGeminiClient();
  const rekognitionClient = createRekognitionClient();

  // Step 1: Search for images
  const query = directQuery(personA, personB);
  console.log(`\n🔎 Searching images for: "${query}"`);

  const searchResponse = await pseClient.searchImages(query);
  console.log(`   Found ${searchResponse.results.length} images`);

  if (searchResponse.results.length === 0) {
    console.log("\n❌ No images found for this query");
    return {
      personA,
      personB,
      query,
      imagesSearched: 0,
      imagesPassedVisualCheck: 0,
      imagesAnalyzed: 0,
      verifiedEdge: null,
      allAnalyses: [],
    };
  }

  // Step 2: Visual verification with Gemini Flash (filter collages/photogrids)
  console.log("\n🔬 Verifying visual co-presence with Gemini Flash...");

  const evidenceRecords: EvidenceRecord[] = [];
  const allAnalyses: TestResult["allAnalyses"] = [];
  let imagesPassedVisualCheck = 0;

  for (let i = 0; i < searchResponse.results.length; i++) {
    const imageResult = searchResponse.results[i];
    console.log(`\n   [${i + 1}/${searchResponse.results.length}] ${imageResult.imageUrl.substring(0, 60)}...`);

    try {
      // Step 2a: Gemini Flash visual verification
      console.log(`       🔬 Checking if real scene (not collage)...`);
      const visualCheck = await geminiClient.verifyVisualCopresence(imageResult.imageUrl);

      if (!visualCheck.isValidScene) {
        console.log(`       ❌ REJECTED: ${visualCheck.reason}`);
        allAnalyses.push({
          imageUrl: imageResult.imageUrl,
          visualCheck: { passed: false, reason: visualCheck.reason },
          celebrities: [],
          isValidForEdge: false,
        });
        continue; // Skip Rekognition for collages - saves cost!
      }

      console.log(`       ✅ Valid scene: ${visualCheck.reason}`);
      imagesPassedVisualCheck++;

      // Step 2b: Rekognition celebrity detection (only for valid scenes)
      console.log(`       🤖 Detecting celebrities with Rekognition...`);
      const analysis = await rekognitionClient.detectCelebrities(imageResult.imageUrl);

      const celebrities = analysis.celebrities.map((c) => ({
        name: c.name,
        confidence: Math.round(c.confidence * 10) / 10,
      }));

      console.log(`       Detected: ${celebrities.map((c) => `${c.name} (${c.confidence}%)`).join(", ") || "none"}`);

      const isValid = isValidEvidence(
        analysis.celebrities,
        personA,
        personB,
        CONFIDENCE_THRESHOLD
      );

      allAnalyses.push({
        imageUrl: imageResult.imageUrl,
        visualCheck: { passed: true, reason: visualCheck.reason },
        celebrities,
        isValidForEdge: isValid,
      });

      if (isValid) {
        console.log(`       ✅ Valid evidence for edge!`);

        const evidence = createEvidenceRecord(
          imageResult,
          analysis,
          personA,
          personB
        );

        if (evidence) {
          evidenceRecords.push(evidence);
        }
      } else {
        console.log(`       ⚪ Not valid evidence (missing person or below threshold)`);
      }
    } catch (error) {
      console.log(`       ❌ Error: ${error instanceof Error ? error.message : "Unknown error"}`);
      allAnalyses.push({
        imageUrl: imageResult.imageUrl,
        visualCheck: null,
        celebrities: [],
        isValidForEdge: false,
      });
    }
  }

  // Step 3: Create verified edge if we have evidence
  console.log("\n📊 Results Summary");
  console.log("==================");
  console.log(`   Images searched: ${searchResponse.results.length}`);
  console.log(`   Passed visual check (real scenes): ${imagesPassedVisualCheck}`);
  console.log(`   Rejected (collages/grids): ${searchResponse.results.length - imagesPassedVisualCheck}`);

  const verifiedEdge = createVerifiedEdge(personA, personB, evidenceRecords);

  if (verifiedEdge) {
    console.log(`\n✅ VERIFIED EDGE FOUND!`);
    console.log(`   ${personA} ↔ ${personB}`);
    console.log(`   Edge Confidence: ${verifiedEdge.edgeConfidence}%`);
    console.log(`   Valid Evidence Images: ${verifiedEdge.evidence.length}`);
    console.log(`\n   Best Evidence:`);
    console.log(`   - Image: ${verifiedEdge.bestEvidence.imageUrl}`);
    console.log(`   - Source: ${verifiedEdge.bestEvidence.contextUrl}`);
    console.log(`   - Score: ${verifiedEdge.bestEvidence.imageScore}%`);
  } else {
    console.log(`\n❌ NO VERIFIED EDGE`);
    console.log(`   Could not verify a direct visual connection between ${personA} and ${personB}`);
    console.log(`   at ≥${CONFIDENCE_THRESHOLD}% confidence.`);
  }

  return {
    personA,
    personB,
    query,
    imagesSearched: searchResponse.results.length,
    imagesPassedVisualCheck,
    imagesAnalyzed: imagesPassedVisualCheck, // Only images that passed visual check were analyzed
    verifiedEdge,
    allAnalyses,
  };
}

// Main execution
async function main() {
  const args = process.argv.slice(2);

  if (args.length < 2) {
    console.error("Usage: pnpm test:pipeline \"Person A\" \"Person B\"");
    console.error("Example: pnpm test:pipeline \"Donald Trump\" \"Kanye West\"");
    process.exit(1);
  }

  const [personA, personB] = args;

  try {
    const result = await runPipeline(personA, personB);

    // Output JSON result for programmatic use
    console.log("\n📄 JSON Output:");
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error("\n💥 Pipeline Error:", error);
    process.exit(1);
  }
}

main();

