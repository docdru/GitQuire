"""PR review workflow: review open PRs that have no comments yet."""

from __future__ import annotations

import mistralai.workflows as workflows
from pydantic import BaseModel, Field

from .. import activities


class PrReviewInput(BaseModel):
    repo: str = "docdru/GitQuire"
    dry_run: bool = False
    max_prs: int = Field(default=10, ge=1, le=50)
    model: str = "mistral-large-latest"
    max_diff_chars: int = Field(default=120_000, ge=10_000, le=500_000)


class ReviewedPr(BaseModel):
    number: int
    title: str
    url: str
    posted: bool
    comment_url: str | None


class PrReviewOutput(BaseModel):
    repo: str
    dry_run: bool
    reviewed: list[ReviewedPr]
    skipped_already_commented: list[int]


@workflows.workflow.define(
    name="pr-review",
    workflow_display_name="PR Review",
    workflow_description=(
        "Lists open pull requests of a repo, skips any that already have comments or "
        "reviews, reviews the rest with an LLM against the diff, and posts the review "
        "as a PR comment (unless dry_run)."
    ),
)
class PrReviewWorkflow:
    @workflows.workflow.entrypoint
    async def run(self, input: PrReviewInput) -> PrReviewOutput:
        prs = await activities.list_open_prs(input.repo, input.max_prs)
        reviewed: list[ReviewedPr] = []
        skipped: list[int] = []
        for pr in prs:
            number = int(pr["number"])
            already = await activities.pr_has_any_review_comments(input.repo, number)
            if already:
                skipped.append(number)
                continue
            context = await activities.fetch_pr_context(input.repo, number, input.max_diff_chars)
            review = await activities.generate_review(input.model, context)
            result = await activities.post_review_comment(input.repo, number, review, input.dry_run)
            reviewed.append(
                ReviewedPr(
                    number=number,
                    title=str(pr.get("title", "")),
                    url=str(pr.get("url", "")),
                    posted=bool(result.get("posted")),
                    comment_url=result.get("url"),
                )
            )
        return PrReviewOutput(
            repo=input.repo,
            dry_run=input.dry_run,
            reviewed=reviewed,
            skipped_already_commented=skipped,
        )
