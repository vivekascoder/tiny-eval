import { callModel } from "@openrouter/agent";
import { OpenRouter } from "@openrouter/sdk";
import { buildJudgePrompt, buildSummaryPrompt } from "./prompts.ts";
import type { EvalDatasetItem } from "./types.ts";
import { parseJsonObject } from "./utils.ts";

let openRouter: OpenRouter | undefined;

export function getOpenRouter(): OpenRouter {
  openRouter ??= new OpenRouter({
    apiKey: Bun.env.OPENROUTER_API_KEY,
  });

  return openRouter;
}

export async function validateOpenRouterKey() {
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

export async function summarizeDiff(model: string, repoSlug: string, prNumber: number, diff: string): Promise<string> {
  console.log(`[summary] PR #${prNumber}: generating docs with ${model}`);
  const result = callModel(getOpenRouter(), {
    model,
    input: buildSummaryPrompt(repoSlug, prNumber, diff),
  });

  return (await result.getText()).trim();
}

export async function judgeResult(
  item: EvalDatasetItem,
  evalLLMChangesDiff: string,
  model: string,
): Promise<{ rating: number; notes: string }> {
  console.log(`[judge] PR #${item.prNumber}: comparing ${evalLLMChangesDiff.length} candidate diff chars`);
  const result = callModel(getOpenRouter(), {
    model,
    input: buildJudgePrompt(item, evalLLMChangesDiff),
  });

  const text = (await result.getText()).trim();
  const parsed = parseJsonObject(text);
  const rating = Math.max(1, Math.min(10, Number(parsed.rating) || 1));
  const notes = typeof parsed.notes === "string" ? parsed.notes : text;
  return { rating, notes };
}
