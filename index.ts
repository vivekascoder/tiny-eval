#!/usr/bin/env bun

import { callModel, stepCountIs, tool } from "@openrouter/agent";
import { OpenRouter } from "@openrouter/sdk";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve } from "node:path";
import { z } from "zod";

await preferDotenvKeys(["OPENROUTER_API_KEY", "GITHUB_TOKEN"]);

type CliOptions = {
  repo: string;
  evalLLM: string;
  prSummaryLLM: string;
  evalJudgeLLM: string;
  output?: string;
  limit: number;
};

type PullRequest = {
  number: number;
  title: string;
  body: string | null;
  html_url: string;
  commits_url: string;
  diff_url: string;
  merged_at: string | null;
  base: {
    sha: string;
  };
};

type GithubCommit = {
  sha: string;
  parents: Array<{ sha: string }>;
};

type EvalDatasetItem = {
  githubRepo: string;
  prNumber: number;
  prUrl: string;
  prDocs: string;
  prDiff: string;
  commitBeforePR: string;
};

type EvalResult = {
  repo: string;
  prNumber: number;
  evalLLM: string;
  prSummaryLLM: string;
  evalJudgeLLM: string;
  evalLLMChangesDiff: string;
  originalPRDiff: string;
  rating: number;
  judgeNotes: string;
};

type EvalOutput = {
  evaDataset: EvalDatasetItem[];
  evalResults: EvalResult[];
};

const repoCacheRoot = resolve(process.cwd(), ".tval-cache", "repos");

const openRouter = new OpenRouter({
  apiKey: Bun.env.OPENROUTER_API_KEY,
});

const usage = `Usage:
  tval run-eval --repo <owner/repo|github-url> --eval-llm <model> --pr-summary-llm <model> --eval-judge-llm <model> [--output <path>] [--limit 3]

Environment:
  OPENROUTER_API_KEY is required for LLM summary, eval, and judge calls.`;

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
  const outputDir = resolve(options.output ?? `eval_run_${timestamp}`);

  await mkdir(outputDir, { recursive: true });

  console.log(`Preparing dataset from ${repoSlug}...`);
  const dataset = await prepareDataset(repoSlug, options);

  console.log(`Running ${dataset.length} eval item(s) with ${options.evalLLM}...`);
  const evalResults: EvalResult[] = [];
  for (const item of dataset) {
    evalResults.push(await runEvalItem(item, options));
  }

  const output: EvalOutput = { evaDataset: dataset, evalResults };
  await writeFile(join(outputDir, "eval.json"), `${JSON.stringify(output, null, 2)}\n`);
  await writeFile(join(outputDir, "index.html"), renderReport(output, options));

  console.log(`Wrote ${relative(process.cwd(), outputDir) || outputDir}`);
}

async function validateOpenRouterKey() {
  const response = await fetch("https://openrouter.ai/api/v1/auth/key", {
    headers: {
      Authorization: `Bearer ${Bun.env.OPENROUTER_API_KEY}`,
    },
  });

  if (response.ok) {
    return;
  }

  const body = await response.text();
  throw new Error(`OpenRouter key validation failed (${response.status}): ${body}`);
}

async function preferDotenvKeys(keys: string[]) {
  const dotenv = Bun.file(resolve(process.cwd(), ".env"));
  if (!(await dotenv.exists())) {
    return;
  }

  const values = parseDotenv(await dotenv.text());
  for (const key of keys) {
    const value = values.get(key);
    if (value !== undefined) {
      Bun.env[key] = value;
    }
  }
}

function parseDotenv(contents: string): Map<string, string> {
  const values = new Map<string, string>();

  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) {
      continue;
    }

    values.set(match[1], parseDotenvValue(match[2]));
  }

  return values;
}

