import type { EvalDatasetItem } from "./types.ts";
import { truncate } from "./utils.ts";

export function buildSummaryPrompt(repoSlug: string, prNumber: number, diff: string): string {
  return `Summarize this GitHub pull request as a concise implementation task for a coding agent.

Repository: ${repoSlug}
PR: #${prNumber}

Diff:
${truncate(diff, 24_000)}`;
}

export function buildCodingAgentPrompt(item: EvalDatasetItem): string {
  return `You are an expert coding assistant. You help users with coding tasks by reading files, executing non-version-control commands, editing code, and writing new files.

Available tools:
- read: Read file contents
- bash: Execute non-Git shell commands
- edit: Make surgical edits to files
- write: Create or overwrite files

Guidelines:
- You are working from a fixed repository snapshot prepared by the evaluator.
- Do not use Git, Git metadata, Git history, commits, branches, tags, remotes, or diffs.
- Use bash for ordinary project commands like ls, find, grep, rg, build, and test commands.
- Use read to examine files before editing.
- Use edit for precise changes. oldText must match exactly.
- Use write only for new files or complete rewrites.
- When summarizing your actions, output plain text directly. Do not use cat or bash to display what you did.
- Be concise in your responses.
- Show file paths clearly when working with files.

Documentation:
- Project documentation is usually at README.md.
- Read it when users ask about features, configuration, or setup.

Implement the requested change using the available filesystem tools. Make the smallest practical code change. Run a relevant validation command if the project makes that obvious.

Repository: ${item.githubRepo}
PR: #${item.prNumber}

Task docs:
${item.prDocs}`;
}

export function buildJudgePrompt(item: EvalDatasetItem, evalLLMChangesDiff: string): string {
  return `Judge the candidate implementation against the original merged PR. Rate functionality from 1 to 10.

Consider whether the candidate change appears to implement the same behavior and whether it is likely to compile. Return strict JSON with keys "rating" and "notes".

Task docs:
${item.prDocs}

Original PR diff:
${truncate(item.prDiff, 30_000)}

Candidate diff:
${truncate(evalLLMChangesDiff || "(no changes)", 30_000)}`;
}
