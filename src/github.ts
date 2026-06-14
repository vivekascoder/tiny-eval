export async function githubJson<T>(url: string): Promise<T> {
  const response = await githubFetch(url, "application/vnd.github+json");
  return (await response.json()) as T;
}

export async function githubText(url: string): Promise<string> {
  const response = await githubFetch(url, "application/vnd.github.v3.diff");
  return response.text();
}

async function githubFetch(url: string, accept: string): Promise<Response> {
  const headers: Record<string, string> = {
    Accept: accept,
    "User-Agent": "tiny-eval-cli",
  };

  if (Bun.env.GITHUB_TOKEN) {
    headers.Authorization = `Bearer ${Bun.env.GITHUB_TOKEN}`;
  }

  const response = await fetch(url, { headers });
  if (!response.ok) {
    throw new Error(`GitHub request failed ${response.status} ${response.statusText}: ${url}`);
  }

  return response;
}
