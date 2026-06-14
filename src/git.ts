import { mkdir } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import { exec } from "./command.ts";

const repoCacheRoot = resolve(process.cwd(), ".tval-cache", "repos");

export async function ensureRepoCache(repoSlug: string): Promise<string> {
  await mkdir(repoCacheRoot, { recursive: true });
  const cachePath = repoCachePath(repoSlug);

  if (await Bun.file(join(cachePath, "HEAD")).exists()) {
    console.log(`[cache] refreshing ${relative(process.cwd(), cachePath)}`);
    await exec(["git", "remote", "update", "--prune"], cachePath);
    return cachePath;
  }

  console.log(`[cache] cloning mirror for ${repoSlug}`);
  await exec(["git", "clone", "--mirror", "--quiet", `https://github.com/${repoSlug}.git`, cachePath], process.cwd());
  return cachePath;
}

export function repoCachePath(repoSlug: string): string {
  return join(repoCacheRoot, `${repoSlug.replaceAll("/", "__")}.git`);
}

export async function cloneFromCache(cachedRepo: string, targetDir: string, cwd: string) {
  await exec(["git", "clone", "--quiet", cachedRepo, targetDir], cwd);
}

export async function checkoutCommit(repoDir: string, sha: string): Promise<boolean> {
  if ((await exec(["git", "checkout", "--quiet", sha], repoDir, false, false)) === 0) {
    return true;
  }

  await exec(["git", "fetch", "--quiet", "origin", sha, "--depth=1"], repoDir, false, false);
  return (await exec(["git", "checkout", "--quiet", sha], repoDir, false, false)) === 0;
}

export async function collectDiff(repoDir: string): Promise<string> {
  return exec(["git", "diff", "--no-ext-diff"], repoDir, false);
}

export async function assertNotGitIgnored(repoDir: string, target: string) {
  const relativePath = relative(repoDir, target);
  const exitCode = await exec(["git", "check-ignore", "--quiet", "--", relativePath], repoDir, false, false);
  if (exitCode === 0) {
    throw new Error(`Path is ignored by git rules: ${relativePath}`);
  }
  if (exitCode !== 1) {
    throw new Error(`Could not check git ignore rules for: ${relativePath}`);
  }
}

export function repoDirectory(workspace: string, repoSlug: string): string {
  return join(workspace, basename(repoSlug));
}
