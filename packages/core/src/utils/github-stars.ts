const REPO_API_URL = 'https://api.github.com/repos/docdru/GitQuire';

export async function getGitHubStars(init?: RequestInit): Promise<number | null> {
  const { signal: callerSignal, ...restInit } = init ?? {};
  const signal = callerSignal
    ? AbortSignal.any([AbortSignal.timeout(5_000), callerSignal])
    : AbortSignal.timeout(5_000);
  try {
    const res = await fetch(REPO_API_URL, {
      headers: {
        accept: 'application/vnd.github+json',
        'user-agent': 'GitQuire',
      },
      ...restInit,
      signal,
    });
    if (!res.ok) {
      console.warn(`[github-stars] GitHub API responded ${res.status}`);
      return null;
    }
    const json = (await res.json()) as { stargazers_count?: unknown };
    return typeof json.stargazers_count === 'number' ? json.stargazers_count : null;
  } catch (err) {
    console.warn(
      `[github-stars] fetch failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}
