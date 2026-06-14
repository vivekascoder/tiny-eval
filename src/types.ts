export type CliOptions = {
  repo: string;
  evalLLMs: string[];
  prSummaryLLM: string;
  evalJudgeLLM: string;
  output?: string;
  limit: number;
  concurrency: number;
  retries: number;
};

export type PullRequest = {
  number: number;
  title: string;
  body: string | null;
  html_url: string;
  diff_url: string;
  merged_at: string | null;
  base: {
    sha: string;
  };
};

export type EvalDatasetItem = {
  githubRepo: string;
  prNumber: number;
  prUrl: string;
  prDocs: string;
  prDiff: string;
  commitBeforePR: string;
};

export type EvalResult = {
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

export type EvalOutput = {
  evaDataset: EvalDatasetItem[];
  evalResults: EvalResult[];
};

export type TinyBenchEval = {
  evalLLM: string;
  prSummaryLLM: string;
  evalJudgeLLM: string;
  rating: number;
  evalLLMChangesDiff: string;
};

export type TinyBenchItem = {
  repo: string;
  commit: string;
  pr: number;
  prDocs: string;
  prDiff: string;
  evals: TinyBenchEval[];
};
