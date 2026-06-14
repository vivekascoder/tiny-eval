import { resolve } from "node:path";
import type { CliOptions } from "./types.ts";

export const usage = `Usage:
  tval run-eval --repo <owner/repo|github-url> --eval-llms <model>[,<model>...] --pr-summary-llm <model> --eval-judge-llm <model> [--output <name>] [--prs 12,34] [--limit 3] [--concurrency 4] [--retries 2]

Environment:
  OPENROUTER_API_KEY is required for LLM summary, eval, and judge calls.`;

export async function preferDotenvKeys(keys: string[]) {
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

export function parseOptions(args: string[]): CliOptions {
  const values = new Map<string, Array<string | boolean>>();

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith("--")) {
      throw new Error(`Unexpected argument: ${arg}`);
    }

    const [rawKey, inlineValue] = arg.slice(2).split("=", 2);
    if (inlineValue !== undefined) {
      appendValue(values, rawKey, inlineValue);
      continue;
    }

    const next = args[index + 1];
    if (!next || next.startsWith("--")) {
      appendValue(values, rawKey, true);
      continue;
    }

    appendValue(values, rawKey, next);
    index += 1;
  }

  const repo = required(values, "repo");
  const evalLLMs = requiredList(values, "eval-llms");
  const prSummaryLLM = required(values, "pr-summary-llm");
  const evalJudgeLLM = required(values, "eval-judge-llm");
  const prs = optionalPositiveIntegerList(values, "prs");
  const limit = Number(lastValue(values, "limit") ?? 3);
  const concurrency = Number(lastValue(values, "concurrency") ?? 4);
  const retries = Number(lastValue(values, "retries") ?? 2);

  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error("--limit must be a positive integer");
  }
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error("--concurrency must be a positive integer");
  }
  if (!Number.isInteger(retries) || retries < 0) {
    throw new Error("--retries must be a non-negative integer");
  }

  return {
    repo,
    evalLLMs,
    prSummaryLLM,
    evalJudgeLLM,
    output: optionalString(lastValue(values, "output")),
    prs,
    limit,
    concurrency,
    retries,
  };
}

export function normalizeRepo(repo: string): string {
  const trimmed = repo.trim().replace(/\.git$/, "");
  const match = trimmed.match(/github\.com[:/](?<owner>[^/]+)\/(?<name>[^/#?]+)/);
  const slug = match?.groups ? `${match.groups.owner}/${match.groups.name}` : trimmed;

  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(slug)) {
    throw new Error(`Expected --repo to be owner/repo or a GitHub URL, received: ${repo}`);
  }

  return slug;
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

function appendValue(values: Map<string, Array<string | boolean>>, key: string, value: string | boolean) {
  const existing = values.get(key);
  if (existing) {
    existing.push(value);
  } else {
    values.set(key, [value]);
  }
}

function lastValue(values: Map<string, Array<string | boolean>>, key: string): string | boolean | undefined {
  return values.get(key)?.at(-1);
}

function required(values: Map<string, Array<string | boolean>>, key: string): string {
  const value = lastValue(values, key);
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Missing required option --${key}\n\n${usage}`);
  }
  return value;
}

function requiredList(values: Map<string, Array<string | boolean>>, key: string): string[] {
  const models = (values.get(key) ?? [])
    .filter((value): value is string => typeof value === "string")
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter(Boolean);

  if (models.length === 0) {
    throw new Error(`Missing required option --${key}\n\n${usage}`);
  }

  return [...new Set(models)];
}

function optionalPositiveIntegerList(values: Map<string, Array<string | boolean>>, key: string): number[] | undefined {
  const items = (values.get(key) ?? [])
    .filter((value): value is string => typeof value === "string")
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter(Boolean);

  if (items.length === 0) {
    return undefined;
  }

  const parsed = items.map((value) => Number(value));
  const invalid = parsed.find((value) => !Number.isInteger(value) || value < 1);
  if (invalid !== undefined) {
    throw new Error(`--${key} must contain positive integer PR numbers`);
  }

  return [...new Set(parsed)];
}

function optionalString(value: string | boolean | undefined): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
