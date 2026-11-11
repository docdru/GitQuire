"""Activities for the PR review worker.

All side effects (GitHub API, LLM) live here; the workflow itself only
orchestrates. The GitHub token is read from the environment inside the
activities so it never enters the workflow event history.
"""

from __future__ import annotations

import os
from datetime import timedelta

import mistralai.workflows as workflows

from .prompt import build_review_prompt

GITHUB_API = "https://api.github.com"
GITHUB_API_VERSION = "2022-11-28"
HTTP_TIMEOUT = 60.0


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


@workflows.activity()
async def list_open_prs(repo: str, max_prs: int) -> list[dict]:
    """List open pull requests, newest first."""
    response = await _github_get(f"/repos/{repo}/pulls?state=open&per_page=100&sort=created&direction=desc")
    prs = response.json()
    out = []
    for pr in prs[:max_prs]:
        out.append(
            {
                "number": pr["number"],
                "title": pr["title"],
                "url": pr["html_url"],
                "author": pr.get("user", {}).get("login", ""),
                "head": pr.get("head", {}).get("ref", ""),
                "base": pr.get("base", {}).get("ref", ""),
                "sha": pr.get("head", {}).get("sha", ""),
            }
        )
    return out


@workflows.activity()
async def pr_has_any_review_comments(repo: str, number: int) -> bool:
    """True if the PR already has any issue comment or review — i.e. it was looked at."""
    comments = await _github_get(f"/repos/{repo}/issues/{number}/comments?per_page=100")
    if len(comments.json()) > 0:
        return True
    reviews = await _github_get(f"/repos/{repo}/pulls/{number}/reviews?per_page=100")
    return len(reviews.json()) > 0


@workflows.activity()
async def fetch_pr_context(repo: str, number: int, max_diff_chars: int) -> dict:
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
async def post_review_comment(repo: str, number: int, body: str, dry_run: bool) -> dict:
    """Post the review as a PR comment, or report what would be posted in dry-run mode."""
    if dry_run:
        return {"posted": False, "dry_run": True, "body_chars": len(body), "url": None}
    import httpx

    async with httpx.AsyncClient(timeout=HTTP_TIMEOUT) as client:
        response = await client.post(
            f"{GITHUB_API}/repos/{repo}/issues/{number}/comments",
            headers=_headers({"Content-Type": "application/json"}),
            json={"body": body},
        )
        response.raise_for_status()
        data = response.json()
        return {"posted": True, "dry_run": False, "body_chars": len(body), "url": data.get("html_url")}
