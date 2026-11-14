# pr-review worker

A [Mistral Workflow](https://docs.mistral.ai/studio/workflows/overview) that reviews
open pull requests which are **new or received new commits within a time window**, and
posts the review as a plain PR comment (no approval is ever submitted). Used by
GitQuire to review PR activity every two hours.

## What it does

For each open PR in `repo` (default `docdru/GitQuire`, up to `max_prs`, most recently
updated first):

1. `list_open_prs` — list open PRs.
2. `pr_activity_since` — keep the PR only if it was created within `window_minutes`
   (default 120) or has commits pushed within that window; the recent commits are
   collected for the prompt.
3. `pr_reviewed_at_sha` — skip the PR if this worker already posted a review for the
   current head sha (a `<!-- gitquire-pr-review:<sha> -->` marker in a comment), so a
   new push triggers a fresh review but an unchanged head does not.
4. `fetch_pr_context` — PR metadata, changed files, CI check runs on the head commit,
   the recent commits, and the diff (truncated to `max_diff_chars`).
5. `generate_review` — an LLM (Mistral) writes a structured Markdown review
   (summary / verified / findings with severities / open topics / verdict) from the
   diff. The verdict states clearly either "open topics remain" or "this PR could be
   approved as is"; the review is posted as a comment only.
6. `post_review_comment` — posts it as a PR comment with the sha marker, unless
   `dry_run` is set.

Workflow input:

```json
{
  "repo": "docdru/GitQuire",
  "dry_run": false,
  "max_prs": 25,
  "window_minutes": 120,
  "model": "mistral-large-latest",
  "max_diff_chars": 120000
}
```

## Credentials

- The worker itself authenticates to Mistral with the deployment's service-account
  token (no API key in the repo).
- GitHub access comes from the `GITHUB_TOKEN` env var, read **inside the activities**
  so it never enters the workflow event history. On a managed deployment, bind the
  workspace secret `github_token` to `GITHUB_TOKEN` (a classic PAT with `repo` scope,
  or a fine-grained PAT with `pull-requests: write`, `issues: write`,
  `contents: read` on the target repo). Create the secret in Mistral Studio
  (Secrets); never commit its value.
- The LLM call uses the same service-account token (`MISTRAL_SA_TOKEN_PATH`); locally
  it falls back to `MISTRAL_API_KEY`.

## Run locally

```bash
python -m venv .venv && . .venv/bin/activate
pip install -e ".[dev]"
export MISTRAL_API_KEY=...   # for the LLM call
export GITHUB_TOKEN=...      # for GitHub
python -m pytest
python worker.py             # runs the worker (needs a Mistral workspace connection)
```

## Deploy and schedule

1. Push this directory's branch to GitHub and open a PR (done from the repo root;
   the project lives in `workflows/pr-review`).
2. Create a managed deployment from `docdru/GitQuire` at the pushed SHA with
   `build_directory = workflows/pr-review`, `dockerfile_path = Dockerfile`, and the
   `github_token` secret bound to `GITHUB_TOKEN`.
3. Run the workflow once with `{"dry_run": true}` to verify.
4. Create a schedule on workflow `pr-review` that runs every two hours, e.g.
   `intervals: [{ "every": "PT2H" }]` with input
   `{"repo": "docdru/GitQuire", "dry_run": false, "window_minutes": 120}`.
