import { relative, resolve } from "node:path";

export function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength)}\n\n[truncated ${value.length - maxLength} chars]`;
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function safeRepoPath(repoDir: string, path: string): string {
  const target = resolve(repoDir, path);
  if (target !== repoDir && !target.startsWith(`${repoDir}/`)) {
    throw new Error(`Path escapes repository: ${path}`);
  }

  const relativePath = relative(repoDir, target);
  if (relativePath === ".git" || relativePath.startsWith(".git/")) {
    throw new Error(`Path is not available to the agent: ${path}`);
  }

  return target;
}

export function parseJsonObject(text: string): Record<string, unknown> {
  const json = text.match(/\{[\s\S]*\}/)?.[0] ?? text;
  try {
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return { rating: 1, notes: text };
  }
}
