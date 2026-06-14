import { runEvalItem } from "./eval.ts";
import type { EvalWorkerRequest, EvalWorkerResponse } from "./parallel.ts";

declare const self: Worker;

self.addEventListener("message", async (event: MessageEvent<EvalWorkerRequest>) => {
  const { job, options, env } = event.data;
  if (env.OPENROUTER_API_KEY) {
    Bun.env.OPENROUTER_API_KEY = env.OPENROUTER_API_KEY;
  }
  if (env.GITHUB_TOKEN) {
    Bun.env.GITHUB_TOKEN = env.GITHUB_TOKEN;
  }

  try {
    const result = await runWithRetries(() => runEvalItem(job.item, options, job.evalLLM, job.cachedRepo), {
      attempts: options.retries + 1,
      label: `PR #${job.item.prNumber} (${job.evalLLM})`,
    });
    postMessage({
      ok: true,
      index: job.index,
      result,
    } satisfies EvalWorkerResponse);
  } catch (error) {
    postMessage({
      ok: false,
      index: job.index,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    } satisfies EvalWorkerResponse);
  }
});

async function runWithRetries<T>(
  fn: () => Promise<T>,
  { attempts, label }: { attempts: number; label: string },
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt >= attempts || !isRetryableError(error)) {
        throw error;
      }

      const delayMs = 1_000 * attempt;
      console.warn(`[retry] ${label}: transient error on attempt ${attempt}/${attempts}; retrying in ${delayMs}ms`);
      await Bun.sleep(delayMs);
    }
  }

  throw lastError;
}

function isRetryableError(error: unknown): boolean {
  const message = error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error);
  return /server_error|idle timeout|timeout exceeded|upstream|ECONNRESET|ETIMEDOUT|fetch failed|5\d\d/i.test(message);
}
