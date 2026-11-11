"""Prompt construction and payload truncation for the PR review worker."""

from __future__ import annotations

import json

MAX_CONTEXT_BODY_CHARS = 8_000
MAX_DIFF_CHARS = 120_000


def truncate(text: str, limit: int) -> str:
    if len(text) <= limit:
        return text
    return text[:limit] + f"\n... [truncated, {len(text) - limit} more characters]"


def build_review_prompt(context: dict) -> str:
    """Build the review prompt from a PR context dict produced by fetch_pr_context."""
    title = str(context.get("title", ""))
    url = str(context.get("url", ""))
    body = truncate(str(context.get("body", "")), MAX_CONTEXT_BODY_CHARS)
    head = str(context.get("head", ""))
    base = str(context.get("base", ""))
    diff = truncate(str(context.get("diff", "")), MAX_DIFF_CHARS)
    diff_truncated = len(str(context.get("diff", ""))) > MAX_DIFF_CHARS
    files = context.get("files", [])
    files_block = "\n".join(
        f"- {f.get('filename', '?')} ({f.get('status', '?')}, +{f.get('additions', 0)}/-{f.get('deletions', 0)})"
        for f in files[:50]
    )
    checks = context.get("checks", [])
    checks_block = (
        "\n".join(f"- {c.get('name', '?')}: {c.get('conclusion', '?')}" for c in checks[:30])
        if checks
        else "- (no check runs found)"
    )
    context_json = json.dumps(
        {
            "title": title,
            "url": url,
            "head": head,
            "base": base,
            "changed_files": len(files),
            "checks": checks[:30],
        },
        indent=2,
    )
    return f"""You are a senior software engineer performing a pull request review for the repository being reviewed.

PR: {title}
URL: {url}
Branch: {head} -> {base}

PR description:
\"\"\"
{body}
\"\"\"

Changed files:
{files_block}

CI checks on the head commit:
{checks_block}

PR metadata:
```json
{context_json}
```

Full diff (may be truncated: {diff_truncated}):
```diff
{diff}
```

Write the review as a single Markdown comment, structured exactly like this:

## Review: <PR title>

One-paragraph summary: what the PR changes, its size/scope, and CI state.

### What was verified
Bulleted list of the concrete claims you checked against the diff and code (with file:line references where possible).

### Findings
Numbered list. Each finding has a severity tag — **blocking**, **important**, or **nit** — a short title, and 1-3 sentences. Only report real issues; do not invent problems. If there are none, write "None."

### Verdict
One of: **Approve-able.** / **Request changes.** / **Needs discussion.** followed by one sentence.

Rules:
- Base every claim on the diff and PR description above; if the diff is truncated, say so in the summary and review only what is visible.
- Focus on correctness, security, and scope. Do not comment on formatting or style trivia.
- Be concise: the whole comment should stay under 120 lines.
- Do not ask the author to merge or to change CI settings; just review.
- Output only the Markdown comment, no preamble."""
