# tiny-eval

`tiny-eval` builds small coding-agent eval runs from historical GitHub pull requests.

## CLI

```bash
OPENROUTER_API_KEY=... bun run tval run-eval \
  --repo owner/repo \
  --eval-llm anthropic/claude-sonnet-4 \
  --pr-summary-llm openai/gpt-4.1-mini \
  --eval-judge-llm anthropic/claude-sonnet-4 \
  --limit 3
```

Options:

- `--repo`: GitHub `owner/repo` or GitHub URL.
- `--eval-llm`: model being evaluated.
- `--pr-summary-llm`: model used to summarize PRs when PR docs are empty.
- `--eval-judge-llm`: model used to judge candidate diffs.
- `--output`: optional output directory.
- `--limit`: optional eval case count, default `3`.

Optional environment:

- `GITHUB_TOKEN`: increases GitHub API rate limits for public repo processing.

## Output

Each run writes an `eval_run_<timestamp>/` directory unless `--output` is provided:

- `eval.json`: dataset and eval results.
- `index.html`: static dark report using an Obsidian-style palette and Iosevka Charon.

The eval agent checks out the repository at the commit immediately before each selected PR, edits files through OpenRouter Agent SDK tools, captures `git diff`, then asks the judge model to rate the result from 1 to 10.
