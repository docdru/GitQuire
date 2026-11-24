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
    closed = [p for p in pulls if p.get("title") == "H5 draft"] if isinstance(pulls, list) else []
    check("H5 drafts", len(closed) == 1, f"publishing opened a pull request on Forgejo and closed it: {[(p.get('number'), p.get('head', {}).get('ref'), p.get('merged')) for p in pulls] if isinstance(pulls, list) else pulls}")
    squash = next((c.get("commit", {}) for c in main_commits()
                   if c.get("commit", {}).get("message", "").startswith("H5 draft (#")), {})
    message = squash.get("message", "")
    author = squash.get("author", {})
    check("H5 drafts", squash != {}, f"main has the squash commit with the draft's title: {message[:60]!r}")
    check("H5 drafts", author.get("email", "").startswith("alice@") and "Co-authored-by: " in message,
          f"the squash commit is alice's, the draft's other author is a co-author: {author.get('name')} <{author.get('email')}>, {message!r}")
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


WIKIS = os.environ.get("WIKIS_URL", "http://127.0.0.1:8300").rstrip("/")
WIKIS_CONTAINER = os.environ.get("WIKIS_CONTAINER", "gq-wikis")


def wikis_setup():
    for name in ("alpha", "beta"):
        status, body, _ = f.call("POST", "/orgs/team/repos", {
            "name": name, "private": True, "auto_init": True, "default_branch": "main",
        }, auth=f.ADMIN)
        if status not in (201, 409):
            raise RuntimeError(f"create team/{name}: {status} {body}")
        f.call("PUT", f"/repos/team/{name}/collaborators/alice", {"permission": "admin"}, auth=f.ADMIN)
        f.call("PUT", f"/repos/team/{name}/collaborators/gitquire-bot", {"permission": "admin"}, auth=f.ADMIN)
    f.call("PUT", "/repos/team/alpha/collaborators/dave", {"permission": "write"}, auth=f.ADMIN)
    status, body, _ = f.call("POST", "/user/repos", {
        "name": "journal", "private": True, "auto_init": True, "default_branch": "main",
    }, auth=("alice", f.PASSWORD))
    if status not in (201, 409):
        raise RuntimeError(f"create alice/journal: {status} {body}")
    f.call("PUT", "/repos/alice/journal/collaborators/gitquire-bot", {"permission": "admin"}, auth=f.ADMIN)
    tokens = {}
    for name in ("alpha", "beta"):
        status, body = f.make_token("gitquire-bot", f"wiki-{name}", ["write:repository"],
                                    repositories=[{"owner": "team", "name": name}])
        if status != 201:
            raise RuntimeError(f"limited token for {name}: {status} {body}")
        tokens[name] = body["sha1"]
    status, app, _ = f.call("POST", "/user/applications/oauth2", {
        "name": "GitQuire wikis", "redirect_uris": [WIKIS + "/auth/forgejo/callback"], "confidential_client": True,
    }, auth=f.ADMIN)
    if status != 201:
        raise RuntimeError(f"oauth app: {status} {app}")
    status, other = f.make_token("alice", "not-the-bot", ["write:repository", "read:user"])
    if status != 201:
        raise RuntimeError(f"alice's token: {status} {other}")
    tokens["alice"] = other["sha1"]
    status, wide = f.make_token("gitquire-bot", "bot-unlimited-2", ["write:repository", "read:user"])
    if status != 201:
        raise RuntimeError(f"second bot token: {status} {wide}")
    tokens["wide"] = wide["sha1"]
    for secret in (*tokens.values(), app["client_secret"]):
        print("::add-mask::" + secret)
    env_out([f"ALPHA_TOKEN={tokens['alpha']}", f"BETA_TOKEN={tokens['beta']}",
             f"ALICE_TOKEN={tokens['alice']}", f"WIDE_TOKEN={tokens['wide']}",
             f"WIKIS_CLIENT_ID={app['client_id']}", f"WIKIS_CLIENT_SECRET={app['client_secret']}"])
    print("two-wiki set-up done")


def door_call(method, path, op, body=None, accept="application/json"):
    data = None
    hdrs = {"Accept": accept, "Origin": WIKIS}
    if body is not None:
        data = json.dumps(body).encode()
        hdrs["Content-Type"] = "application/json"
    req = urllib.request.Request(WIKIS + path, data=data, method=method, headers=hdrs)
    try:
        with op.open(req, timeout=180) as resp:
            return resp.status, f.parse(resp.read()), dict(resp.headers)
    except urllib.error.HTTPError as err:
        return err.code, f.parse(err.read()), dict(err.headers)


