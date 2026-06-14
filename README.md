# tiny-eval

`tiny-eval` builds small coding-agent eval runs from historical GitHub pull requests.

## CLI

```bash
OPENROUTER_API_KEY=... bun run tval run-eval \
  --repo owner/repo \
  --eval-llms anthropic/claude-sonnet-4,openai/gpt-4.1 \
  --pr-summary-llm openai/gpt-4.1-mini \
  --eval-judge-llm anthropic/claude-sonnet-4 \
  --limit 3 \
  --concurrency 4 \
  --retries 2
```

Options:

- `--repo`: GitHub `owner/repo` or GitHub URL.
- `--eval-llms`: comma-separated models being evaluated. The flag may also be repeated.
- `--pr-summary-llm`: model used to summarize PRs when PR docs are empty.
- `--eval-judge-llm`: model used to judge candidate diffs.
- `--output`: optional output directory name under `evals/`.
- `--limit`: optional eval case count, default `3`.
- `--concurrency`: optional number of eval jobs to run in parallel with Bun workers, default `4`.
- `--retries`: optional transient failure retries per eval job, default `2`.

Optional environment:

- `GITHUB_TOKEN`: increases GitHub API rate limits for public repo processing.

## Output

Each run writes an `evals/eval_run_<timestamp>/` directory unless `--output` is provided:

- `eval.json`: dataset and eval results.
- `index.html`: static dark report with a model leaderboard ranked by average score.
- `diffs/*.diff`: original PR diffs and candidate eval diffs.

`eval.json` stores relative paths to diff files instead of embedding diff bodies. Dataset `prDiff` points to the original PR diff, result `originalPRDiff` points to the same file, and result `evalLLMChangesDiff` points to that eval job's candidate diff.

Eval jobs run in parallel using Bun worker threads. Each worker gets an isolated checkout of the prepared repository cache, runs one `(PR, eval model)` job, then returns its result to the main process.

The evaluator checks out the repository at the commit immediately before each selected PR, gives the eval agent only that filesystem snapshot, captures the resulting diff, then asks the judge model to rate the result from 1 to 10. Git operations are host-side evaluator plumbing; the eval agent's shell tool rejects Git commands and `.git` metadata access.

## Code layout

- `src/prompts.ts`: summary, eval-agent, and judge prompts.
- `src/report.ts`: static HTML report template.
- `src/agent.ts`: eval-agent tools and command restrictions.
- `src/dataset.ts`, `src/eval.ts`: dataset preparation and per-case eval flow.
- `src/git.ts`, `src/github.ts`: host-side repository and GitHub API plumbing.
