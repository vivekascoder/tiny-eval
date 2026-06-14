#!/usr/bin/env bun

import { mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { parseOptions, normalizeRepo, preferDotenvKeys, usage } from "./src/config.ts";
import { prepareDataset } from "./src/dataset.ts";
import { repoCachePath } from "./src/git.ts";
import { validateOpenRouterKey } from "./src/model.ts";
import { runEvalJobs, type EvalJob } from "./src/parallel.ts";
import { renderReport } from "./src/report.ts";
import { persistTinyBenchResult, tinyBenchPath } from "./src/tiny-bench.ts";
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
  let tinyBenchWrite = Promise.resolve();
  const evalResults = await runEvalJobs(jobs, options, async (result, index) => {
    tinyBenchWrite = tinyBenchWrite.then(async () => {
      const item = dataset.find(
        (candidate) => candidate.githubRepo === result.repo && candidate.prNumber === result.prNumber,
      );
      if (!item) {
        throw new Error(`Could not find dataset item for ${result.repo}#${result.prNumber}`);
      }

      const diffsDir = join(outputDir, "diffs");
      const originalDiffPath = join("diffs", `pr-${item.prNumber}-${item.commitBeforePR.slice(0, 12)}-original.diff`);
      const evalDiffPath = join(
        "diffs",
        `pr-${result.prNumber}-${String(index + 1).padStart(3, "0")}-${sanitizeFilePart(result.evalLLM)}-candidate.diff`,
      );
      await mkdir(diffsDir, { recursive: true });
      await writeFile(join(outputDir, originalDiffPath), item.prDiff);
      await writeFile(join(outputDir, evalDiffPath), result.evalLLMChangesDiff);

      const outputPath = relative(process.cwd(), outputDir) || outputDir;
      await persistTinyBenchResult(
        { ...item, prDiff: join(outputPath, originalDiffPath) },
        { ...result, originalPRDiff: join(outputPath, originalDiffPath), evalLLMChangesDiff: join(outputPath, evalDiffPath) },
      );
      console.log(`[tinybench] updated ${relative(process.cwd(), tinyBenchPath) || tinyBenchPath}`);
    });
    await tinyBenchWrite;
  });

  const output: EvalOutput = { evaDataset: dataset, evalResults };
  const persistedOutput = await writeDiffsAndLinkOutput(output, outputDir);
  await writeFile(join(outputDir, "eval.json"), `${JSON.stringify(persistedOutput, null, 2)}\n`);
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

async function writeDiffsAndLinkOutput(output: EvalOutput, outputDir: string): Promise<EvalOutput> {
  const diffsDir = join(outputDir, "diffs");
  await mkdir(diffsDir, { recursive: true });

  const originalDiffPaths = new Map<string, string>();
  const evaDataset = await Promise.all(
    output.evaDataset.map(async (item) => {
      const diffPath = join("diffs", `pr-${item.prNumber}-${item.commitBeforePR.slice(0, 12)}-original.diff`);
      await writeFile(join(outputDir, diffPath), item.prDiff);
      originalDiffPaths.set(datasetKey(item.githubRepo, item.prNumber), diffPath);
      return {
        ...item,
        prDiff: diffPath,
      };
    }),
  );

  const evalResults = await Promise.all(
    output.evalResults.map(async (result, index) => {
      const evalDiffPath = join(
        "diffs",
        `pr-${result.prNumber}-${String(index + 1).padStart(3, "0")}-${sanitizeFilePart(result.evalLLM)}-candidate.diff`,
      );
      await writeFile(join(outputDir, evalDiffPath), result.evalLLMChangesDiff);
      const originalPRDiff = originalDiffPaths.get(datasetKey(result.repo, result.prNumber));
      if (!originalPRDiff) {
        throw new Error(`Could not find original diff path for ${result.repo}#${result.prNumber}`);
      }
      return {
        ...result,
        evalLLMChangesDiff: evalDiffPath,
        originalPRDiff,
      };
    }),
  );

  return { evaDataset, evalResults };
}

function datasetKey(repo: string, prNumber: number): string {
  return `${repo}#${prNumber}`;
}

function sanitizeFilePart(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]+/g, "_").replace(/^_+|_+$/g, "") || "model";
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
