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

import chalk from "chalk";
// @ts-expect-error cli-table3 uses CommonJS exports
import Table from "cli-table3";
import ora from "ora";

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
  EvidenceRecord,
  VerifiedEdge,
} from "../packages/contracts/src/index.js";

const CONFIDENCE_THRESHOLD = 80;

interface ImageAnalysis {
  imageUrl: string;
  visualCheck: { passed: boolean; reason: string } | null;
  celebrities: Array<{ name: string; confidence: number }>;
  isValidForEdge: boolean;
  error?: string;
}

interface TestResult {
  personA: string;
  personB: string;
  query: string;
  imagesSearched: number;
  imagesPassedVisualCheck: number;
  imagesAnalyzed: number;
  verifiedEdge: VerifiedEdge | null;
  allAnalyses: ImageAnalysis[];
}

// Styling helpers
const styles = {
  header: chalk.bold.cyan,
  success: chalk.green,
  error: chalk.red,
  warning: chalk.yellow,
  info: chalk.blue,
  dim: chalk.dim,
  highlight: chalk.bold.white,
  accent: chalk.magenta,
};

function printHeader(personA: string, personB: string) {
  console.log();
  console.log(styles.header("┌─────────────────────────────────────────────────────────────┐"));
  console.log(styles.header("│") + chalk.bold.white("           🔍 VISUAL DEGREES PIPELINE TEST                   ") + styles.header("│"));
  console.log(styles.header("└─────────────────────────────────────────────────────────────┘"));
  console.log();

  const configTable = new Table({
    chars: { 'top': '─', 'top-mid': '┬', 'top-left': '┌', 'top-right': '┐',
             'bottom': '─', 'bottom-mid': '┴', 'bottom-left': '└', 'bottom-right': '┘',
             'left': '│', 'left-mid': '├', 'mid': '─', 'mid-mid': '┼',
             'right': '│', 'right-mid': '┤', 'middle': '│' },
    style: { head: ['cyan'], border: ['dim'] }
  });

  configTable.push(
    [styles.dim("Person A"), styles.highlight(personA)],
    [styles.dim("Person B"), styles.highlight(personB)],
    [styles.dim("Threshold"), styles.accent(`${CONFIDENCE_THRESHOLD}%`)]
  );

  console.log(configTable.toString());
  console.log();
}

function truncateUrl(url: string, maxLen = 50): string {
  if (url.length <= maxLen) return url;
  return url.substring(0, maxLen - 3) + "...";
}

function getStatusIcon(analysis: ImageAnalysis): string {
  if (analysis.error) return styles.error("✗");
  if (!analysis.visualCheck) return styles.warning("?");
  if (!analysis.visualCheck.passed) return styles.warning("⊘");
  if (analysis.isValidForEdge) return styles.success("✓");
  return styles.dim("○");
}

function getStatusText(analysis: ImageAnalysis): string {
  if (analysis.error) return styles.error("Error");
  if (!analysis.visualCheck) return styles.warning("Failed");
  if (!analysis.visualCheck.passed) return styles.warning("Collage");
  if (analysis.isValidForEdge) return styles.success("Evidence");
  return styles.dim("No match");
}