function parseDotenvValue(value: string): string {
  const withoutComment = value.replace(/\s+#.*$/, "").trim();
  const quote = withoutComment[0];
  if ((quote === `"` || quote === "'") && withoutComment.endsWith(quote)) {
    const unquoted = withoutComment.slice(1, -1);
    return quote === `"` ? unquoted.replaceAll("\\n", "\n").replaceAll('\\"', '"') : unquoted;
  }

  return withoutComment;
}

function parseOptions(args: string[]): CliOptions {
  const values = new Map<string, string | boolean>();

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith("--")) {
      throw new Error(`Unexpected argument: ${arg}`);
    }

    const [rawKey, inlineValue] = arg.slice(2).split("=", 2);
    if (inlineValue !== undefined) {
      values.set(rawKey, inlineValue);
      continue;
    }

    const next = args[index + 1];
    if (!next || next.startsWith("--")) {
      values.set(rawKey, true);
      continue;
    }

    values.set(rawKey, next);
    index += 1;
  }

  const repo = required(values, "repo");
  const evalLLM = required(values, "eval-llm");
  const prSummaryLLM = required(values, "pr-summary-llm");
  const evalJudgeLLM = required(values, "eval-judge-llm");
  const limit = Number(values.get("limit") ?? 3);

  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error("--limit must be a positive integer");
  }

  return {
    repo,
    evalLLM,
    prSummaryLLM,
    evalJudgeLLM,
    output: optionalString(values.get("output")),
    limit,
  };
}

function required(values: Map<string, string | boolean>, key: string): string {
  const value = values.get(key);
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Missing required option --${key}\n\n${usage}`);
  }
  return value;
}

function optionalString(value: string | boolean | undefined): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function normalizeRepo(repo: string): string {
  const trimmed = repo.trim().replace(/\.git$/, "");
  const match = trimmed.match(/github\.com[:/](?<owner>[^/]+)\/(?<name>[^/#?]+)/);
  const slug = match?.groups ? `${match.groups.owner}/${match.groups.name}` : trimmed;

  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(slug)) {
    throw new Error(`Expected --repo to be owner/repo or a GitHub URL, received: ${repo}`);
  }

  return slug;
}

async function prepareDataset(repoSlug: string, options: CliOptions): Promise<EvalDatasetItem[]> {
  console.log(`[cache] preparing ${repoSlug}`);
  const cachedRepo = await ensureRepoCache(repoSlug);
  const validationWorkspace = await mkdtemp(join(tmpdir(), "tval-validate-"));
  const validationRepoDir = join(validationWorkspace, basename(repoSlug));

  console.log(`[dataset] cloning validation copy from cache`);
  await cloneFromCache(cachedRepo, validationRepoDir, validationWorkspace);

  console.log(`[github] fetching candidate PRs`);
  const pulls = await githubJson<PullRequest[]>(
    `https://api.github.com/repos/${repoSlug}/pulls?state=closed&sort=created&direction=asc&per_page=${Math.max(options.limit * 20, 50)}`,
  );

  const dataset: EvalDatasetItem[] = [];
  try {
    for (const pr of pulls) {
      if (!pr.merged_at) {
        continue;
      }

      const commitBeforePR = pr.base.sha;
      if (!commitBeforePR || !(await checkoutCommit(validationRepoDir, commitBeforePR))) {
        console.warn(`[dataset] skipping PR #${pr.number}: base commit is not checkoutable`);
        continue;
      }

      console.log(`[dataset] selected PR #${pr.number} at ${commitBeforePR.slice(0, 12)}`);
      const prDiff = await githubText(pr.diff_url);
      const docs = formatPrDocs(pr);
      const prDocs =
        docs.length > 0
          ? docs
          : await summarizeDiff(options.prSummaryLLM, repoSlug, pr.number, prDiff);

      dataset.push({
        githubRepo: repoSlug,
        prNumber: pr.number,
        prUrl: pr.html_url,
        prDocs,
        prDiff,
        commitBeforePR,
      });

      if (dataset.length >= options.limit) {
        break;
      }
    }
  } finally {
    await rm(validationWorkspace, { recursive: true, force: true });
  }

  if (dataset.length === 0) {
    throw new Error(`No merged pull requests with usable commits found for ${repoSlug}`);
  }

  return dataset;
}

