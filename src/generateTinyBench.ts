#!/usr/bin/env bun

import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import * as nunjucks from "nunjucks";
import type { EvalOutput, EvalResult } from "./types.ts";

type GenerateOptions = {
  outputPath: string;
  evalRoots: string[];
};

type EvalRunRecord = EvalResult & {
  commit: string;
  prDocs: string;
  originalDiffText: string;
  candidateDiffText: string;
  sourceRunHref: string | null;
  detailHref: string;
  detailPath: string;
};

type LeaderboardRow = {
  model: string;
  average: number;
  count: number;
};

type Dashboard = {
  generatedAt: string;
  runs: Array<{
    repo: string;
    prNumber: number;
    evalLLM: string;
    prSummaryLLM: string;
    evalJudgeLLM: string;
    rating: number;
    judgeNotes: string;
    detailHref: string;
    sourceRunHref: string | null;
  }>;
  leaderboard: LeaderboardRow[];
};

const repoRoot = process.cwd();
const defaultOptions: GenerateOptions = {
  outputPath: resolve(repoRoot, "lp", "tinybench", "index.html"),
  evalRoots: [resolve(repoRoot, "evals"), resolve(repoRoot, "lp")],
};

await main();

async function main(): Promise<void> {
  const options = parseArgs(Bun.argv.slice(2));
  const outputDir = dirname(options.outputPath);
  await mkdir(outputDir, { recursive: true });

  const runs = await readEvalRuns(options, outputDir);
  const dashboard = buildDashboard(runs);

  await writeFile(
    options.outputPath,
    renderTemplate("tinybench-index.html.j2", {
      dashboardJson: JSON.stringify(dashboard),
      generatedAt: dashboard.generatedAt,
    }),
  );
  await buildClientBundle(outputDir);
  await writeRunPages(runs, options.outputPath);

  console.log(`Wrote ${relative(repoRoot, options.outputPath) || options.outputPath}`);
  console.log(`Wrote ${runs.length} run page${runs.length === 1 ? "" : "s"} in ${relative(repoRoot, join(outputDir, "runs"))}`);
}

function parseArgs(args: string[]): GenerateOptions {
  const options: GenerateOptions = {
    outputPath: defaultOptions.outputPath,
    evalRoots: [...defaultOptions.evalRoots],
  };
  let evalRootsWereSet = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const value = args[index + 1];
    if (arg === "--output") {
      assertValue(arg, value);
      options.outputPath = resolve(repoRoot, value);
      index += 1;
    } else if (arg === "--eval-root") {
      assertValue(arg, value);
      if (!evalRootsWereSet) {
        options.evalRoots = [];
        evalRootsWereSet = true;
      }
      options.evalRoots.push(resolve(repoRoot, value));
      index += 1;
    } else if (arg === "--help" || arg === "-h") {
      console.log(`Usage: bun run src/generateTinyBench.ts [options]

Options:
  --output <path>      Dashboard output path (default: lp/tinybench/index.html)
  --eval-root <path>   Eval output root to scan, repeatable (default: evals and lp)
`);
      process.exit(0);
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  return options;
}

function assertValue(name: string, value: string | undefined): asserts value is string {
  if (!value || value.startsWith("--")) {
    throw new Error(`${name} requires a value`);
  }
}

async function readEvalRuns(options: GenerateOptions, dashboardOutputDir: string): Promise<EvalRunRecord[]> {
  const records: EvalRunRecord[] = [];
  const seenEvalJson = new Set<string>();
  const detailDir = join(dashboardOutputDir, "runs");

  for (const evalRoot of options.evalRoots) {
    const evalJsonPaths = await findEvalJsonFiles(evalRoot);
    for (const evalJsonPath of evalJsonPaths) {
      if (seenEvalJson.has(evalJsonPath)) {
        continue;
      }
      seenEvalJson.add(evalJsonPath);

      const runDir = dirname(evalJsonPath);
      const output = JSON.parse(await readFile(evalJsonPath, "utf8")) as EvalOutput;
      const dataset = new Map(output.evaDataset.map((item) => [caseKey(item.githubRepo, item.prNumber), item]));

      for (const [index, result] of output.evalResults.entries()) {
        const item = dataset.get(caseKey(result.repo, result.prNumber));
        const commit = item?.commitBeforePR ?? "unknown";
        const originalDiffText = await readDiffValue(result.originalPRDiff || item?.prDiff || "", runDir);
        const candidateDiffText = await readDiffValue(result.evalLLMChangesDiff, runDir);
        const runName = `${basename(dirname(runDir))}-${basename(runDir)}`;
        const detailPath = join(detailDir, `${uniqueRunSlug(result, commit, runName, index)}.html`);

        records.push({
          ...result,
          commit,
          prDocs: item?.prDocs ?? "",
          originalDiffText,
          candidateDiffText,
          sourceRunHref: (await exists(join(runDir, "index.html")))
            ? relativeHref(dashboardOutputDir, join(runDir, "index.html"))
            : null,
          detailHref: relativeHref(dashboardOutputDir, detailPath),
          detailPath,
        });
      }
    }
  }

  return records.sort(
    (left, right) =>
      left.repo.localeCompare(right.repo) ||
      left.prNumber - right.prNumber ||
      right.rating - left.rating ||
      left.evalLLM.localeCompare(right.evalLLM),
  );
}

async function findEvalJsonFiles(evalRoot: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(evalRoot, { withFileTypes: true });
  } catch (error) {
    if (isNotFoundError(error)) {
      return [];
    }
    throw error;
  }

  const candidates = entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("eval_run_"))
    .map((entry) => join(evalRoot, entry.name, "eval.json"));
  const existing = await Promise.all(candidates.map(async (path) => ((await exists(path)) ? path : null)));
  return existing.filter((path): path is string => path !== null);
}

