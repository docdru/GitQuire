import base64
import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import forgejo_rows as f

GQ = os.environ.get("GITQUIRE_URL", "http://127.0.0.1:8200").rstrip("/")
CONTAINER = os.environ.get("GITQUIRE_CONTAINER", "gq-h5")
FORGEJO_CONTAINER = os.environ.get("FORGEJO_CONTAINER", "forgejo")
CALLBACK = GQ + "/auth/forgejo/callback"
failures = []


def check(row, passed, detail):
    f.record(row, passed, detail)
    if passed is False:
        failures.append(f"{row}: {detail}")


def env_out(lines):
    with open(os.environ["GITHUB_ENV"], "a") as fh:
        fh.write("\n".join(lines) + "\n")


def setup():
    status, body, _ = f.call("GET", "/version")
    check("H5", status == 200, f"Forgejo over https with the test authority: GET /version -> {status} {body}")
    for name in ("alice", "bob", "dave", "gitquire-bot"):
        f.make_user(name)
    f.call("POST", "/orgs", {"username": "team", "visibility": "private"}, auth=f.ADMIN)
    status, body, _ = f.call("POST", "/orgs/team/repos", {
        "name": "wiki", "private": True, "auto_init": True, "default_branch": "main",
    }, auth=f.ADMIN)
    if status not in (201, 409):
        raise RuntimeError(f"create repo: {status} {body}")
    for user, perm in (("alice", "write"), ("bob", "write"), ("gitquire-bot", "write")):
        f.call("PUT", f"/repos/team/wiki/collaborators/{user}", {"permission": perm}, auth=f.ADMIN)
    status, unlimited = f.make_token("gitquire-bot", "gitquire-checks", ["read:repository", "read:user"])
    if status != 201:
        raise RuntimeError(f"unlimited token: {status} {unlimited}")
    status, limited = f.make_token("gitquire-bot", "gitquire-wiki", ["write:repository"],
                                   repositories=[{"owner": "team", "name": "wiki"}])
    if status != 201:
        raise RuntimeError(f"limited token: {status} {limited}")
    status, app, _ = f.call("POST", "/user/applications/oauth2", {
        "name": "GitQuire", "redirect_uris": [CALLBACK], "confidential_client": True,
    }, auth=f.ADMIN)
    if status != 201:
        raise RuntimeError(f"oauth app: {status} {app}")
    for secret in (unlimited["sha1"], limited["sha1"], app["client_secret"]):
        print("::add-mask::" + secret)
    env_out([f"BOT_TOKEN={unlimited['sha1']}", f"REPO_TOKEN={limited['sha1']}",
             f"OAUTH_CLIENT_ID={app['client_id']}", f"OAUTH_CLIENT_SECRET={app['client_secret']}"])
    print("set-up done: bot is a writer for now")


def make_bot_admin():
    status, _, _ = f.call("PUT", "/repos/team/wiki/collaborators/gitquire-bot", {"permission": "admin"}, auth=f.ADMIN)
    check("H5", status == 204, f"bot made repo admin -> {status}")


