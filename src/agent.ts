import { callModel, stepCountIs, tool } from "@openrouter/agent";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { assertNotGitIgnored } from "./git.ts";
import { getOpenRouter } from "./model.ts";
import { buildCodingAgentPrompt } from "./prompts.ts";
import type { EvalDatasetItem } from "./types.ts";
import { safeRepoPath, truncate } from "./utils.ts";

export async function runCodingAgent(repoDir: string, item: EvalDatasetItem, model: string) {
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
    description: "Execute a non-Git shell command in the repository and return stdout, stderr, and exit code.",
    inputSchema: z.object({
      command: z.string().describe("Bash command to execute from the repository root"),
    }),
    execute: async ({ command }) => {
      console.log(`[tool:bash] ${command}`);
      const rejection = validateAgentBashCommand(command);
      if (rejection) {
        return { exitCode: 2, stdout: "", stderr: rejection };
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
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content);
      return { ok: true };
    },
  });

  const result = callModel(getOpenRouter(), {
    model,
    input: buildCodingAgentPrompt(item),
    tools: [read, bash, edit, write] as const,
    stopWhen: stepCountIs(12),
    allowFinalResponse: true,
  });
  await result.getText();
}

function validateAgentBashCommand(command: string): string | null {
  if (referencesGitMetadata(command)) {
    return "Command rejected: the evaluated agent cannot access Git metadata or .git paths.";
  }

  if (invokesGit(command)) {
    return "Command rejected: the evaluated agent cannot use git commands. Work only from the current filesystem snapshot.";
  }

  return null;
}

function invokesGit(command: string): boolean {
  return /(^|[\s;&|(){}])(?:[./\w-]+\/)?git(?=$|[\s;&|(){}])/.test(command);
}

function referencesGitMetadata(command: string): boolean {
  return /(^|[/"'\s])\.git(?=$|[/"'\s])/.test(command) || /\bGIT_[A-Z0-9_]+\b/.test(command);
}

async function readTextFile(repoDir: string, path: string): Promise<string> {
  const target = safeRepoPath(repoDir, path);
  await assertNotGitIgnored(repoDir, target);
  return truncate(await readFile(target, "utf8"), 50_000);
}
