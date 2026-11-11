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
        }
    )
    assert "Add thing" in prompt
    assert "diff --git" in prompt
    assert "build: SUCCESS" in prompt
    assert "## Review:" in prompt
    assert "Verdict" in prompt


@workflows.activity()
async def list_open_prs(repo: str, max_prs: int) -> list[dict]:
    return [
        {"number": 101, "title": "New PR", "url": "https://example/pull/101", "author": "alice", "head": "f", "base": "main", "sha": "abc"},
        {"number": 102, "title": "Commented PR", "url": "https://example/pull/102", "author": "bob", "head": "g", "base": "main", "sha": "def"},
    ]


@workflows.activity()
async def pr_has_any_review_comments(repo: str, number: int) -> bool:
    return number == 102


@workflows.activity()
async def fetch_pr_context(repo: str, number: int, max_diff_chars: int) -> dict:
    return {
        "number": number,
        "title": "New PR",
        "url": f"https://example/pull/{number}",
        "body": "body",
        "head": "f",
        "base": "main",
        "files": [{"filename": "a.ts", "status": "added", "additions": 1, "deletions": 0}],
        "diff": "diff --git a/a.ts b/a.ts\n+1",
        "checks": [{"name": "build", "conclusion": "SUCCESS"}],
    }


@workflows.activity()
async def generate_review(model: str, context: dict) -> str:
    return f"## Review: {context['title']}\n\nVerdict: approve."


@workflows.activity()
async def post_review_comment(repo: str, number: int, body: str, dry_run: bool) -> dict:
    return {"posted": not dry_run, "dry_run": dry_run, "body_chars": len(body), "url": f"https://example/pull/{number}#issuecomment-1" if not dry_run else None}


FAKE_ACTIVITIES = [
    list_open_prs,
    pr_has_any_review_comments,
    fetch_pr_context,
    generate_review,
    post_review_comment,
]


async def test_workflow_reviews_only_uncommented_prs(temporal_env):
    result = await run_workflow(temporal_env, {"repo": "docdru/GitQuire", "dry_run": True})
    reviewed = result["reviewed"]
    skipped = result["skipped_already_commented"]
    assert [r["number"] for r in reviewed] == [101]
    assert reviewed[0]["posted"] is False  # dry run
    assert reviewed[0]["comment_url"] is None
    assert skipped == [102]
    assert result["dry_run"] is True


async def test_workflow_posts_when_not_dry_run(temporal_env):
    result = await run_workflow(temporal_env, {"repo": "docdru/GitQuire", "dry_run": False})
    reviewed = result["reviewed"]
    assert [r["number"] for r in reviewed] == [101]
    assert reviewed[0]["posted"] is True
    assert reviewed[0]["comment_url"].endswith("#issuecomment-1")
