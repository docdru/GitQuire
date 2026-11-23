import base64
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import forgejo_rows as f

PROXY = os.environ.get("PROXY_URL", "http://127.0.0.1:9000")


def put_file(repo, path, text):
    status, body, _ = f.call("POST", f"/repos/team/{repo}/contents/{path}", {
        "content": base64.b64encode(text.encode()).decode(), "message": f"Add {path}", "branch": "main",
    }, auth=f.ADMIN)
    if status not in (201, 422):
        raise RuntimeError(f"put {repo}/{path}: {status} {body}")


def main():
    for name in ("bob", "gitquire-bot"):
        f.make_user(name)
    f.call("POST", "/orgs", {"username": "team", "visibility": "private"}, auth=f.ADMIN)
    for repo, title in (("wiki", "Wiki A"), ("wiki-b", "Wiki B")):
        status, body, _ = f.call("POST", "/orgs/team/repos", {
            "name": repo, "private": True, "auto_init": True, "default_branch": "main",
        }, auth=f.ADMIN)
        if status not in (201, 409):
            raise RuntimeError(f"create {repo}: {status} {body}")
        put_file(repo, "index.md", f"# Index of {title}\n\nThe first line of {title}.\n")
        f.call("PUT", f"/repos/team/{repo}/collaborators/bob", {"permission": "write"}, auth=f.ADMIN)
        f.call("PUT", f"/repos/team/{repo}/collaborators/gitquire-bot", {"permission": "admin"}, auth=f.ADMIN)
    status, body = f.make_token("gitquire-bot", "gitquire", ["write:repository", "read:user", "read:organization"])
    if status != 201:
        raise RuntimeError(f"bot token: {status} {body}")
    uris = [f"{PROXY}/auth/github/callback", f"{PROXY}/w/team/wiki/auth/github/callback",
            f"{PROXY}/w/team/wiki-b/auth/github/callback", "http://127.0.0.1:8103/auth/github/callback"]
    status, app, _ = f.call("POST", "/user/applications/oauth2", {
        "name": "GitQuire", "redirect_uris": uris, "confidential_client": True,
    }, auth=f.ADMIN)
    if status != 201:
        raise RuntimeError(f"oauth app: {status} {app}")
    lines = [f"BOT_TOKEN={body['sha1']}", f"OAUTH_CLIENT_ID={app['client_id']}",
             f"OAUTH_CLIENT_SECRET={app['client_secret']}", f"BOB_PASSWORD={f.PASSWORD}"]
    with open(os.environ["GITHUB_ENV"], "a") as fh:
        fh.write("\n".join(lines) + "\n")
    print("::add-mask::" + body["sha1"])
    print("::add-mask::" + app["client_secret"])
    print("set-up done")


if __name__ == "__main__":
    main()