async function readDiffValue(value: string, baseDir: string): Promise<string> {
  if (!value) {
    return "";
  }
  if (value.trimStart().startsWith("diff --git")) {
    return value;
  }

  const firstPath = isAbsolute(value) ? value : resolve(baseDir, value);
  try {
    return await readFile(firstPath, "utf8");
  } catch (error) {
    if (!isNotFoundError(error)) {
      throw error;
    }
  }

  try {
    return await readFile(resolve(repoRoot, value), "utf8");
  } catch (error) {
    if (isNotFoundError(error)) {
      return "";
    }
    throw error;
  }
}

function buildDashboard(runs: EvalRunRecord[]): Dashboard {
  return {
    generatedAt: new Date().toISOString(),
    runs: runs.map((run) => ({
      repo: run.repo,
      prNumber: run.prNumber,
      evalLLM: run.evalLLM,
      prSummaryLLM: run.prSummaryLLM,
      evalJudgeLLM: run.evalJudgeLLM,
      rating: clampRating(run.rating),
      judgeNotes: run.judgeNotes,
      detailHref: run.detailHref,
      sourceRunHref: run.sourceRunHref,
    })),
    leaderboard: rankModels(runs.map((run) => ({
      evalLLM: run.evalLLM,
      prSummaryLLM: run.prSummaryLLM,
      evalJudgeLLM: run.evalJudgeLLM,
      rating: clampRating(run.rating),
      evalLLMChangesDiff: run.evalLLMChangesDiff,
      judgeNotes: run.judgeNotes,
      detailHref: run.detailHref,
    }))),
  };
}

async function writeRunPages(runs: EvalRunRecord[], dashboardPath: string): Promise<void> {
  if (!runs.length) {
    return;
  }

  const runsDir = dirname(runs[0].detailPath);
  await rm(runsDir, { recursive: true, force: true });
  await mkdir(runsDir, { recursive: true });
  await Promise.all(
    runs.map(async (run) => {
      await writeFile(run.detailPath, renderRunPage(run, run.detailPath, dashboardPath));
    }),
  );
  await writeFile(join(runsDir, "index.html"), renderRunPage(runs[0], join(runsDir, "index.html"), dashboardPath));
}

function renderRunPage(run: EvalRunRecord, pagePath: string, dashboardPath: string): string {
  return renderTemplate("tinybench-run.html.j2", {
    run,
    title: `${run.repo}#${run.prNumber} ${run.evalLLM}`,
    diffPayloadJson: safeScriptJson({
      original: run.originalDiffText,
      candidate: run.candidateDiffText,
    }),
    backHref: relativeHref(dirname(pagePath), dashboardPath),
    clientScriptHref: relativeHref(dirname(pagePath), join(dirname(dashboardPath), "assets", "tinybench-client.js")),
  });
}

async function buildClientBundle(outputDir: string): Promise<void> {
  const assetsDir = join(outputDir, "assets");
  await mkdir(assetsDir, { recursive: true });
  const result = await Bun.build({
    entrypoints: [resolve(repoRoot, "src", "tinybench-client.ts")],
    outdir: assetsDir,
    target: "browser",
    format: "esm",
    minify: true,
    naming: "tinybench-client.js",
  });
  if (!result.success) {
    throw new Error(result.logs.map((log) => log.message).join("\n") || "Failed to build TinyBench client bundle");
  }
}

function renderTemplate(name: string, context: Record<string, unknown>): string {
  const env = new nunjucks.Environment(new nunjucks.FileSystemLoader(resolve(repoRoot, "src", "templates")), {
    autoescape: true,
    throwOnUndefined: true,
  });
  return env.render(name, context);
}

function safeScriptJson(value: unknown): string {
  return JSON.stringify(value).replaceAll("</", "<\\/");
}

function rankModels(evals: Array<{ evalLLM: string; rating: number }>): LeaderboardRow[] {
  const byModel = new Map<string, { total: number; count: number }>();
  for (const entry of evals) {
    const current = byModel.get(entry.evalLLM) ?? { total: 0, count: 0 };
    current.total += entry.rating;
    current.count += 1;
    byModel.set(entry.evalLLM, current);
  }
  return Array.from(byModel, ([model, stats]) => ({
    model,
    average: stats.total / Math.max(stats.count, 1),
    count: stats.count,
  })).sort((left, right) => right.average - left.average || left.model.localeCompare(right.model));
}

function clampRating(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(10, value));
}

function uniqueRunSlug(result: EvalResult, commit: string, runName: string, index: number): string {
  return sanitizeFilePart(
    `${runName}-${result.repo}-pr-${result.prNumber}-${commit.slice(0, 12)}-${index + 1}-${result.evalLLM}`,
  );
}

function sanitizeFilePart(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase() || "run";
}

function caseKey(repo: string, prNumber: number): string {
  return `${repo}#${prNumber}`;
}

function relativeHref(fromDir: string, toPath: string): string {
  const path = relative(fromDir, toPath).split("\\").join("/");
  const href = path.startsWith(".") ? path : `./${path}`;
  return encodeURI(href);
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await readFile(filePath);
    return true;
  } catch (error) {
    if (isNotFoundError(error)) {
      return false;
    }
    throw error;
  }
}

function isNotFoundError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
