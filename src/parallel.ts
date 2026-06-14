import type { CliOptions, EvalDatasetItem, EvalResult } from "./types.ts";

export type EvalJob = {
  index: number;
  item: EvalDatasetItem;
  evalLLM: string;
  cachedRepo: string;
};

export type EvalWorkerRequest = {
  job: EvalJob;
  options: CliOptions;
  env: {
    OPENROUTER_API_KEY?: string;
    GITHUB_TOKEN?: string;
  };
};

export type EvalWorkerResponse =
  | {
      ok: true;
      index: number;
      result: EvalResult;
    }
  | {
      ok: false;
      index: number;
      error: string;
      stack?: string;
    };

export async function runEvalJobs(jobs: EvalJob[], options: CliOptions): Promise<EvalResult[]> {
  if (jobs.length === 0) {
    return [];
  }

  const concurrency = Math.min(options.concurrency, jobs.length);
  const results: EvalResult[] = new Array(jobs.length);
  let nextJobIndex = 0;
  let completed = 0;

  return new Promise((resolve, reject) => {
    let rejected = false;
    const activeWorkers = new Set<Worker>();

    const rejectOnce = (error: Error) => {
      if (rejected) {
        return;
      }
      rejected = true;
      for (const worker of activeWorkers) {
        worker.terminate();
      }
      reject(error);
    };

    const startNext = () => {
      if (rejected) {
        return;
      }
      if (completed === jobs.length) {
        resolve(results);
        return;
      }
      if (nextJobIndex >= jobs.length) {
        return;
      }

      const job = jobs[nextJobIndex];
      nextJobIndex += 1;
      const worker = new Worker(new URL("./eval-worker.ts", import.meta.url).href);
      activeWorkers.add(worker);
      let settled = false;

      worker.addEventListener("message", (event: MessageEvent<EvalWorkerResponse>) => {
        if (settled) {
          return;
        }
        settled = true;
        activeWorkers.delete(worker);
        worker.terminate();

        const response = event.data;
        if (!response.ok) {
          rejectOnce(new Error(response.stack ? `${response.error}\n${response.stack}` : response.error));
          return;
        }

        results[response.index] = response.result;
        completed += 1;
        console.log(`[parallel] completed ${completed}/${jobs.length}`);
        startNext();
      });

      worker.addEventListener("error", (event) => {
        if (settled) {
          return;
        }
        settled = true;
        activeWorkers.delete(worker);
        rejectOnce(new Error(`Worker failed for PR #${job.item.prNumber} (${job.evalLLM}): ${String(event)}`));
      });

      worker.addEventListener("close", (event) => {
        if (settled || rejected) {
          return;
        }
        settled = true;
        activeWorkers.delete(worker);
        rejectOnce(
          new Error(`Worker closed before completing PR #${job.item.prNumber} (${job.evalLLM}); exit code ${event.code}`),
        );
      });

      worker.postMessage({
        job,
        options,
        env: {
          OPENROUTER_API_KEY: Bun.env.OPENROUTER_API_KEY,
          GITHUB_TOKEN: Bun.env.GITHUB_TOKEN,
        },
      } satisfies EvalWorkerRequest);
    };

    for (let index = 0; index < concurrency; index += 1) {
      startNext();
    }
  });
}
