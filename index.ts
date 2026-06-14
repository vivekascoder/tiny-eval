#!/usr/bin/env bun

import { mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { parseOptions, normalizeRepo, preferDotenvKeys, usage } from "./src/config.ts";
import { prepareDataset } from "./src/dataset.ts";
import { repoCachePath } from "./src/git.ts";
import { validateOpenRouterKey } from "./src/model.ts";
import { runEvalJobs, type EvalJob } from "./src/parallel.ts";
import { renderReport } from "./src/report.ts";
import type { EvalOutput } from "./src/types.ts";

await preferDotenvKeys(["OPENROUTER_API_KEY", "GITHUB_TOKEN"]);

async function main() {
  const [command, ...args] = Bun.argv.slice(2);

  if (command !== "run-eval") {
    console.error(usage);
    process.exit(command ? 1 : 0);
  }

  const options = parseOptions(args);
  if (!Bun.env.OPENROUTER_API_KEY) {
    throw new Error("OPENROUTER_API_KEY is required to run eval model, summary model, and judge model calls.");
  }
  await validateOpenRouterKey();

  const repoSlug = normalizeRepo(options.repo);
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outputDir = resolveOutputDir(options.output, timestamp);

  await mkdir(outputDir, { recursive: true });

  console.log(`Preparing dataset from ${repoSlug}...`);
  const dataset = await prepareDataset(repoSlug, options);

  const cachedRepo = repoCachePath(repoSlug);
  const jobs: EvalJob[] = [];
  for (const evalLLM of options.evalLLMs) {
    for (const item of dataset) {
      jobs.push({ index: jobs.length, item, evalLLM, cachedRepo });
    }
  }

  console.log(
    `Running ${jobs.length} eval job(s) from ${dataset.length} item(s) across ${options.evalLLMs.length} model(s) with concurrency ${Math.min(options.concurrency, jobs.length)}...`,
  );
  const evalResults = await runEvalJobs(jobs, options);

  const output: EvalOutput = { evaDataset: dataset, evalResults };
  await writeFile(join(outputDir, "eval.json"), `${JSON.stringify(output, null, 2)}\n`);
  await writeFile(join(outputDir, "index.html"), renderReport(output, options));

  console.log(`Wrote ${relative(process.cwd(), outputDir) || outputDir}`);
}

function resolveOutputDir(output: string | undefined, timestamp: string): string {
  const outputRoot = resolve("evals");
  const outputName = output ?? `eval_run_${timestamp}`;
  if (isAbsolute(outputName)) {
    throw new Error("--output must be a directory name relative to evals/");
  }

  const normalizedOutput = outputName.replace(/^evals[/\\]/, "");
  const outputDir = resolve(outputRoot, normalizedOutput);
  if (outputDir !== outputRoot && !outputDir.startsWith(`${outputRoot}/`)) {
    throw new Error("--output must stay within evals/");
  }

  return outputDir;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