async function ensureRepoCache(repoSlug: string): Promise<string> {
  await mkdir(repoCacheRoot, { recursive: true });
  const cachePath = join(repoCacheRoot, `${repoSlug.replaceAll("/", "__")}.git`);

  if (await Bun.file(join(cachePath, "HEAD")).exists()) {
    console.log(`[cache] refreshing ${relative(process.cwd(), cachePath)}`);
    await exec(["git", "remote", "update", "--prune"], cachePath);
    return cachePath;
  }

  console.log(`[cache] cloning mirror for ${repoSlug}`);
  await exec(["git", "clone", "--mirror", "--quiet", `https://github.com/${repoSlug}.git`, cachePath], process.cwd());
  return cachePath;
}

async function cloneFromCache(cachedRepo: string, targetDir: string, cwd: string) {
  await exec(["git", "clone", "--quiet", cachedRepo, targetDir], cwd);
}

async function checkoutCommit(repoDir: string, sha: string): Promise<boolean> {
  if ((await exec(["git", "checkout", "--quiet", sha], repoDir, false, false)) === 0) {
    return true;
  }

  await exec(["git", "fetch", "--quiet", "origin", sha, "--depth=1"], repoDir, false, false);
  return (await exec(["git", "checkout", "--quiet", sha], repoDir, false, false)) === 0;
}

function formatPrDocs(pr: PullRequest): string {
  return [`# ${pr.title}`, pr.body?.trim()].filter(Boolean).join("\n\n").trim();
}

async function summarizeDiff(model: string, repoSlug: string, prNumber: number, diff: string): Promise<string> {
  console.log(`[summary] PR #${prNumber}: generating docs with ${model}`);
  const result = callModel(openRouter, {
    model,
    input: `Summarize this GitHub pull request as a concise implementation task for a coding agent.

Repository: ${repoSlug}
PR: #${prNumber}

Diff:
${truncate(diff, 24_000)}`,
  });

  return (await result.getText()).trim();
}