def door_round(op, start):
    status, _, headers = f.get_html(op, WIKIS + start)
    location = headers.get("Location", "")
    if status != 302 or not location.startswith(f.BASE):
        return status, f"start answered {status} {location}"
    status, page, headers = f.get_html(op, location)
    if status == 200:
        grant = next((g for g in f.forms_of(page) if "grant" in g["action"]), None)
        if grant is None:
            return 0, "consent page without a grant form"
        fields = dict(grant["inputs"])
        fields["granted"] = "true"
        status, _, headers = f.post_form(op, f.BASE + "/login/oauth/grant", fields)
    callback = headers.get("Location", "")
    if not callback.startswith(WIKIS + "/auth/forgejo/callback"):
        return 0, f"Forgejo did not send the browser back to the front door: {status} {callback}"
    status, _, headers = f.get_html(op, callback)
    return status, headers.get("Location", "")


def agent_token(op, label):
    req = urllib.request.Request(WIKIS + "/auth/agents", method="POST",
                                 data=urllib.parse.urlencode({"label": label}).encode(),
                                 headers={"Content-Type": "application/x-www-form-urlencoded",
                                          "Accept": "text/html", "Origin": WIKIS})
    try:
        with op.open(req, timeout=60) as resp:
            status, page = resp.status, resp.read().decode(errors="replace")
    except urllib.error.HTTPError as err:
        status, page = err.code, err.read().decode(errors="replace")
    match = re.search(r"gqa_[0-9a-f]{16}_[A-Za-z0-9_-]{32,}", page)
    return status, match.group(0) if match else None


class Mcp:
    def __init__(self, token):
        self.token = token
        self.session = None
        self.next_id = 0

    def post(self, message):
        hdrs = {"Authorization": f"Bearer {self.token}", "Content-Type": "application/json",
                "Accept": "application/json, text/event-stream"}
        if self.session:
            hdrs["Mcp-Session-Id"] = self.session
        req = urllib.request.Request(WIKIS + "/mcp", data=json.dumps(message).encode(),
                                     method="POST", headers=hdrs)
        try:
            with urllib.request.urlopen(req, timeout=180) as resp:
                self.session = resp.headers.get("Mcp-Session-Id") or self.session
                return resp.status, f.parse(resp.read())
        except urllib.error.HTTPError as err:
            return err.code, f.parse(err.read())

    def request(self, method, params=None):
        self.next_id += 1
        status, body = self.post({"jsonrpc": "2.0", "id": self.next_id, "method": method,
                                  "params": params or {}})
        return status, body.get("result") if isinstance(body, dict) else None

    def start(self):
        status, result = self.request("initialize", {
            "protocolVersion": "2025-06-18", "capabilities": {},
            "clientInfo": {"name": "h5-agent", "version": "1"}})
        self.post({"jsonrpc": "2.0", "method": "notifications/initialized"})
        return status, result

    def call(self, name, args):
        return self.request("tools/call", {"name": name, "arguments": args})


def result_text(result):
    if not isinstance(result, dict):
        return ""
    return "\n".join(p.get("text", "") for p in result.get("content", []) if isinstance(p, dict))


