# pr-review worker

A [Mistral Workflow](https://docs.mistral.ai/studio/workflows/overview) that reviews
open pull requests which have **no comments or reviews yet**, and posts the review as a
PR comment. Used by GitQuire to schedule a nightly review pass.

## What it does

For each open PR in `repo` (default `docdru/GitQuire`, up to `max_prs`):

1. `list_open_prs` — list open PRs.
2. `pr_has_any_review_comments` — skip the PR if it already has any issue comment or
   review (i.e. someone already looked at it).
3. `fetch_pr_context` — PR metadata, changed files, CI check runs on the head commit,
   and the diff (truncated to `max_diff_chars`).
4. `generate_review` — an LLM (Mistral) writes a structured Markdown review
   (summary / verified / findings with severities / verdict) from the diff.
5. `post_review_comment` — posts it as a PR comment, unless `dry_run` is set.

Workflow input:

```json
{
  "repo": "docdru/GitQuire",
  "dry_run": false,
  "max_prs": 10,
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
4. Create a schedule on workflow `pr-review` with the desired input, e.g. a one-shot
   calendar entry (`time_zone_name: Europe/Zurich`) with `max_executions: 1`.
