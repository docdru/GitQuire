"""Tests for the pr-review worker: prompt helpers plus a full workflow run with fake activities."""

from __future__ import annotations

import uuid

import mistralai.workflows as workflows
from temporalio.testing import WorkflowEnvironment

from mistralai.workflows.testing import create_test_worker

from pr_review.prompt import build_review_prompt, truncate
from pr_review.workflows.pr_review import PrReviewWorkflow

# The SDK fixtures set config.worker.deployment_name = "test-task-queue", which makes
# activities schedule onto this queue; the test worker and the workflow start must match.
TEST_QUEUE = "test-task-queue"

POSTED_BODIES: list[tuple[int, str]] = []


async def run_workflow(env: WorkflowEnvironment, input_data: dict) -> dict:
    async with create_test_worker(env, [PrReviewWorkflow], activities=FAKE_ACTIVITIES):
        handle = await env.client.start_workflow(
            "pr-review",
            input_data,
            id=f"test-pr-review-{uuid.uuid4()}",
            task_queue=TEST_QUEUE,
        )
        return await handle.result()


def test_truncate_keeps_short_text():
    assert truncate("hello", 10) == "hello"


def test_truncate_marks_long_text():
    out = truncate("x" * 100, 10)
    assert out.startswith("x" * 10)
    assert "truncated" in out and "90 more" in out


def test_build_review_prompt_contains_key_sections():
    prompt = build_review_prompt(
        {
            "title": "Add thing",
            "url": "https://example/pr/1",
            "body": "does a thing",
            "head": "feature",
            "base": "main",
            "files": [{"filename": "a.ts", "status": "modified", "additions": 3, "deletions": 1}],
            "diff": "diff --git a/a.ts b/a.ts\n+code",
            "checks": [{"name": "build", "conclusion": "SUCCESS"}],
            "recent_commits": [],
        }
    )
    assert "Add thing" in prompt
    assert "diff --git" in prompt
    assert "build: SUCCESS" in prompt
    assert "## Review:" in prompt
    assert "### Open topics" in prompt
    assert "could be approved as is" in prompt
    assert "no approval is submitted" in prompt


def test_build_review_prompt_lists_recent_commits():
    prompt = build_review_prompt(
        {
            "title": "Add thing",
            "url": "https://example/pr/1",
            "body": "",
            "head": "feature",
            "base": "main",
            "files": [],
            "diff": "diff --git a/a.ts b/a.ts\n+code",
            "checks": [],
            "recent_commits": [{"sha": "abc1234", "message": "fix crash", "date": "2024-05-01T10:00:00Z"}],
        }
    )
    assert "abc1234 fix crash" in prompt


@workflows.activity()
async def list_open_prs(repo: str, max_prs: int) -> list[dict]:
    return [
        {"number": 101, "title": "New PR", "url": "https://example/pull/101", "author": "alice", "created_at": "2999-01-01T00:00:00Z", "updated_at": "2999-01-01T00:00:00Z", "head": "f", "base": "main", "sha": "aaa111"},
        {"number": 102, "title": "Stale PR", "url": "https://example/pull/102", "author": "bob", "created_at": "2000-01-01T00:00:00Z", "updated_at": "2000-01-01T00:00:00Z", "head": "g", "base": "main", "sha": "bbb222"},
        {"number": 103, "title": "Re-pushed PR", "url": "https://example/pull/103", "author": "carol", "created_at": "2000-01-01T00:00:00Z", "updated_at": "2999-01-01T00:00:00Z", "head": "h", "base": "main", "sha": "ccc333"},
        {"number": 104, "title": "Re-reviewed PR", "url": "https://example/pull/104", "author": "dave", "created_at": "2000-01-01T00:00:00Z", "updated_at": "2999-01-01T00:00:00Z", "head": "i", "base": "main", "sha": "ddd444"},
    ]


@workflows.activity()
async def pr_activity_since(created_at: str, repo: str, number: int, window_minutes: int) -> dict:
    if number == 101:
        return {"fresh": True, "reason": "created", "recent_commits": []}
    if number == 102:
        return {"fresh": False, "reason": None, "recent_commits": []}
    return {
        "fresh": True,
        "reason": "new_commits",
        "recent_commits": [{"sha": "ccc333", "message": "add fix", "date": "2999-01-01T00:00:00Z"}],
    }


@workflows.activity()
async def pr_reviewed_at_sha(repo: str, number: int, sha: str) -> bool:
    return number == 104


@workflows.activity()
async def fetch_pr_context(repo: str, number: int, max_diff_chars: int, recent_commits: list[dict]) -> dict:
    return {
        "number": number,
        "title": "PR",
        "url": f"https://example/pull/{number}",
        "body": "body",
        "head": "f",
        "base": "main",
        "files": [{"filename": "a.ts", "status": "added", "additions": 1, "deletions": 0}],
        "diff": "diff --git a/a.ts b/a.ts\n+1",
        "checks": [{"name": "build", "conclusion": "SUCCESS"}],
        "recent_commits": recent_commits,
    }


@workflows.activity()
async def generate_review(model: str, context: dict) -> str:
    return f"## Review: {context['title']}\n\n### Open topics\nNone.\n\n### Verdict\n**No open topics — this PR could be approved as is.**"


@workflows.activity()
async def post_review_comment(repo: str, number: int, body: str, sha: str, dry_run: bool) -> dict:
    if not dry_run:
        POSTED_BODIES.append((number, f"<!-- gitquire-pr-review:{sha} -->\n\n{body}"))
        return {"posted": True, "dry_run": False, "body_chars": len(body), "url": f"https://example/pull/{number}#issuecomment-1"}
    return {"posted": False, "dry_run": True, "body_chars": len(body), "url": None}


FAKE_ACTIVITIES = [
    list_open_prs,
    pr_activity_since,
    pr_reviewed_at_sha,
    fetch_pr_context,
    generate_review,
    post_review_comment,
]


async def test_workflow_reviews_only_fresh_unreviewed_prs(temporal_env):
    result = await run_workflow(temporal_env, {"repo": "docdru/GitQuire", "dry_run": True, "window_minutes": 120})
    reviewed = result["reviewed"]
    assert [r["number"] for r in reviewed] == [101, 103]
    assert reviewed[0]["reason"] == "created"
    assert reviewed[1]["reason"] == "new_commits"
    assert all(r["posted"] is False for r in reviewed)
    assert all(r["comment_url"] is None for r in reviewed)
    assert result["skipped_stale"] == [102]
    assert result["skipped_already_reviewed"] == [104]
    assert result["window_minutes"] == 120
    assert result["dry_run"] is True


async def test_workflow_posts_comment_with_sha_marker_when_not_dry_run(temporal_env):
    POSTED_BODIES.clear()
    result = await run_workflow(temporal_env, {"repo": "docdru/GitQuire", "dry_run": False, "window_minutes": 120})
    reviewed = result["reviewed"]
    assert [r["number"] for r in reviewed] == [101, 103]
    assert all(r["posted"] is True for r in reviewed)
    assert reviewed[0]["comment_url"].endswith("#issuecomment-1")
    posted_numbers = [number for number, _ in POSTED_BODIES]
    assert posted_numbers == [101, 103]
    assert "<!-- gitquire-pr-review:aaa111 -->" in POSTED_BODIES[0][1]
    assert "could be approved as is" in POSTED_BODIES[0][1]