async function runPipeline(personA: string, personB: string): Promise<TestResult> {
  printHeader(personA, personB);

  // Initialize clients
  const initSpinner = ora({
    text: "Initializing API clients...",
    spinner: "dots",
  }).start();

  const pseClient = createGooglePSEClient();
  const geminiClient = createGeminiClient();
  const rekognitionClient = createRekognitionClient();

  initSpinner.succeed("API clients ready");

  // Step 1: Search for images
  const query = directQuery(personA, personB);
  const searchSpinner = ora({
    text: `Searching: "${query}"`,
    spinner: "dots",
  }).start();

  const searchResponse = await pseClient.searchImages(query);

  if (searchResponse.results.length === 0) {
    searchSpinner.fail("No images found");
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

  searchSpinner.succeed(`Found ${searchResponse.results.length} images`);
  console.log();

  // Step 2: Process each image
  console.log(styles.header("┌─ Processing Images ─────────────────────────────────────────┐"));
  console.log();

  const evidenceRecords: EvidenceRecord[] = [];
  const allAnalyses: ImageAnalysis[] = [];
  let imagesPassedVisualCheck = 0;

  for (let i = 0; i < searchResponse.results.length; i++) {
    const imageResult = searchResponse.results[i];
    const imageNum = `[${i + 1}/${searchResponse.results.length}]`;

    // Gemini Flash visual verification
    const geminiSpinner = ora({
      text: `${imageNum} Gemini Flash: Checking visual co-presence...`,
      spinner: "dots",
      prefixText: "  ",
    }).start();

    try {
      const visualCheck = await geminiClient.verifyVisualCopresence(imageResult.imageUrl);

      if (!visualCheck.isValidScene) {
        geminiSpinner.warn(`${imageNum} ${styles.warning("Collage/Grid")} - ${styles.dim(visualCheck.reason)}`);
        allAnalyses.push({
          imageUrl: imageResult.imageUrl,
          visualCheck: { passed: false, reason: visualCheck.reason },
          celebrities: [],
          isValidForEdge: false,
        });
        continue;
      }

      geminiSpinner.succeed(`${imageNum} ${styles.success("Real scene")} - ${styles.dim(visualCheck.reason)}`);
      imagesPassedVisualCheck++;

      // Rekognition celebrity detection
      const rekSpinner = ora({
        text: `${imageNum} Rekognition: Detecting celebrities...`,
        spinner: "dots",
        prefixText: "  ",
      }).start();

      const analysis = await rekognitionClient.detectCelebrities(imageResult.imageUrl);

      const celebrities = analysis.celebrities.map((c) => ({
        name: c.name,
        confidence: Math.round(c.confidence * 10) / 10,
      }));

      const isValid = isValidEvidence(
        analysis.celebrities,
        personA,
        personB,
        CONFIDENCE_THRESHOLD
      );

      if (isValid) {
        const celebStr = celebrities.map((c) => `${c.name} ${styles.accent(`${c.confidence}%`)}`).join(", ");
        rekSpinner.succeed(`${imageNum} ${styles.success("✓ Evidence")} → ${celebStr}`);

        const evidence = createEvidenceRecord(imageResult, analysis, personA, personB);
        if (evidence) {
          evidenceRecords.push(evidence);
        }
      } else {
        const celebStr = celebrities.length > 0
          ? celebrities.map((c) => `${c.name} ${styles.dim(`${c.confidence}%`)}`).join(", ")
          : styles.dim("No celebrities detected");
        rekSpinner.info(`${imageNum} ${styles.dim("No match")} → ${celebStr}`);
      }

      allAnalyses.push({
        imageUrl: imageResult.imageUrl,
        visualCheck: { passed: true, reason: visualCheck.reason },
        celebrities,
        isValidForEdge: isValid,
      });

    } catch (error) {
      geminiSpinner.fail(`${imageNum} ${styles.error("Error")}: ${error instanceof Error ? error.message : "Unknown"}`);
      allAnalyses.push({
        imageUrl: imageResult.imageUrl,
        visualCheck: null,
        celebrities: [],
        isValidForEdge: false,
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }

  console.log();

  // Step 3: Results Summary
  console.log(styles.header("┌─ Results Summary ────────────────────────────────────────────┐"));
  console.log();

  const statsTable = new Table({
    chars: { 'top': '', 'top-mid': '', 'top-left': '', 'top-right': '',
             'bottom': '', 'bottom-mid': '', 'bottom-left': '', 'bottom-right': '',
             'left': '  │ ', 'left-mid': '', 'mid': '', 'mid-mid': '',
             'right': ' │', 'right-mid': '', 'middle': ' │ ' },
    colWidths: [30, 15],
  });

  const rejected = searchResponse.results.length - imagesPassedVisualCheck;
  statsTable.push(
    [styles.dim("Images searched"), styles.highlight(searchResponse.results.length.toString())],
    [styles.dim("Passed visual check"), styles.success(imagesPassedVisualCheck.toString())],
    [styles.dim("Rejected (collages)"), rejected > 0 ? styles.warning(rejected.toString()) : styles.dim("0")],
    [styles.dim("Valid evidence found"), evidenceRecords.length > 0 ? styles.success(evidenceRecords.length.toString()) : styles.error("0")]
  );

  console.log(statsTable.toString());
  console.log();

  // Create verified edge
  const verifiedEdge = createVerifiedEdge(personA, personB, evidenceRecords);

  if (verifiedEdge) {
    console.log(styles.header("┌─ Verified Connection ─────────────────────────────────────────┐"));
    console.log();
    console.log(`  ${styles.success("✓")} ${styles.highlight(personA)} ${styles.accent("↔")} ${styles.highlight(personB)}`);
    console.log();

    const edgeTable = new Table({
      chars: { 'top': '', 'top-mid': '', 'top-left': '', 'top-right': '',
               'bottom': '', 'bottom-mid': '', 'bottom-left': '', 'bottom-right': '',
               'left': '  │ ', 'left-mid': '', 'mid': '', 'mid-mid': '',
               'right': ' │', 'right-mid': '', 'middle': ' │ ' },
      colWidths: [25, 40],
    });

    edgeTable.push(
      [styles.dim("Edge Confidence"), styles.success(`${verifiedEdge.edgeConfidence}%`)],
      [styles.dim("Evidence Images"), styles.highlight(verifiedEdge.evidence.length.toString())],
      [styles.dim("Best Image Score"), styles.accent(`${verifiedEdge.bestEvidence.imageScore}%`)]
    );

    console.log(edgeTable.toString());
    console.log();
    console.log(`  ${styles.dim("Source:")} ${styles.info(truncateUrl(verifiedEdge.bestEvidence.contextUrl, 55))}`);
    console.log();
  } else {
    console.log(styles.header("┌─ Result ──────────────────────────────────────────────────────┐"));
    console.log();
    console.log(`  ${styles.error("✗")} ${styles.dim("No verified connection found between")}`);
    console.log(`    ${styles.highlight(personA)} ${styles.dim("and")} ${styles.highlight(personB)}`);
    console.log(`    ${styles.dim(`at ≥${CONFIDENCE_THRESHOLD}% confidence`)}`);
    console.log();
  }

  // Image Analysis Table
  console.log(styles.header("┌─ Image Analysis Details ──────────────────────────────────────┐"));
  console.log();

  const analysisTable = new Table({
    head: [styles.dim("#"), styles.dim("Status"), styles.dim("Celebrities"), styles.dim("Reason")],
    chars: { 'top': '─', 'top-mid': '┬', 'top-left': '  ┌', 'top-right': '┐',
             'bottom': '─', 'bottom-mid': '┴', 'bottom-left': '  └', 'bottom-right': '┘',
             'left': '  │', 'left-mid': '  ├', 'mid': '─', 'mid-mid': '┼',
             'right': '│', 'right-mid': '┤', 'middle': '│' },
    colWidths: [5, 12, 30, 25],
    wordWrap: true,
  });

  allAnalyses.forEach((analysis, idx) => {
    const celebStr = analysis.celebrities.length > 0
      ? analysis.celebrities.map(c => `${c.name} (${c.confidence}%)`).join("\n")
      : styles.dim("-");
    
    const reason = analysis.error
      ? styles.error(analysis.error.substring(0, 22))
      : analysis.visualCheck?.reason.substring(0, 22) ?? styles.dim("-");

    analysisTable.push([
      (idx + 1).toString(),
      getStatusText(analysis),
      celebStr,
      reason,
    ]);
  });

  console.log(analysisTable.toString());
  console.log();

  return {
    personA,
    personB,
    query,
    imagesSearched: searchResponse.results.length,
    imagesPassedVisualCheck,
    imagesAnalyzed: imagesPassedVisualCheck,
    verifiedEdge,
    allAnalyses,
  };
}

// Main execution
async function main() {
  const args = process.argv.slice(2);

  if (args.length < 2) {
    console.log();
    console.log(styles.header("  Usage:"));
    console.log(`    pnpm test:pipeline ${styles.accent('"Person A"')} ${styles.accent('"Person B"')}`);
    console.log();
    console.log(styles.header("  Example:"));
    console.log(`    pnpm test:pipeline ${styles.accent('"Donald Trump"')} ${styles.accent('"Kanye West"')}`);
    console.log();
    process.exit(1);
  }

  const [personA, personB] = args;

  try {
    const result = await runPipeline(personA, personB);

    // Optional: JSON output for programmatic use
    if (process.env.JSON_OUTPUT === "true") {
      console.log(styles.header("┌─ JSON Output ─────────────────────────────────────────────────┐"));
      console.log();
      console.log(JSON.stringify(result, null, 2));
    }
  } catch (error) {
    console.log();
    console.log(styles.error("  ✗ Pipeline Error:"), error instanceof Error ? error.message : error);
    console.log();
    process.exit(1);
  }
}

main();
