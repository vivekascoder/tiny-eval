import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { githubJson, githubText } from "./github.ts";
import { checkoutCommit, cloneFromCache, ensureRepoCache } from "./git.ts";
import { summarizeDiff } from "./model.ts";
import type { CliOptions, EvalDatasetItem, PullRequest } from "./types.ts";

export async function prepareDataset(repoSlug: string, options: CliOptions): Promise<EvalDatasetItem[]> {
  console.log(`[cache] preparing ${repoSlug}`);
  const cachedRepo = await ensureRepoCache(repoSlug);
  const validationWorkspace = await mkdtemp(join(tmpdir(), "tval-validate-"));
  const validationRepoDir = join(validationWorkspace, basename(repoSlug));

  console.log(`[dataset] cloning validation copy from cache`);
  await cloneFromCache(cachedRepo, validationRepoDir, validationWorkspace);

  const requestedPrs = options.prs && options.prs.length > 0;
  const pulls = await fetchPullRequests(repoSlug, options);

  const dataset: EvalDatasetItem[] = [];
  try {
    for (const pr of pulls) {
      if (!pr.merged_at) {
        continue;
      }

      const commitBeforePR = pr.base.sha;
      if (!commitBeforePR || !(await checkoutCommit(validationRepoDir, commitBeforePR))) {
        console.warn(`[dataset] skipping PR #${pr.number}: base commit is not checkoutable`);
        continue;
      }

      console.log(`[dataset] selected PR #${pr.number} at ${commitBeforePR.slice(0, 12)}`);
      const prDiff = await githubText(pr.diff_url);
      const docs = formatPrDocs(pr);
      const prDocs =
        docs.length > 0
          ? docs
          : await summarizeDiff(options.prSummaryLLM, repoSlug, pr.number, prDiff);

      dataset.push({
        githubRepo: repoSlug,
        prNumber: pr.number,
        prUrl: pr.html_url,
        prDocs,
        prDiff,
        commitBeforePR,
      });

      if (!requestedPrs && dataset.length >= options.limit) {
        break;
      }
    }
  } finally {
    await rm(validationWorkspace, { recursive: true, force: true });
  }

  if (dataset.length === 0) {
    throw new Error(`No merged pull requests with usable commits found for ${repoSlug}`);
  }

  return dataset;
}

async function fetchPullRequests(repoSlug: string, options: CliOptions): Promise<PullRequest[]> {
  if (options.prs && options.prs.length > 0) {
    console.log(`[github] fetching requested PRs: ${options.prs.map((pr) => `#${pr}`).join(", ")}`);
    const pulls: PullRequest[] = [];
    for (const prNumber of options.prs) {
      pulls.push(await githubJson<PullRequest>(`https://api.github.com/repos/${repoSlug}/pulls/${prNumber}`));
    }
    return pulls;
  }

  console.log(`[github] fetching candidate PRs`);
  return githubJson<PullRequest[]>(
    `https://api.github.com/repos/${repoSlug}/pulls?state=closed&sort=created&direction=asc&per_page=${Math.max(options.limit * 20, 50)}`,
  );
}

function formatPrDocs(pr: PullRequest): string {
  return [`# ${pr.title}`, pr.body?.trim()].filter(Boolean).join("\n\n").trim();
}