def wikis_mcp(alice, dave):
    status, token = agent_token(alice, "h5 agent")
    check("Wikis MCP", status == 200 and token is not None,
          f"alice creates an agent token at /auth/agents on the front door -> {status}")
    status, me, _ = door_call("GET", "/w/forgejo/team/alpha/auth/me", alice)
    features = me.get("features", {}) if isinstance(me, dict) else {}
    check("Wikis MCP", features.get("canUseTokens") is True and features.get("agentToken") is True,
          f"inside a wiki, /auth/me shows the front door's agent access -> {features}")
    status, body, _ = door_call("GET", "/w/forgejo/team/alpha/mcp", alice)
    check("Wikis MCP", status == 404 and isinstance(body, dict) and body.get("mcp") == WIKIS + "/mcp",
          f"/mcp under a wiki address names the one /mcp address -> {status} {body}")
    unsigned = urllib.request.Request(WIKIS + "/mcp", method="POST", data=b"{}",
                                      headers={"Content-Type": "application/json"})
    try:
        urllib.request.urlopen(unsigned, timeout=30)
        code = 200
    except urllib.error.HTTPError as err:
        code = err.code
    check("Wikis MCP", code == 401, f"/mcp without a token -> {code}")
    if token is None:
        return
    agent = Mcp(token)
    status, init = agent.start()
    check("Wikis MCP", status == 200 and agent.session is not None,
          f"initialize at the root /mcp -> {status} {init.get('serverInfo') if isinstance(init, dict) else init}")
    status, listed = agent.request("tools/list")
    tools = {t["name"]: t for t in listed.get("tools", [])} if isinstance(listed, dict) else {}
    execute = tools.get("exec", {}).get("inputSchema", {})
    check("Wikis MCP", "list_wikis" in tools and "wiki" in execute.get("properties", {})
          and "wiki" in execute.get("required", []),
          f"tools: list_wikis plus the wiki's tools, each with a wiki argument -> {sorted(tools)[:8]}")
    status, wikis = agent.call("list_wikis", {})
    names = [w.get("wiki") for w in (wikis or {}).get("structuredContent", {}).get("wikis", [])]
    check("Wikis MCP", names == ["forgejo/team/alpha", "forgejo/team/beta"], f"list_wikis for alice names the wikis with their host -> {names}")
    for name, other in (("alpha", "beta"), ("beta", "alpha")):
        status, result = agent.call("exec", {"wiki": f"team/{name}", "command": "cat README.md"})
        text = result_text(result)
        check("Wikis MCP", status == 200 and isinstance(result, dict) and not result.get("isError")
              and f"# {name}" in text and f"# {other}" not in text,
              f"exec cat README.md in team/{name} reads that wiki -> {status} {text[:160]}")
    status, wrote = agent.call("write", {"wiki": "team/alpha", "document": {
        "path": "agent-note", "content": "# Agent note\n\nWritten by alice's agent.\n"}})
    check("Wikis MCP", status == 200 and isinstance(wrote, dict) and not wrote.get("isError"),
          f"alice's agent writes agent-note in team/alpha -> {status} {result_text(wrote)[:160]}")
    author = None
    for _ in range(36):
        _, commits, _ = f.call("GET", "/repos/team/alpha/commits?sha=main&limit=10&path=agent-note.md", auth=f.ADMIN)
        if isinstance(commits, list) and commits:
            author = commits[0].get("commit", {}).get("author", {})
            break
        time.sleep(5)
    check("Wikis MCP", isinstance(author, dict) and author.get("email", "").startswith("alice@"),
          f"the agent's edit is committed with alice as author -> {author}")
    status, missing = agent.call("exec", {"command": "ls"})
    check("Wikis MCP", isinstance(missing, dict) and missing.get("isError") is True
          and "forgejo/team/alpha, forgejo/team/beta" in result_text(missing),
          f"without a wiki, alice (two wikis) is asked to name one -> {result_text(missing)}")
    status, dave_token = agent_token(dave, "dave agent")
    if dave_token is None:
        check("Wikis MCP", False, f"dave creates an agent token -> {status}")
        return
    other = Mcp(dave_token)
    other.start()
    status, refused = other.call("exec", {"wiki": "team/beta", "command": "ls"})
    check("Wikis MCP", isinstance(refused, dict) and refused.get("isError") is True
          and 'There is no wiki called "team/beta"' in result_text(refused),
          f"dave's agent is refused for beta like an unknown name -> {result_text(refused)}")
    status, alone = other.call("exec", {"command": "cat README.md"})
    check("Wikis MCP", isinstance(alone, dict) and not alone.get("isError")
          and "# alpha" in result_text(alone),
          f"dave (one wiki) leaves the wiki out and reaches alpha -> {result_text(alone)[:160]}")
    stores = docker("exec", WIKIS_CONTAINER, "sh", "-c",
                    "find /data -name agent-tokens.json", check_ok=False).stdout.split()
    check("Wikis R13", stores == ["/data/server/agent-tokens.json"],
          f"the agent-token store exists only at the front door -> {stores}")



