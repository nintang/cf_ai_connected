import chalk from "chalk";

async function main() {
  const workerUrl = "https://visual-degrees-worker.nintang48.workers.dev"; // Production URL
  const personA = process.argv[2] || "Donald Trump";
  const personB = process.argv[3] || "Kanye West";

  console.log(chalk.cyan(`\n🔍 Testing Visual Degrees Worker`));
  console.log(chalk.dim(`Target: ${workerUrl}`));
  console.log(chalk.white(`Query: ${personA} ↔ ${personB}\n`));

  try {
    const response = await fetch(`${workerUrl}/api/chat/query`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ personA, personB }),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${await response.text()}`);
    }

    const data = await response.json();
    console.log(chalk.green("✓ Request Successful!"));
    console.log(chalk.dim("Response:"));
    console.log(JSON.stringify(data, null, 2));
    
    console.log(chalk.cyan("\n⏳ Polling for results..."));
    
    // Poll for status
    const pollInterval = setInterval(async () => {
      try {
        const statusRes = await fetch(`${workerUrl}/api/chat/status/${data.id}`);
        if (!statusRes.ok) return;
        
        const statusData = await statusRes.json();
        process.stdout.write(`\rStatus: ${statusData.status}   `);
        
        if (statusData.status === "complete" || statusData.status === "errored" || statusData.status === "terminated") {
          clearInterval(pollInterval);
          console.log("\n");
          if (statusData.status === "complete") {
            console.log(chalk.green("✓ Workflow Completed!"));
            console.log(chalk.white("Result:"));
            console.log(JSON.stringify(statusData.output, null, 2));
          } else {
            console.log(chalk.red(`✗ Workflow Failed: ${statusData.status}`));
            console.log(chalk.red(statusData.error));
          }
          process.exit(0);
        }
      } catch (e) {
        // Ignore polling errors
      }
    }, 2000);

  } catch (error) {
    console.error(chalk.red("✗ Request Failed:"), error instanceof Error ? error.message : String(error));
    console.log(chalk.dim("\nMake sure the worker is running with: pnpm --filter worker dev --remote"));
  }
}

main();