async function runEvalItem(item: EvalDatasetItem, options: CliOptions): Promise<EvalResult> {
  const workspace = await mkdtemp(join(tmpdir(), "tval-"));

  try {
    console.log(`[eval] PR #${item.prNumber}: setting up workspace`);
    const cachedRepo = await ensureRepoCache(item.githubRepo);
    const repoDir = join(workspace, basename(item.githubRepo));
    await cloneFromCache(cachedRepo, repoDir, workspace);
    if (!(await checkoutCommit(repoDir, item.commitBeforePR))) {
      throw new Error(`Prepared commit is no longer checkoutable: ${item.commitBeforePR}`);
    }

    console.log(`[agent] PR #${item.prNumber}: running ${options.evalLLM}`);
    await runCodingAgent(repoDir, item, options.evalLLM);
    console.log(`[diff] PR #${item.prNumber}: collecting candidate diff`);
    const evalLLMChangesDiff = await exec(["git", "diff", "--no-ext-diff"], repoDir, false);
    console.log(`[judge] PR #${item.prNumber}: running ${options.evalJudgeLLM}`);
    const judge = await judgeResult(item, evalLLMChangesDiff, options.evalJudgeLLM);
    console.log(`[result] PR #${item.prNumber}: rating ${judge.rating}/10`);

    return {
      repo: item.githubRepo,
      prNumber: item.prNumber,
      evalLLM: options.evalLLM,
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

async function runCodingAgent(repoDir: string, item: EvalDatasetItem, model: string) {
  const read = tool({
    name: "read",
    description: "Read file contents from the repository.",
    inputSchema: z.object({
      path: z.string().describe("File path relative to the repository root"),
    }),
    execute: async ({ path }) => {
      console.log(`[tool:read] ${path}`);
      return readTextFile(repoDir, path);
    },
  });

  const bash = tool({
    name: "bash",
    description: "Execute a bash command in the repository and return stdout, stderr, and exit code.",
    inputSchema: z.object({
      command: z.string().describe("Bash command to execute from the repository root"),
    }),
    execute: async ({ command }) => {
      console.log(`[tool:bash] ${command}`);
      const gitAwareCheck = validateBashRespectsGitignore(command);
      if (gitAwareCheck) {
        return { exitCode: 2, stdout: "", stderr: gitAwareCheck };
      }

      const proc = Bun.spawn(["bash", "-lc", command], { cwd: repoDir, stdout: "pipe", stderr: "pipe" });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      return { exitCode, stdout: truncate(stdout, 12_000), stderr: truncate(stderr, 12_000) };
    },
  });

  const edit = tool({
    name: "edit",
    description: "Make a surgical edit to a file. The old text must match exactly once.",
    inputSchema: z.object({
      path: z.string().describe("File path relative to the repository root"),
      oldText: z.string().describe("Exact text to replace"),
      newText: z.string().describe("Replacement text"),
    }),
    execute: async ({ path, oldText, newText }) => {
      console.log(`[tool:edit] ${path}`);
      const target = safeRepoPath(repoDir, path);
      await assertNotGitIgnored(repoDir, target);
      const current = await readFile(target, "utf8");
      const first = current.indexOf(oldText);
      if (first === -1) {
        throw new Error(`oldText was not found in ${path}`);
      }
      if (current.indexOf(oldText, first + oldText.length) !== -1) {
        throw new Error(`oldText matched more than once in ${path}; provide more context`);
      }
      await writeFile(target, current.slice(0, first) + newText + current.slice(first + oldText.length));
      return { ok: true };
    },
  });

  const write = tool({
    name: "write",
    description: "Create or overwrite a UTF-8 text file in the repository.",
    inputSchema: z.object({
      path: z.string().describe("File path relative to the repository root"),
      content: z.string().describe("Complete file contents"),
    }),
    execute: async ({ path, content }) => {
      console.log(`[tool:write] ${path}`);
      const target = safeRepoPath(repoDir, path);
      await assertNotGitIgnored(repoDir, target);
      await mkdir(resolve(target, ".."), { recursive: true });
      await writeFile(target, content);
      return { ok: true };
    },
  });

  const tools = [read, bash, edit, write] as const;

  const result = callModel(openRouter, {
    model,
    input: `You are an expert coding assistant. You help users with coding tasks by reading files, executing commands, editing code, and writing new files.

Available tools:
- read: Read file contents
- bash: Execute bash commands
- edit: Make surgical edits to files
- write: Create or overwrite files

Guidelines:
- Use bash for file operations like ls, grep, find
- Use read to examine files before editing
- Use edit for precise changes (old text must match exactly)
- Use write only for new files or complete rewrites
- When summarizing your actions, output plain text directly - do NOT use cat or bash to display what you did
- Be concise in your responses
- Show file paths clearly when working with files
- Respect the repository's .gitignore rules. Use git-aware discovery commands like git ls-files and git grep instead of raw ls/find/grep when searching source files.

Documentation:
- Your own documentation (including custom model setup and theme creation) is at: ${join(repoDir, "README.md")}
- Read it when users ask about features, configuration, or setup, and especially if the user asks you to add a custom model or provider, or create a custom theme.

You are editing a repository checked out immediately before a historical pull request.

Implement the requested change using the available filesystem tools. Make the smallest practical code change. Run a relevant validation command if the project makes that obvious.

Repository: ${item.githubRepo}
PR: #${item.prNumber}
Commit before PR: ${item.commitBeforePR}

Task docs:
${item.prDocs}`,
    tools,
    stopWhen: stepCountIs(12),
    allowFinalResponse: true,
  });
  await result.getText();
}

function validateBashRespectsGitignore(command: string): string | null {
  const usesRawDiscovery = /\b(ls|find|grep|rg)\b/.test(command);
  const usesGitDiscovery = /\bgit\s+(ls-files|grep|check-ignore)\b/.test(command);

  if (usesRawDiscovery && !usesGitDiscovery) {
    return "Command rejected: respect .gitignore by using git-aware discovery commands like `git ls-files` or `git grep`, or use the read/edit/write tools for exact file paths.";
  }

  return null;
}

async function judgeResult(
  item: EvalDatasetItem,
  evalLLMChangesDiff: string,
  model: string,
): Promise<{ rating: number; notes: string }> {
  console.log(`[judge] PR #${item.prNumber}: comparing ${evalLLMChangesDiff.length} candidate diff chars`);
  const result = callModel(openRouter, {
    model,
    input: `Judge the candidate implementation against the original merged PR. Rate functionality from 1 to 10.

Consider whether the candidate change appears to implement the same behavior and whether it is likely to compile. Return strict JSON with keys "rating" and "notes".

Task docs:
${item.prDocs}

Original PR diff:
${truncate(item.prDiff, 30_000)}

Candidate diff:
${truncate(evalLLMChangesDiff || "(no changes)", 30_000)}`,
  });

  const text = (await result.getText()).trim();
  const parsed = parseJsonObject(text);
  const rating = Math.max(1, Math.min(10, Number(parsed.rating) || 1));
  const notes = typeof parsed.notes === "string" ? parsed.notes : text;
  return { rating, notes };
}

function parseJsonObject(text: string): Record<string, unknown> {
  const json = text.match(/\{[\s\S]*\}/)?.[0] ?? text;
  try {
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return { rating: 1, notes: text };
  }
}

async function readTextFile(repoDir: string, path: string): Promise<string> {
  const target = safeRepoPath(repoDir, path);
  await assertNotGitIgnored(repoDir, target);
  return truncate(await readFile(target, "utf8"), 50_000);
}

function safeRepoPath(repoDir: string, path: string): string {
  const target = resolve(repoDir, path);
  if (target !== repoDir && !target.startsWith(`${repoDir}/`)) {
    throw new Error(`Path escapes repository: ${path}`);
  }
  return target;
}

async function assertNotGitIgnored(repoDir: string, target: string) {
  const relativePath = relative(repoDir, target);
  const exitCode = await exec(["git", "check-ignore", "--quiet", "--", relativePath], repoDir, false, false);
  if (exitCode === 0) {
    throw new Error(`Path is ignored by git rules: ${relativePath}`);
  }
  if (exitCode !== 1) {
    throw new Error(`Could not check git ignore rules for: ${relativePath}`);
  }
}

async function githubJson<T>(url: string): Promise<T> {
  const response = await githubFetch(url, "application/vnd.github+json");
  return (await response.json()) as T;
}

async function githubText(url: string): Promise<string> {
  const response = await githubFetch(url, "application/vnd.github.v3.diff");
  return response.text();
}

async function githubFetch(url: string, accept: string): Promise<Response> {
  const headers: Record<string, string> = {
    Accept: accept,
    "User-Agent": "tiny-eval-cli",
  };

  if (Bun.env.GITHUB_TOKEN) {
    headers.Authorization = `Bearer ${Bun.env.GITHUB_TOKEN}`;
  }

  const response = await fetch(url, { headers });
  if (!response.ok) {
    throw new Error(`GitHub request failed ${response.status} ${response.statusText}: ${url}`);
  }

  return response;
}

function exec(args: string[], cwd: string, throwOnError?: boolean): Promise<string>;
function exec(args: string[], cwd: string, throwOnError: boolean, returnStdout: false): Promise<number>;
async function exec(args: string[], cwd: string, throwOnError = true, returnStdout = true): Promise<string | number> {
  const proc = Bun.spawn(args, { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  if (throwOnError && exitCode !== 0) {
    throw new Error(`Command failed: ${args.join(" ")}\n${stderr}`);
  }

  return returnStdout ? stdout : exitCode;
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength)}\n\n[truncated ${value.length - maxLength} chars]`;
}

function renderReport(output: EvalOutput, options: CliOptions): string {
  const rows = output.evalResults
    .map(
      (result) => `<tr>
        <td>${escapeHtml(result.repo)}#${result.prNumber}</td>
        <td><span class="rating">${result.rating.toFixed(1)}</span></td>
        <td>${escapeHtml(result.evalLLM)}</td>
        <td>${escapeHtml(result.judgeNotes)}</td>
      </tr>`,
    )
    .join("");

  const cards = output.evaDataset
    .map(
      (item) => `<section class="card">
        <div class="meta">PR #${item.prNumber} · ${escapeHtml(item.commitBeforePR.slice(0, 12))}</div>
        <h2>${escapeHtml(item.githubRepo)}</h2>
        <p>${escapeHtml(item.prDocs)}</p>
      </section>`,
    )
    .join("");

  const average =
    output.evalResults.reduce((sum, result) => sum + result.rating, 0) /
    Math.max(output.evalResults.length, 1);

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>tiny-eval report</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Iosevka+Charon:ital,wght@0,400;0,600;1,400&display=swap" rel="stylesheet">
  <style>
    :root {
      --background-primary: #202020;
      --background-secondary: #161616;
      --background-modifier-border: #363636;
      --text-normal: #dcddde;
      --text-muted: #999999;
      --text-accent: #8a5cf5;
      --interactive-accent: #7f6df2;
      --green: #70c27e;
      --red: #ff6b6b;
    }

    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--background-primary);
      color: var(--text-normal);
      font-family: "Iosevka Charon", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      letter-spacing: 0;
    }

    main {
      width: min(1180px, calc(100% - 32px));
      margin: 0 auto;
      padding: 32px 0;
    }

    header {
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 16px;
      align-items: end;
      border-bottom: 1px solid var(--background-modifier-border);
      padding-bottom: 20px;
      margin-bottom: 24px;
    }

    h1, h2, p { margin: 0; }
    h1 { font-size: 28px; font-weight: 600; }
    h2 { font-size: 16px; margin: 6px 0 10px; }
    p { color: var(--text-muted); white-space: pre-wrap; line-height: 1.45; }
    .meta { color: var(--text-muted); font-size: 13px; }
    .score {
      border: 1px solid var(--background-modifier-border);
      border-radius: 8px;
      padding: 12px 14px;
      background: var(--background-secondary);
      min-width: 132px;
      text-align: right;
    }
    .score strong { color: var(--green); font-size: 24px; display: block; }

    table {
      width: 100%;
      border-collapse: collapse;
      background: var(--background-secondary);
      border: 1px solid var(--background-modifier-border);
      border-radius: 8px;
      overflow: hidden;
      margin-bottom: 24px;
    }

    th, td {
      border-bottom: 1px solid var(--background-modifier-border);
      padding: 12px;
      text-align: left;
      vertical-align: top;
      line-height: 1.4;
    }

    th { color: var(--text-muted); font-weight: 600; }
    tr:last-child td { border-bottom: 0; }
    .rating { color: var(--green); font-weight: 600; }

    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
      gap: 12px;
    }

    .card {
      border: 1px solid var(--background-modifier-border);
      border-radius: 8px;
      background: var(--background-secondary);
      padding: 14px;
      min-width: 0;
    }

    @media (max-width: 700px) {
      header { grid-template-columns: 1fr; }
      .score { text-align: left; }
      table { display: block; overflow-x: auto; }
    }
  </style>
</head>
<body>
  <main>
    <header>
      <div>
        <div class="meta">tiny-eval · ${escapeHtml(new Date().toISOString())}</div>
        <h1>${escapeHtml(options.repo)}</h1>
        <div class="meta">eval ${escapeHtml(options.evalLLM)} · judge ${escapeHtml(options.evalJudgeLLM)}</div>
      </div>
      <div class="score">
        <span class="meta">average</span>
        <strong>${average.toFixed(1)}</strong>
      </div>
    </header>

    <table>
      <thead>
        <tr>
          <th>case</th>
          <th>rating</th>
          <th>model</th>
          <th>judge notes</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>

    <div class="grid">${cards}</div>
  </main>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