def wikis_test():
    alice = f.web_login("alice")
    status, detail = door_round(alice, "/auth/forgejo/login?next=%2F")
    check("Wikis sign-in", status == 302, f"alice signs in once at the front door -> {status} {detail}")
    status, detail = door_round(alice, "/auth/forgejo/add-wiki?next=%2F")
    check("Wikis add", status == 302, f"the second host round for Add a wiki -> {status} {detail}")
    status, addable, _ = door_call("GET", "/api/front-door/addable", alice)
    repos = {r["name"]: r for r in addable.get("repos", [])} if isinstance(addable, dict) else {}
    check("Wikis add", status == 200 and "alpha" in repos and "beta" in repos
          and addable.get("needsToken") is True and addable.get("canAdd") is True,
          f"addable repos -> {status} {sorted(repos)} {addable if status != 200 else ''}")
    status, refused, _ = door_call("POST", "/api/front-door/wikis", alice,
                                   {"id": repos.get("alpha", {}).get("id"), "token": os.environ["BETA_TOKEN"]})
    check("Wikis add", status == 400 and isinstance(refused, dict) and refused.get("error") == "token-refused",
          f"a token limited to another repository is refused -> {status} {refused}")
    for label, token, expected in (("an unlimited token of another account", os.environ["ALICE_TOKEN"], "not-limited"),
                                   ("an unlimited token of the bot", os.environ["WIDE_TOKEN"], "not-limited")):
        status, refused, _ = door_call("POST", "/api/front-door/wikis", alice,
                                       {"id": repos.get("alpha", {}).get("id"), "token": token})
        check("Wikis add", status == 400 and isinstance(refused, dict) and refused.get("refusal") == expected,
              f"{label} is refused -> {status} {refused}")
    seen, _, _ = f.call("GET", "/repos/alice/journal/contents", token=os.environ["BOT_TOKEN"])
    probe, _, _ = f.call("GET", "/repos/alice/journal/contents", token=os.environ["ALPHA_TOKEN"])
    check("Wikis add", seen == 200 and probe in (403, 404),
          f"on alice's private repo, which the bot administers: bot -> {seen}, token limited to team/alpha -> {probe}")
    keys = {}
    for name, token in (("alpha", os.environ["ALPHA_TOKEN"]), ("beta", os.environ["BETA_TOKEN"])):
        status, made, _ = door_call("POST", "/api/front-door/wikis", alice,
                                    {"id": repos.get(name, {}).get("id"), "token": token})
        key = made.get("wiki", {}).get("key") if isinstance(made, dict) else None
        keys[name] = key
        check("Wikis add", status == 201 and key == f"forgejo-{repos.get(name, {}).get('id')}",
              f"Make this a wiki team/{name} -> {status} {made}")
    for name in ("alpha", "beta"):
        status, page, _ = door_call("GET", f"/w/forgejo/team/{name}/", alice, accept="text/html")
        check("Wikis open", status == 200 and "<html" in str(page).lower(),
              f"alice opens /w/forgejo/team/{name}/ -> {status}")
        status, me, _ = door_call("GET", f"/w/forgejo/team/{name}/auth/me", alice)
        check("Wikis open", status == 200 and isinstance(me, dict) and me.get("login") == "alice"
              and me.get("admin") is True,
              f"/w/forgejo/team/{name}/auth/me for alice (repo admin) -> {status} {me if status != 200 else ''}")
        status, config, _ = door_call("GET", f"/w/forgejo/team/{name}/api/config", alice)
        check("Wikis open", status == 200, f"/w/forgejo/team/{name}/api/config -> {status}")
    dave = f.web_login("dave")
    status, detail = door_round(dave, "/auth/forgejo/login?next=%2F")
    check("Wikis sign-in", status == 302, f"dave signs in -> {status} {detail}")
    status, me, _ = door_call("GET", "/w/forgejo/team/alpha/auth/me", dave)
    check("Wikis access", status == 200 and isinstance(me, dict) and me.get("login") == "dave"
          and me.get("admin") is False, f"dave (writer on alpha) opens alpha -> {status} {me}")
    status, body, _ = door_call("GET", "/w/forgejo/team/beta/auth/me", dave)
    check("Wikis access", status == 404 and isinstance(body, dict) and body.get("error") == "not-a-wiki",
          f"dave has no access to beta, which looks like no wiki at all -> {status} {body}")
    status, page, _ = door_call("GET", "/w/forgejo/team/beta/", dave, accept="text/html")
    check("Wikis access", status == 404 and "There is no wiki at this address" in str(page)
          and "team/beta" not in str(page), f"dave sees the no-wiki page for beta, without its name -> {status}")
    status, listed, _ = door_call("GET", "/api/front-door/wikis", dave)
    names = [w.get("name") for w in listed.get("wikis", [])] if isinstance(listed, dict) else []
    check("Wikis access", status == 200 and names == ["alpha"], f"dave's wiki list -> {status} {names}")
    status, page, _ = door_call("GET", "/", alice, accept="text/html")
    page = str(page)
    check("Wikis list", status == 200 and 'href="/w/forgejo/team/alpha/"' in page and 'href="/w/forgejo/team/beta/"' in page
          and "This server hosts wikis from team." in page and 'href="/add-wiki"' in page,
          f"alice's list page at / shows both wikis, Add a wiki and the allowed owners -> {status}")
    status, page, _ = door_call("GET", "/", dave, accept="text/html")
    page = str(page)
    check("Wikis list", status == 200 and 'href="/w/forgejo/team/alpha/"' in page and "team/beta" not in page,
          f"dave's list page shows alpha only -> {status}")
    status, listed, _ = door_call("GET", "/api/front-door/wikis", alice)
    check("Wikis list", status == 200 and isinstance(listed, dict) and listed.get("addWikiPage") == "/add-wiki"
          and sorted(w.get("name") for w in listed.get("wikis", [])) == ["alpha", "beta"],
          f"the menu's list for alice -> {status}")
    door_round(alice, "/auth/forgejo/add-wiki?next=%2Fadd-wiki")
    status, page, _ = door_call("GET", "/add-wiki", alice, accept="text/html")
    page = str(page)
    check("Wikis add page", status == 200 and page.count("Open the wiki") >= 2 and "@gitquire-bot" in page
          and "write:repository" in page,
          f"alice's Add a wiki page: both repos are wikis, the bot is named -> {status}")
    door_round(dave, "/auth/forgejo/add-wiki?next=%2Fadd-wiki")
    status, page, _ = door_call("GET", "/add-wiki", dave, accept="text/html")
    page = str(page)
    check("Wikis add page", status == 200 and "only server administrators add wikis" in page
          and 'name="token"' not in page,
          f"dave (no server administrator) gets the explanation, no token field -> {status}")
    mention = ('The numbers look good.\n\n[^c-h5m]: \U0001f4ac on "numbers"\n\n'
               '    - **@carol** \u00b7 2026-11-20 09:00 \u2014 Please look, @alice @dave\n')
    encoded = base64.b64encode(mention.encode()).decode()
    for key in keys.values():
        docker("exec", WIKIS_CONTAINER, "sh", "-c",
               f"echo {encoded} | base64 -d > /data/wikis/{key}/h5-mentions.md")
    time.sleep(6)
    status, listed, _ = door_call("GET", "/api/front-door/wikis", alice)
    counts = {w.get("name"): w.get("unread") for w in listed.get("wikis", [])} if isinstance(listed, dict) else {}
    check("Wikis badge", status == 200 and counts == {"alpha": 1, "beta": 1} and listed.get("unread") == 2,
          f"alice's unread mentions per wiki -> {status} {counts} total {listed.get('unread') if isinstance(listed, dict) else None}")
    status, listed, _ = door_call("GET", "/api/front-door/wikis", dave)
    counts = {w.get("name"): w.get("unread") for w in listed.get("wikis", [])} if isinstance(listed, dict) else {}
    check("Wikis badge", status == 200 and counts == {"alpha": 1} and listed.get("unread") == 1,
          f"dave counts only alpha's mention, nothing of beta -> {status} {counts}")
    for name, key in keys.items():
        proc = docker("exec", WIKIS_CONTAINER, "test", "-d", f"/data/wikis/{key}/.git", check_ok=False)
        check("Wikis R10", proc.returncode == 0, f"team/{name} is checked out in /data/wikis/{key}/")
    leaks = docker("exec", WIKIS_CONTAINER, "sh", "-c",
                   "for p in /proc/[0-9]*; do e=$(tr '\\0' '\\n' < $p/environ 2>/dev/null) || continue; "
                   "echo \"$e\" | grep -q '^GITQUIRE_BEHIND_FRONT_DOOR=on' || continue; "
                   "echo \"$e\" | grep -Eq '^(GITQUIRE_HOST_TOKEN|GITQUIRE_HOST_CLIENT_SECRET|GITQUIRE_SESSION_SECRET)=' && echo leak; "
                   "echo editor; done", check_ok=False).stdout.split()
    check("Wikis R12", leaks.count("editor") >= 2 and "leak" not in leaks,
          f"editor processes: {leaks.count('editor')}, holding the bot token or a secret: {leaks.count('leak')}")
    wikis_mcp(alice, dave)


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
    elif step == "wikis-setup":
        wikis_setup()
    elif step == "wikis":
        wikis_test()
        summary()
