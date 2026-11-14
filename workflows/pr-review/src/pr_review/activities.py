"""Activities for the PR review worker.

All side effects (GitHub API, LLM) live here; the workflow itself only
orchestrates. The GitHub token is read from the environment inside the
activities so it never enters the workflow event history.
"""

from __future__ import annotations

import os
from datetime import datetime, timedelta, timezone

import mistralai.workflows as workflows

from .prompt import build_review_prompt

GITHUB_API = "https://api.github.com"
GITHUB_API_VERSION = "2022-11-28"
HTTP_TIMEOUT = 60.0
REVIEW_MARKER = "<!-- gitquire-pr-review:{sha} -->"


def _github_token() -> str:
    token = os.environ.get("GITHUB_TOKEN", "").strip()
    if not token:
        raise RuntimeError(
            "GITHUB_TOKEN is not set. Bind the workspace secret 'github_token' to the "
            "GITHUB_TOKEN env var on the workflow deployment."
        )
    return token


def _headers(extra: dict[str, str] | None = None) -> dict[str, str]:
    return {
        "Authorization": f"Bearer {_github_token()}",
        "Accept": "application/vnd.github+json",
        "User-Agent": "gitquire-pr-review-worker",
        "X-GitHub-Api-Version": GITHUB_API_VERSION,
        **(extra or {}),
    }


async def _github_get(path: str, extra_headers: dict[str, str] | None = None):
    import httpx

    async with httpx.AsyncClient(timeout=HTTP_TIMEOUT) as client:
        response = await client.get(f"{GITHUB_API}{path}", headers=_headers(extra_headers))
        response.raise_for_status()
        return response


def _parse_github_time(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(timezone.utc)


def _recent_commit_summaries(commits: list[dict], since: datetime) -> list[dict]:
    recent = []
    for commit in commits:
        committer_date = (commit.get("commit", {}).get("committer", {}) or {}).get("date", "")
        if not committer_date:
            continue
        if _parse_github_time(committer_date) >= since:
            message = str(commit.get("commit", {}).get("message", "")).splitlines()[0]
            recent.append(
                {
                    "sha": str(commit.get("sha", ""))[:7],
                    "message": message,
                    "date": committer_date,
                }
            )
    recent.reverse()
    return recent


@workflows.activity()
async def list_open_prs(repo: str, max_prs: int) -> list[dict]:
    """List open pull requests, most recently updated first."""
    response = await _github_get(f"/repos/{repo}/pulls?state=open&per_page=100&sort=updated&direction=desc")
    prs = response.json()
    out = []
    for pr in prs[:max_prs]:
        out.append(
            {
                "number": pr["number"],
                "title": pr["title"],
                "url": pr["html_url"],
                "author": pr.get("user", {}).get("login", ""),
                "created_at": pr.get("created_at", ""),
                "updated_at": pr.get("updated_at", ""),
                "head": pr.get("head", {}).get("ref", ""),
                "base": pr.get("base", {}).get("ref", ""),
                "sha": pr.get("head", {}).get("sha", ""),
            }
        )
    return out


@workflows.activity()
async def pr_activity_since(created_at: str, repo: str, number: int, window_minutes: int) -> dict:
    """Decide whether the PR is fresh: created within the window, or has commits pushed within it."""
    since = datetime.now(timezone.utc) - timedelta(minutes=window_minutes)
    if created_at and _parse_github_time(created_at) >= since:
        return {"fresh": True, "reason": "created", "recent_commits": []}
    commits = (await _github_get(f"/repos/{repo}/pulls/{number}/commits?per_page=100")).json()
    recent = _recent_commit_summaries(commits, since)
    if recent:
        return {"fresh": True, "reason": "new_commits", "recent_commits": recent}
    return {"fresh": False, "reason": None, "recent_commits": []}


@workflows.activity()
async def pr_reviewed_at_sha(repo: str, number: int, sha: str) -> bool:
    """True if this worker already posted a review comment for the current head sha."""
    marker = REVIEW_MARKER.format(sha=sha)
    comments = (await _github_get(f"/repos/{repo}/issues/{number}/comments?per_page=100")).json()
    return any(marker in str(comment.get("body", "")) for comment in comments)


@workflows.activity()
async def fetch_pr_context(repo: str, number: int, max_diff_chars: int, recent_commits: list[dict]) -> dict:
    """Fetch PR metadata, changed files, CI check runs and the diff (truncated)."""
    pull = (await _github_get(f"/repos/{repo}/pulls/{number}")).json()
    files_response = await _github_get(f"/repos/{repo}/pulls/{number}/files?per_page=100")
    files = [
        {
            "filename": f.get("filename", ""),
            "status": f.get("status", ""),
            "additions": f.get("additions", 0),
            "deletions": f.get("deletions", 0),
        }
        for f in files_response.json()[:100]
    ]
    diff_response = await _github_get(
        f"/repos/{repo}/pulls/{number}", extra_headers={"Accept": "application/vnd.github.diff"}
    )
    diff = diff_response.text[:max_diff_chars]
    sha = pull.get("head", {}).get("sha", "")
    checks: list[dict] = []
    if sha:
        import httpx

        try:
            runs = (await _github_get(f"/repos/{repo}/commits/{sha}/check-runs?per_page=30")).json()
            checks = [
                {"name": r.get("name", ""), "conclusion": r.get("conclusion", "")}
                for r in runs.get("check_runs", [])[:30]
            ]
        except httpx.HTTPStatusError:
            checks = []
    return {
        "number": number,
        "title": pull.get("title", ""),
        "url": pull.get("html_url", ""),
        "body": pull.get("body", "") or "",
        "head": pull.get("head", {}).get("ref", ""),
        "base": pull.get("base", {}).get("ref", ""),
        "files": files,
        "diff": diff,
        "checks": checks,
        "recent_commits": recent_commits,
    }


@workflows.activity(start_to_close_timeout=timedelta(minutes=10))
async def generate_review(model: str, context: dict) -> str:
    """Ask the LLM to write the review. Uses the service-account token on managed deployments."""
    from mistralai import Mistral

    prompt = build_review_prompt(context)
    client = Mistral()
    response = await client.chat.complete_async(
        model=model,
        messages=[{"role": "user", "content": prompt}],
        max_tokens=4096,
        temperature=0.2,
    )
    content = response.choices[0].message.content
    if isinstance(content, list):
        content = "".join(part.get("text", "") for part in content if isinstance(part, dict))
    return content or "(empty review)"


@workflows.activity()
async def post_review_comment(repo: str, number: int, body: str, sha: str, dry_run: bool) -> dict:
    """Post the review as a PR comment (with a per-sha marker), or report what would be posted."""
    if dry_run:
        return {"posted": False, "dry_run": True, "body_chars": len(body), "url": None}
    import httpx

    marked_body = f"{REVIEW_MARKER.format(sha=sha)}\n\n{body}"
    async with httpx.AsyncClient(timeout=HTTP_TIMEOUT) as client:
        response = await client.post(
            f"{GITHUB_API}/repos/{repo}/issues/{number}/comments",
            headers=_headers({"Content-Type": "application/json"}),
            json={"body": marked_body},
        )
        response.raise_for_status()
        data = response.json()
        return {"posted": True, "dry_run": False, "body_chars": len(marked_body), "url": data.get("html_url")}
