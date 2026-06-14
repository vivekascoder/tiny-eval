import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCodingAgent } from "./agent.ts";
import { checkoutCommit, cloneFromCache, collectDiff, ensureRepoCache, repoDirectory } from "./git.ts";
import { judgeResult } from "./model.ts";
import type { CliOptions, EvalDatasetItem, EvalResult } from "./types.ts";

export async function runEvalItem(
  item: EvalDatasetItem,
  options: CliOptions,
  evalLLM: string,
  cachedRepo?: string,
): Promise<EvalResult> {
  const workspace = await mkdtemp(join(tmpdir(), "tval-"));

  try {
    console.log(`[eval] PR #${item.prNumber}: setting up workspace for ${evalLLM}`);
    const repoCache = cachedRepo ?? (await ensureRepoCache(item.githubRepo));
    const repoDir = repoDirectory(workspace, item.githubRepo);
    await cloneFromCache(repoCache, repoDir, workspace);
    if (!(await checkoutCommit(repoDir, item.commitBeforePR))) {
      throw new Error(`Prepared commit is no longer checkoutable: ${item.commitBeforePR}`);
    }

    console.log(`[agent] PR #${item.prNumber}: running ${evalLLM}`);
    await runCodingAgent(repoDir, item, evalLLM);
    console.log(`[diff] PR #${item.prNumber}: collecting candidate diff`);
    const evalLLMChangesDiff = await collectDiff(repoDir);
    console.log(`[judge] PR #${item.prNumber}: running ${options.evalJudgeLLM}`);
    const judge = await judgeResult(item, evalLLMChangesDiff, options.evalJudgeLLM);
    console.log(`[result] PR #${item.prNumber}: rating ${judge.rating}/10`);

    return {
      repo: item.githubRepo,
      prNumber: item.prNumber,
      evalLLM,
      prSummaryLLM: options.prSummaryLLM,
      evalJudgeLLM: options.evalJudgeLLM,
      evalLLMChangesDiff,
      originalPRDiff: item.prDiff,
      rating: judge.rating,
      judgeNotes: judge.notes,
    };
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}