def gq(method, path, op, body=None, headers=None):
    url = GQ + path
    data = None
    hdrs = {"Accept": "application/json"}
    if headers:
        hdrs.update(headers)
    if body is not None:
        data = json.dumps(body).encode()
        hdrs["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, method=method, headers=hdrs)
    try:
        with op.open(req, timeout=60) as resp:
            return resp.status, f.parse(resp.read()), dict(resp.headers)
    except urllib.error.HTTPError as err:
        return err.code, f.parse(err.read()), dict(err.headers)


def sign_in(user):
    op = f.web_login(user)
    status, _, headers = f.get_html(op, GQ + "/auth/forgejo/login?next=%2F")
    location = headers.get("Location", "")
    if status != 302 or not location.startswith(f.BASE):
        return op, status, f"login answered {status} {location}"
    query = dict(urllib.parse.parse_qsl(urllib.parse.urlparse(location).query))
    if query.get("scope") != "read:user read:repository" or query.get("response_type") != "code":
        return op, 0, f"authorize parameters {query}"
    status, page, headers = f.get_html(op, location)
    if status == 200:
        grant = next((g for g in f.forms_of(page) if "grant" in g["action"]), None)
        if grant is None:
            return op, 0, "consent page without a grant form"
        fields = dict(grant["inputs"])
        fields["granted"] = "true"
        status, _, headers = f.post_form(op, f.BASE + "/login/oauth/grant", fields)
    callback = headers.get("Location", "")
    if not callback.startswith(CALLBACK):
        return op, 0, f"Forgejo did not send the browser back to GitQuire: {status} {callback}"
    status, page, headers = f.get_html(op, callback)
    return op, status, page if status != 302 else headers.get("Location", "")


def docker(*args, check_ok=True):
    proc = subprocess.run(["docker", *args], capture_output=True, text=True)
    if check_ok and proc.returncode != 0:
        raise RuntimeError(f"docker {' '.join(args)}: {proc.stderr}")
    return proc


def wait_ready(timeout=120):
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(GQ + "/readyz", timeout=5) as resp:
                if resp.status == 200:
                    return True
        except Exception:
            pass
        time.sleep(1)
    return False


def main_commits():
    status, body, _ = f.call("GET", "/repos/team/wiki/commits?sha=main&limit=20", auth=f.ADMIN)
    return body if status == 200 and isinstance(body, list) else []


def run_tests():
    logs = docker("logs", CONTAINER, check_ok=False).stdout + docker("logs", CONTAINER, check_ok=False).stderr
    check("H5 sync", "Cloned team/wiki" in logs or "Using the existing checkout" in logs,
          "gitquire-bootstrap cloned the repository with the limited token")

    alice, status, detail = sign_in("alice")
    check("H5 sign-in", status == 302, f"alice signs in through Forgejo -> {status} {detail if status != 302 else ''}")
    status, me, _ = gq("GET", "/auth/me", alice)
    alice_id = me.get("id") if isinstance(me, dict) else None
    check("H5 sign-in", status == 200 and isinstance(me, dict) and me.get("login") == "alice"
          and me.get("principalId") == f"forgejo-{alice_id}",
          f"/auth/me -> {status} login={me.get('login') if isinstance(me, dict) else me} principalId={me.get('principalId') if isinstance(me, dict) else ''}")
    check("H3", isinstance(me, dict) and me.get("email") == "alice@noreply.127.0.0.1",
          f"commit email {me.get('email') if isinstance(me, dict) else ''}")

    _, status, page = sign_in("dave")
    check("H5 sign-in", status == 403 and "does not have write access" in str(page)
          and "Sign in with Forgejo" in str(page),
          f"dave (no access) is refused -> {status}")

    marker = f"pulled-{int(time.time())}"
    status, _, _ = f.call("POST", "/repos/team/wiki/contents/pulled.md", {
        "content": base64.b64encode(f"# Pulled\n\n{marker}\n".encode()).decode(),
        "message": "Add pulled.md on Forgejo", "branch": "main",
    }, auth=f.ADMIN)
    pulled = False
    for _ in range(60):
        proc = docker("exec", CONTAINER, "cat", "/data/pulled.md", check_ok=False)
        if marker in proc.stdout:
            pulled = True
            break
        time.sleep(3)
    check("H5 sync", pulled, "a commit made on Forgejo reaches /data (pull)")

    message = f"Pushed from GitQuire {int(time.time())}"
    docker("exec", CONTAINER, "sh", "-c",
           f"cd /data && echo '{message}' >> pushed.md && git add pushed.md && git commit -q -m '{message}'")
    push = docker("exec", "-w", "/data", CONTAINER, "gitquire", "push", check_ok=False)
    pushed = False
    for _ in range(30):
        if any(c.get("commit", {}).get("message", "").startswith(message) for c in main_commits()):
            pushed = True
            break
        time.sleep(2)
    check("H5 sync", pushed, f"a commit made in /data reaches Forgejo (push, exit {push.returncode}: {(push.stdout + push.stderr).strip()[-200:]})")

    status, created, _ = gq("POST", "/api/gitquire/drafts", alice, {"title": "H5 draft", "open": False})
    draft = created.get("draft", {}) if isinstance(created, dict) else {}
    slug = draft.get("slug")
    check("H5 drafts", status == 201 and slug is not None, f"create a draft -> {status} {created}")
    status, branches, _ = f.call("GET", "/repos/team/wiki/branches", auth=f.ADMIN)
    names = [b["name"] for b in branches] if isinstance(branches, list) else []
    branch = draft.get("branch") or next((n for n in names if slug and slug in n), None)
    check("H5 drafts", branch in names, f"the draft branch is on Forgejo: {branch} in {names}")
    if branch:
        f.call("POST", "/repos/team/wiki/contents/draft-page.md", {
            "content": base64.b64encode(b"# From the draft\n").decode(),
            "message": "Edit in the draft", "branch": branch,
        }, auth=f.ADMIN)
    status, published, _ = gq("POST", f"/api/gitquire/drafts/{slug}/publish", alice, {})
    state = published.get("draft", {}).get("status") if isinstance(published, dict) else None
    check("H5 drafts", status == 200 and state == "published", f"publish (squash merge) -> {status} {state} {published if status != 200 else ''}")
    status, pulls, _ = f.call("GET", "/repos/team/wiki/pulls?state=closed", auth=f.ADMIN)
    merged = [p for p in pulls if p.get("title") == "H5 draft" and p.get("merged")] if isinstance(pulls, list) else []
    check("H5 drafts", len(merged) == 1, f"publishing opened a pull request on Forgejo and merged it: {[(p.get('number'), p.get('head', {}).get('ref'), p.get('merged')) for p in pulls] if isinstance(pulls, list) else pulls}")
    titles = [c.get("commit", {}).get("message", "") for c in main_commits()]
    check("H5 drafts", any(t.startswith("H5 draft (#") for t in titles), f"main has the squash commit with the draft's title: {titles[:3]}")
    status, _, _ = f.call("GET", f"/repos/team/wiki/branches/{branch}", auth=f.ADMIN)
    check("H5 drafts", status == 404, f"the draft branch is deleted after publishing -> {status}")

    bob, status, _ = sign_in("bob")
    _, page, _ = f.get_html(bob, GQ + "/auth/agents")
    form = next((g for g in f.forms_of(page) if g["action"] == "/auth/agents"), None)
    status, page, _ = f.post_form(bob, GQ + "/auth/agents", {"label": "h5"})
    match = re.search(r"Your new token\..*?<pre>([^<]+)</pre>", page, re.S)
    token = match.group(1).strip() if match else None
    check("H5 access", form is not None and token is not None, f"bob creates an agent token -> {status}")
    mcp_body = {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
        "protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "h5", "version": "1"}}}
    mcp_headers = {"Authorization": f"Bearer {token}", "Accept": "application/json, text/event-stream"}
    status, _, _ = gq("POST", "/mcp", f.browser(), mcp_body, mcp_headers)
    check("H5 access", status != 401, f"the token reaches /mcp while bob has access -> {status}")
    status, _, _ = f.call("DELETE", "/repos/team/wiki/collaborators/bob", auth=f.ADMIN)
    check("H5 access", status == 204, f"bob removed from the repository -> {status}")
    docker("restart", CONTAINER)
    check("H5 access", wait_ready(), "GitQuire restarted (the access re-check runs at start)")
    revoked = False
    for _ in range(20):
        status, _, _ = gq("POST", "/mcp", f.browser(), mcp_body, mcp_headers)
        if status == 401:
            revoked = True
            break
        time.sleep(2)
    check("H5 access", revoked, "bob's agent token is revoked after the re-check with the bot's unlimited token (R9, R15)")
    _, status, _ = sign_in("bob")
    check("H5 access", status == 403, f"bob can no longer sign in -> {status}")

    docker("stop", FORGEJO_CONTAINER)
    status, me, _ = gq("GET", "/auth/me", alice)
    check("H5 host down", status == 200, f"alice stays signed in while Forgejo is down (R14) -> {status}")
    try:
        with urllib.request.urlopen(GQ + "/readyz", timeout=10) as resp:
            ready = resp.status
    except Exception as err:
        ready = str(err)
    check("H5 host down", ready == 200, f"GitQuire stays ready while Forgejo is down -> {ready}")
    docker("start", FORGEJO_CONTAINER)

    container_env = docker("exec", CONTAINER, "sh", "-c",
                           "for p in $(pgrep -f 'gitquire.*start'); do tr '\\0' '\\n' < /proc/$p/environ | grep -c '^GITQUIRE_HOST_TOKEN=' ; done",
                           check_ok=False).stdout.split()
    check("H5 R12", None, f"processes holding GITQUIRE_HOST_TOKEN (main process only expected): {container_env}")


def door_setup():
    repos = {}
    for name, bot in (("notes", "admin"), ("writer", "write"), ("hidden", None)):
        status, body, _ = f.call("POST", "/orgs/team/repos", {
            "name": name, "private": True, "auto_init": True, "default_branch": "main",
        }, auth=f.ADMIN)
        if status not in (201, 409):
            raise RuntimeError(f"create team/{name}: {status} {body}")
        f.call("PUT", f"/repos/team/{name}/collaborators/alice", {"permission": "admin"}, auth=f.ADMIN)
        if bot:
            f.call("PUT", f"/repos/team/{name}/collaborators/gitquire-bot", {"permission": bot}, auth=f.ADMIN)
        _, record, _ = f.call("GET", f"/repos/team/{name}", auth=f.ADMIN)
        repos[name] = {"host": "forgejo", "id": record["id"], "owner": record["owner"]["login"],
                       "ownerId": record["owner"]["id"], "name": record["name"]}
    status, _, _ = f.call("PATCH", "/repos/team/writer", {"name": "writer2"}, auth=f.ADMIN)
    if status != 200:
        raise RuntimeError(f"rename team/writer: {status}")
    made = [
        f.make_token("alice", "door-person", ["read:user", "read:repository"]),
        f.make_token("gitquire-bot", "door-notes", ["write:repository"],
                     repositories=[{"owner": "team", "name": "notes"}]),
        f.make_token("gitquire-bot", "door-revoked", ["read:user", "read:repository"]),
    ]
    for status, body in made:
        if status != 201:
            raise RuntimeError(f"door token: {status} {body}")
    person, limited, revoked = (body for _, body in made)
    status, _, _ = f.call("DELETE", "/users/gitquire-bot/tokens/door-revoked", auth=("gitquire-bot", f.PASSWORD))
    if status != 204:
        raise RuntimeError(f"revoke token: {status}")
    for secret in (person["sha1"], limited["sha1"], revoked["sha1"]):
        print("::add-mask::" + secret)
    env_out([f"DOOR_PERSON_TOKEN={person['sha1']}", f"DOOR_NOTES_TOKEN={limited['sha1']}",
             f"DOOR_REVOKED_TOKEN={revoked['sha1']}", f"DOOR_REPOS={json.dumps(repos)}"])
    print("door set-up done:", json.dumps(repos))


def start_check():
    out = os.environ.get("START_CHECK_OUTPUT", "")
    code = os.environ.get("START_CHECK_EXIT", "")
    check("R17", code == "78" and "must be an administrator" in out,
          f"start with the bot as writer stops with exit {code}: {out.strip().splitlines()[-1] if out.strip() else ''}")


def summary():
    print("\n===== H5 summary =====")
    for row, results in f.rows.items():
        marks = ["PASS" if p else ("INFO" if p is None else "FAIL") for p, _ in results]
        print(f"{row}: {', '.join(marks)}")
    if failures:
        print("\nFailures:\n- " + "\n- ".join(failures))
        sys.exit(1)


if __name__ == "__main__":
    step = sys.argv[1]
    if step == "setup":
        setup()
    elif step == "door":
        door_setup()
    elif step == "admin":
        start_check()
        make_bot_admin()
        summary()
    elif step == "test":
        run_tests()
        summary()
