import asyncio

import mistralai.workflows as workflows

WORKFLOW_PACKAGE = "pr_review.workflows"


def main() -> None:
    workflow_classes = workflows.discover_all_workflows_in_package(WORKFLOW_PACKAGE)
    asyncio.run(workflows.run_worker(workflow_classes))


if __name__ == "__main__":
    main()
