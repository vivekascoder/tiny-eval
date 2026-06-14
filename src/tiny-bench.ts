import { readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { EvalDatasetItem, EvalResult, TinyBenchItem } from "./types.ts";

export const tinyBenchPath = resolve("tinyBench.json");
export const lpTinyBenchPath = resolve("lp", "tinyBench.json");

export async function persistTinyBenchResult(
  item: EvalDatasetItem,
  result: EvalResult,
  filePath = tinyBenchPath,
): Promise<void> {
  const bench = await readTinyBench(filePath);
  const itemKey = tinyBenchItemKey(item.githubRepo, item.prNumber, item.commitBeforePR);
  const existingIndex = bench.findIndex((entry) => tinyBenchItemKey(entry.repo, entry.pr, entry.commit) === itemKey);
  const nextEval = {
    evalLLM: result.evalLLM,
    prSummaryLLM: result.prSummaryLLM,
    evalJudgeLLM: result.evalJudgeLLM,
    rating: result.rating,
    evalLLMChangesDiff: result.evalLLMChangesDiff,
  };

  if (existingIndex === -1) {
    bench.push({
      repo: item.githubRepo,
      commit: item.commitBeforePR,
      pr: item.prNumber,
      prDocs: item.prDocs,
      prDiff: item.prDiff,
      evals: [nextEval],
    });
  } else {
    const existing = bench[existingIndex];
    existing.prDocs = item.prDocs;
    existing.prDiff = item.prDiff;

    const evalIndex = existing.evals.findIndex(
      (entry) =>
        entry.evalLLM === nextEval.evalLLM &&
        entry.prSummaryLLM === nextEval.prSummaryLLM &&
        entry.evalJudgeLLM === nextEval.evalJudgeLLM,
    );

    if (evalIndex === -1) {
      existing.evals.push(nextEval);
    } else {
      existing.evals[evalIndex] = nextEval;
    }
  }

  await writeTinyBench(filePath, bench);
  if (filePath === tinyBenchPath) {
    await writeTinyBench(lpTinyBenchPath, bench);
  }
}

async function readTinyBench(filePath: string): Promise<TinyBenchItem[]> {
  let text: string;
  try {
    text = await readFile(filePath, "utf8");
  } catch (error) {
    if (isNotFoundError(error)) {
      return [];
    }
    throw error;
  }

  if (text.trim().length === 0) {
    return [];
  }

  const parsed = JSON.parse(text) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error(`${filePath} must contain a JSON array`);
  }

  return parsed as TinyBenchItem[];
}

async function writeTinyBench(filePath: string, bench: TinyBenchItem[]): Promise<void> {
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(bench, null, 2)}\n`);
  await rename(tempPath, filePath);
}

function tinyBenchItemKey(repo: string, pr: number, commit: string): string {
  return `${repo}#${pr}@${commit}`;
}

function isNotFoundError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
