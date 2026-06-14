import { callModel } from "@openrouter/agent";
import { OpenRouter } from "@openrouter/sdk";
import { buildJudgePrompt, buildSummaryPrompt } from "./prompts.ts";
import type { EvalDatasetItem } from "./types.ts";
import { parseJsonObject } from "./utils.ts";

type ModelResult = ReturnType<typeof callModel>;

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
  const result = callModelWithContext("summary", model, () =>
    callModel(getOpenRouter(), {
      model,
      input: buildSummaryPrompt(repoSlug, prNumber, diff),
    }),
  );

  return (await result.getText()).trim();
}

export async function judgeResult(
  item: EvalDatasetItem,
  evalLLMChangesDiff: string,
  model: string,
): Promise<{ rating: number; notes: string }> {
  console.log(`[judge] PR #${item.prNumber}: comparing ${evalLLMChangesDiff.length} candidate diff chars`);
  const result = callModelWithContext("judge", model, () =>
    callModel(getOpenRouter(), {
      model,
      input: buildJudgePrompt(item, evalLLMChangesDiff),
    }),
  );

  const text = (await result.getText()).trim();
  const parsed = parseJsonObject(text);
  const rating = Math.max(1, Math.min(10, Number(parsed.rating) || 1));
  const notes = typeof parsed.notes === "string" ? parsed.notes : text;
  return { rating, notes };
}

export function callModelWithContext(phase: string, model: string, createResult: () => ModelResult): ModelResult {
  try {
    return withOpenRouterContext(phase, model, createResult());
  } catch (error) {
    throw formatOpenRouterError(error, phase, model);
  }
}

function withOpenRouterContext<T extends { getText(): Promise<string> }>(
  phase: string,
  model: string,
  result: T,
): T {
  return {
    ...result,
    async getText() {
      try {
        return await result.getText();
      } catch (error) {
        throw formatOpenRouterError(error, phase, model);
      }
    },
  };
}

function formatOpenRouterError(error: unknown, phase: string, model: string): Error {
  const message = error instanceof Error ? error.message : String(error);
  if (
    /No endpoints available matching your guardrail restrictions and data policy/i.test(message) ||
    /No allowed providers are available for the selected model/i.test(message)
  ) {
    return new Error(
      [
        `OpenRouter could not route the ${phase} model "${model}".`,
        "Your OpenRouter key is valid, but your account/provider settings exclude every available endpoint for this model.",
        "Fix provider/privacy routing at https://openrouter.ai/settings/privacy, or choose a model/provider allowed by those settings.",
      ].join("\n"),
    );
  }

  return error instanceof Error ? error : new Error(message);
}
