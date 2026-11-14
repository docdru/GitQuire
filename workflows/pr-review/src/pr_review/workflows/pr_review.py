"""PR review workflow: review open PRs that are new or got new commits within the window."""

from __future__ import annotations

import mistralai.workflows as workflows
from pydantic import BaseModel, Field

from .. import activities


class PrReviewInput(BaseModel):
    repo: str = "docdru/GitQuire"
    dry_run: bool = False
    max_prs: int = Field(default=25, ge=1, le=100)
    window_minutes: int = Field(default=120, ge=5, le=43200)
    model: str = "mistral-large-latest"
    max_diff_chars: int = Field(default=120_000, ge=10_000, le=500_000)


class ReviewedPr(BaseModel):
    number: int
    title: str
    url: str
    reason: str
    posted: bool
    comment_url: str | None


class PrReviewOutput(BaseModel):
    repo: str
    dry_run: bool
    window_minutes: int
    reviewed: list[ReviewedPr]
    skipped_stale: list[int]
    skipped_already_reviewed: list[int]


@workflows.workflow.define(
    name="pr-review",
    workflow_display_name="PR Review",
    workflow_description=(
        "Lists open pull requests of a repo, picks those created within window_minutes or "
        "with commits pushed within window_minutes, skips ones already reviewed at the "
        "current head sha, reviews the rest with an LLM against the diff, and posts the "
        "review as a PR comment (unless dry_run). No approval is submitted; the comment "
        "states open topics or that the PR could be approved as is."
    ),
)
class PrReviewWorkflow:
    @workflows.workflow.entrypoint
    async def run(self, input: PrReviewInput) -> PrReviewOutput:
        prs = await activities.list_open_prs(input.repo, input.max_prs)
        reviewed: list[ReviewedPr] = []
        skipped_stale: list[int] = []
        skipped_already_reviewed: list[int] = []
        for pr in prs:
            number = int(pr["number"])
            sha = str(pr.get("sha", ""))
            fresh = await activities.pr_activity_since(
                str(pr.get("created_at", "")), input.repo, number, input.window_minutes
            )
            if not fresh.get("fresh"):
                skipped_stale.append(number)
                continue
            if await activities.pr_reviewed_at_sha(input.repo, number, sha):
                skipped_already_reviewed.append(number)
                continue
            context = await activities.fetch_pr_context(
                input.repo, number, input.max_diff_chars, fresh.get("recent_commits", [])
            )
            review = await activities.generate_review(input.model, context)
            result = await activities.post_review_comment(input.repo, number, review, sha, input.dry_run)
            reviewed.append(
                ReviewedPr(
                    number=number,
                    title=str(pr.get("title", "")),
                    url=str(pr.get("url", "")),
                    reason=str(fresh.get("reason") or ""),
                    posted=bool(result.get("posted")),
                    comment_url=result.get("url"),
                )
            )
        return PrReviewOutput(
            repo=input.repo,
            dry_run=input.dry_run,
            window_minutes=input.window_minutes,
            reviewed=reviewed,
            skipped_stale=skipped_stale,
            skipped_already_reviewed=skipped_already_reviewed,
        )
