import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

HOSTS = os.environ.get("HOSTS_URL", "http://127.0.0.1:8400").rstrip("/")
os.environ["WIKIS_URL"] = HOSTS
os.environ["WIKIS_CONTAINER"] = os.environ.get("HOSTS_CONTAINER", "gq-hosts")

import forgejo_rows as f
import h5_forgejo as h

IMAGE = "gitquire:ci"
NAME = os.environ["WIKIS_CONTAINER"]
PORT = int(urllib.parse.urlparse(HOSTS).port or 80)
FAKE = os.environ.get("GITHUB_FAKE_URL", "https://127.0.0.1:3443").rstrip("/")
ACCESS_CHECK_SECONDS = 15
check = h.check
door_call = h.door_call
door_round = h.door_round


def env_out(lines):
    with open(os.environ["GITHUB_ENV"], "a") as fh:
        fh.write("\n".join(lines) + "\n")


def setup():
    status, app, _ = f.call("POST", "/user/applications/oauth2", {
        "name": "GitQuire two hosts", "redirect_uris": [HOSTS + "/auth/forgejo/callback"],
        "confidential_client": True,
    }, auth=f.ADMIN)
    if status != 201:
        raise RuntimeError(f"oauth app: {status} {app}")
    ids = {}
    for login in ("alice", "dave"):
        status, user, _ = f.call("GET", f"/users/{login}", auth=f.ADMIN)
        if status != 200:
            raise RuntimeError(f"user {login}: {status} {user}")
        ids[login] = user["id"]
    people = {
        "alice": {"id": ids["alice"], "login": "alice", "name": "Alice on GitHub"},
        "bob": {"id": 9001, "login": "bob", "name": "Bob"},
    }
    levels = {"alice": {"alpha": "write", "gamma": "admin"}, "bob": {"alpha": "admin"}}
    print("::add-mask::" + app["client_secret"])
    env_out([f"HOSTS_CLIENT_ID={app['client_id']}", f"HOSTS_CLIENT_SECRET={app['client_secret']}",
             f"GITHUB_FAKE_PEOPLE={json.dumps(people)}", f"GITHUB_FAKE_LEVELS={json.dumps(levels)}",
             f"FORGEJO_ALICE_ID={ids['alice']}"])
    print("two-host set-up done")


def fake(path, body=None):
    data = json.dumps(body or {}).encode()
    req = urllib.request.Request(FAKE + path, data=data, method="POST",
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read())


def start():
    h.docker("rm", "-f", NAME, check_ok=False)
    env = {
        "NODE_EXTRA_CA_CERTS": "/ca/cert.pem", "GIT_SSL_CAINFO": "/ca/cert.pem",
        "PORT": str(PORT), "GITQUIRE_EXTERNAL_URL": HOSTS,
        "GITQUIRE_WIKIS": "on", "GITQUIRE_ALLOWED_OWNERS": "team", "GITQUIRE_ADMINS": "alice",
        "GITQUIRE_HOST": "forgejo", "GITQUIRE_HOST_URL": os.environ["FORGEJO_URL"],
        "GITQUIRE_HOST_CLIENT_ID": os.environ["HOSTS_CLIENT_ID"],
        "GITQUIRE_HOST_CLIENT_SECRET": os.environ["HOSTS_CLIENT_SECRET"],
        "GITQUIRE_HOST_TOKEN": os.environ["BOT_TOKEN"],
        "GITQUIRE_HOSTS": "github",
        "GITQUIRE_HOST_GITHUB_URL": FAKE,
        "GITQUIRE_HOST_GITHUB_API_URL": FAKE + "/api/v3",
        "GITQUIRE_HOST_GITHUB_CLIENT_ID": "fake-client",
        "GITQUIRE_HOST_GITHUB_CLIENT_SECRET": "fake-secret",
        "GITQUIRE_HOST_GITHUB_APP_ID": "4242",
        "GITQUIRE_HOST_GITHUB_APP_PRIVATE_KEY_FILE": "/ca/app.pem",
        "GITQUIRE_HOST_GITHUB_ALLOWED_OWNERS": "team",
        "GITQUIRE_HOST_GITHUB_ADMINS": "bob",
        "GITQUIRE_SESSION_SECRET": "0123456789abcdef0123456789abcdef",
        "GITQUIRE_ACCESS_CHECK_SECONDS": str(ACCESS_CHECK_SECONDS),
    }
    args = []
    for name, value in env.items():
        args += ["-e", f"{name}={value}"]
    h.docker("run", "-d", "--name", NAME, "--network", "host", "-v", "gq-hosts:/data", "-v", "/tmp/ca:/ca:ro",
             *args, IMAGE)
    deadline = time.time() + 180
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(HOSTS + "/readyz", timeout=5) as resp:
                if resp.status == 200:
                    return True
        except Exception:
            pass
        time.sleep(1)
    return False


def github_round(op, login, start_path):
    fake("/_fake/next-login", {"login": login})
    status, _, headers = f.get_html(op, HOSTS + start_path)
    location = headers.get("Location", "")
    if status != 302 or not location.startswith(FAKE + "/login/oauth/authorize"):
        return status, f"start answered {status} {location}"
    status, _, headers = f.get_html(op, location)
    callback = headers.get("Location", "")
    if status != 302 or not callback.startswith(HOSTS + "/auth/github/callback"):
        return status, f"the fake did not send the browser back: {status} {callback}"
    status, _, headers = f.get_html(op, callback)
    return status, headers.get("Location", "")


def agents_token(op, path, label):
    req = urllib.request.Request(HOSTS + path, method="POST",
                                 data=urllib.parse.urlencode({"label": label}).encode(),
                                 headers={"Content-Type": "application/x-www-form-urlencoded",
                                          "Accept": "text/html", "Origin": HOSTS})
    try:
        with op.open(req, timeout=60) as resp:
            status, page = resp.status, resp.read().decode(errors="replace")
    except urllib.error.HTTPError as err:
        status, page = err.code, err.read().decode(errors="replace")
    match = re.search(r"gqa_[0-9a-f]{16}_[A-Za-z0-9_-]{32,}", page)
    return status, match.group(0) if match else None, page


class Mcp(h.Mcp):
    def __init__(self, token, path):
        super().__init__(token)
        self.path = path

    def post(self, message):
        hdrs = {"Authorization": f"Bearer {self.token}", "Content-Type": "application/json",
                "Accept": "application/json, text/event-stream"}
        if self.session:
            hdrs["Mcp-Session-Id"] = self.session
        req = urllib.request.Request(HOSTS + self.path, data=json.dumps(message).encode(),
                                     method="POST", headers=hdrs)
        try:
            with urllib.request.urlopen(req, timeout=180) as resp:
                self.session = resp.headers.get("Mcp-Session-Id") or self.session
                return resp.status, f.parse(resp.read())
        except urllib.error.HTTPError as err:
            return err.code, f.parse(err.read())


def listed_names(op):
    status, listed, _ = door_call("GET", "/api/front-door/wikis", op)
    names = sorted(w.get("fullName") or w.get("name") for w in listed.get("wikis", [])) if isinstance(listed, dict) else []
    return status, names, listed


def me(op, wiki):
    return door_call("GET", f"/w/{wiki}/auth/me", op)


def wait_for(fn, seconds, step=3):
    deadline = time.time() + seconds
    while time.time() < deadline:
        value = fn()
        if value:
            return value
        time.sleep(step)
    return fn()


def no_redirect_get(op, path, accept="text/html"):
    req = urllib.request.Request(HOSTS + path, headers={"Accept": accept})
    try:
        with op.open(req, timeout=60) as resp:
            return resp.status, dict(resp.headers)
    except urllib.error.HTTPError as err:
        return err.code, dict(err.headers)


def test():
    check("Hosts start", start(), "GitQuire starts with Forgejo first and the GitHub fake as a further host")
    status, page, _ = f.get_html(f.browser(), HOSTS + "/auth/sign-in")
    check("Hosts start", status == 200 and "Forgejo" in page and "GitHub" in page,
          f"the sign-in page offers both hosts -> {status}")

    alice = f.web_login("alice")
    status, detail = door_round(alice, "/auth/forgejo/login?next=%2F")
    check("Hosts sign-in", status == 302, f"alice signs in with Forgejo -> {status} {detail}")
    status, detail = github_round(alice, "alice", "/auth/github/login?next=%2F")
    check("Hosts sign-in", status == 302, f"alice signs in with GitHub in the same session -> {status} {detail}")
    status, body, _ = door_call("GET", "/auth/me", alice)
    accounts = sorted((a.get("host"), a.get("login")) for a in body.get("accounts", [])) if isinstance(body, dict) else []
    check("Hosts sign-in", status == 200 and accounts == [("forgejo", "alice"), ("github", "alice")],
          f"/auth/me lists both accounts -> {status} {accounts}")

    status, detail = door_round(alice, "/auth/forgejo/add-wiki?next=%2F")
    check("Hosts add", status == 302, f"Forgejo round for Add a wiki -> {status} {detail}")
    status, addable, _ = door_call("GET", "/api/front-door/addable?host=forgejo", alice)
    repos = {r["name"]: r for r in addable.get("repos", [])} if isinstance(addable, dict) else {}
    status, made, _ = door_call("POST", "/api/front-door/wikis", alice, {
        "host": "forgejo", "id": repos.get("alpha", {}).get("id"), "token": os.environ["ALPHA_TOKEN"]})
    check("Hosts add", status == 201, f"alice makes forgejo/team/alpha a wiki -> {status} {made}")
    status, missing, _ = door_call("POST", "/api/front-door/wikis", alice, {"id": 501})
    check("Hosts add", status == 400 and isinstance(missing, dict) and missing.get("error") == "host-required",
          f"with two accounts and no host named, the API asks for the host -> {status} {missing}")
    status, detail = github_round(alice, "alice", "/auth/github/add-wiki?next=%2F")
    check("Hosts add", status == 302, f"GitHub round for Add a wiki -> {status} {detail}")
    status, addable, _ = door_call("GET", "/api/front-door/addable?host=github", alice)
    names = sorted(r["name"] for r in addable.get("repos", [])) if isinstance(addable, dict) else []
    check("Hosts add", status == 200 and names == ["gamma"],
          f"alice may add only the GitHub repository she administers -> {status} {names}")
    status, made, _ = door_call("POST", "/api/front-door/wikis", alice, {"host": "github", "id": 502})
    check("Hosts add", status == 201, f"alice makes github/team/gamma a wiki -> {status} {made}")

    bob = f.browser()
    status, detail = github_round(bob, "bob", "/auth/github/login?next=%2F")
    check("Hosts sign-in", status == 302, f"bob signs in with GitHub only -> {status} {detail}")
    status, detail = github_round(bob, "bob", "/auth/github/add-wiki?next=%2F")
    status, made, _ = door_call("POST", "/api/front-door/wikis", bob, {"id": 501})
    check("Hosts add", status == 201, f"bob (one account) makes github/team/alpha a wiki without naming the host -> {status} {made}")

    status, names, _ = listed_names(alice)
    check("Hosts lists", status == 200 and names == ["forgejo/team/alpha", "github/team/alpha", "github/team/gamma"],
          f"alice's list joins both accounts -> {status} {names}")
    status, names, _ = listed_names(bob)
    check("Hosts lists", status == 200 and names == ["github/team/alpha"],
          f"bob sees only the GitHub wiki he can open -> {status} {names}")

    s1, forgejo_me, _ = me(alice, "forgejo/team/alpha")
    s2, github_me, _ = me(alice, "github/team/alpha")
    ids = (forgejo_me.get("principalId") if isinstance(forgejo_me, dict) else None,
           github_me.get("principalId") if isinstance(github_me, dict) else None)
    check("Hosts same login", s1 == 200 and s2 == 200 and ids[0] is not None and ids[1] is not None and ids[0] != ids[1],
          f"alice on Forgejo and alice on GitHub (same login, same number {os.environ.get('FORGEJO_ALICE_ID')}) are two people -> {s1} {s2} {ids}")
    check("Hosts admin", isinstance(forgejo_me, dict) and forgejo_me.get("admin") is True
          and isinstance(github_me, dict) and github_me.get("admin") is False,
          f"alice is admin of forgejo/team/alpha and only a writer on github/team/alpha -> "
          f"{forgejo_me.get('admin') if isinstance(forgejo_me, dict) else forgejo_me} "
          f"{github_me.get('admin') if isinstance(github_me, dict) else github_me}")
    s3, gamma_me, _ = me(alice, "github/team/gamma")
    check("Hosts open", s3 == 200, f"alice opens github/team/gamma -> {s3}")

    for path, wanted in (("/w/team/alpha/", "/w/forgejo/team/alpha/"),
                         ("/w/team/alpha/api/config", "/w/forgejo/team/alpha/api/config"),
                         ("/w/team/alpha/images/logo.png?x=1", "/w/forgejo/team/alpha/images/logo.png?x=1")):
        status, headers = no_redirect_get(alice, path)
        check("Hosts old address", status == 301 and headers.get("Location") == wanted,
              f"{path} goes to the wiki that held the name first -> {status} {headers.get('Location')}")
    status, _ = no_redirect_get(bob, "/w/team/alpha/")
    check("Hosts old address", status == 404,
          f"bob, who cannot open forgejo/team/alpha, gets the unknown-address answer -> {status}")

    status, forgejo_token, page = agents_token(alice, "/auth/agents", "forgejo agent")
    check("Hosts tokens", status == 200 and forgejo_token is not None,
          f"alice creates an agent token for Forgejo at /auth/agents -> {status}")
    check("Hosts admin", "Everyone's agent access" in page, "alice is a server admin on Forgejo: she sees everyone's tokens there")
    status, github_token, page = agents_token(alice, "/auth/github/agents", "github agent")
    check("Hosts tokens", status == 200 and github_token is not None and "/mcp/github" in page,
          f"alice creates an agent token for GitHub at /auth/github/agents, with the /mcp/github address -> {status}")
    check("Hosts admin", "Everyone's agent access" not in page, "alice is not a server admin on GitHub: no admin section there")
    status, _, page = agents_token(bob, "/auth/github/agents", "bob agent")
    check("Hosts admin", status == 200 and "Everyone's agent access" in page and "@alice" in page,
          f"bob, a server admin on GitHub only, sees alice's GitHub token -> {status}")

    if forgejo_token and github_token:
        on_forgejo = Mcp(forgejo_token, "/mcp")
        on_forgejo.start()
        _, wikis = on_forgejo.call("list_wikis", {})
        names = [w.get("wiki") for w in (wikis or {}).get("structuredContent", {}).get("wikis", [])]
        check("Hosts tokens", names == ["forgejo/team/alpha"], f"/mcp with the Forgejo token lists Forgejo's wikis only -> {names}")
        on_github = Mcp(github_token, "/mcp/github")
        on_github.start()
        _, wikis = on_github.call("list_wikis", {})
        names = sorted(w.get("wiki") for w in (wikis or {}).get("structuredContent", {}).get("wikis", []))
        check("Hosts tokens", names == ["github/team/alpha", "github/team/gamma"],
              f"/mcp/github with the GitHub token lists GitHub's wikis only -> {names}")
        status, _ = Mcp(forgejo_token, "/mcp/github").start()
        check("Hosts tokens", status == 401, f"the Forgejo token is refused at /mcp/github -> {status}")
        status, _ = Mcp(github_token, "/mcp").start()
        check("Hosts tokens", status == 401, f"the GitHub token is refused at /mcp -> {status}")
        for agent, wiki, wanted, other in ((on_forgejo, "forgejo/team/alpha", "# alpha", "on GitHub"),
                                           (on_github, "github/team/alpha", "# alpha on GitHub", None)):
            status, result = agent.call("exec", {"wiki": wiki, "command": "cat README.md"})
            text = h.result_text(result)
            check("Hosts same name", status == 200 and wanted in text and (other is None or other not in text),
                  f"{wiki} reads its own README -> {status} {text[:120]}")
        status, refused = on_forgejo.call("exec", {"wiki": "github/team/alpha", "command": "ls"})
        check("Hosts tokens", isinstance(refused, dict) and refused.get("isError") is True,
              f"the Forgejo connection cannot name a GitHub wiki -> {h.result_text(refused)[:160]}")
        status, wrote = on_github.call("write", {"wiki": "github/team/alpha", "document": {
            "path": "from-agent", "content": "# From the agent\n\nWritten on GitHub.\n"}})
        check("Hosts sync", status == 200 and isinstance(wrote, dict) and not wrote.get("isError"),
              f"alice's GitHub agent writes a page in github/team/alpha -> {status} {h.result_text(wrote)[:160]}")
        log = wait_for(lambda: next((line for line in fake("/_fake/readme", {"name": "alpha"}).get("log", [])
                                     if "alice" in line.lower() and "users.noreply" in line), None), 240, 5)
        check("Hosts sync", log is not None,
              f"the edit reaches the GitHub fake as a commit by alice with her GitHub no-reply address -> {log}")

    fake("/_fake/access", {"login": "alice", "repo": "alpha", "level": "none"})
    cut = wait_for(lambda: me(alice, "github/team/alpha")[0] == 404, ACCESS_CHECK_SECONDS * 6, 3)
    s_forgejo = me(alice, "forgejo/team/alpha")[0]
    check("Hosts access removed", cut and s_forgejo == 200,
          f"alice loses github/team/alpha on GitHub: it answers like an unknown wiki, forgejo/team/alpha still opens -> {cut} {s_forgejo}")
    fake("/_fake/access", {"login": "alice", "repo": "alpha", "level": "write"})

    fake("/_fake/down", {"down": True})
    started = time.time()
    status, names, _ = listed_names(alice)
    took = time.time() - started
    check("Hosts down", status == 200 and "forgejo/team/alpha" in names and took < 15,
          f"with GitHub down, alice's list still answers in {round(took, 1)} s with Forgejo's wikis -> {status} {names}")
    s_forgejo = me(alice, "forgejo/team/alpha")[0]
    check("Hosts down", s_forgejo == 200, f"forgejo/team/alpha opens while GitHub is down -> {s_forgejo}")
    s_github = me(alice, "github/team/gamma")[0]
    check("Hosts down", None, f"github/team/gamma while GitHub is down -> {s_github}")
    fake("/_fake/down", {"down": False})

    leaks = h.docker("exec", NAME, "sh", "-c",
                     "for p in /proc/[0-9]*; do e=$(tr '\\0' '\\n' < $p/environ 2>/dev/null) || continue; "
                     "echo \"$e\" | grep -q '^GITQUIRE_BEHIND_FRONT_DOOR=on' || continue; "
                     "echo \"$e\" | grep -Eq '^(GITQUIRE_HOST_TOKEN|GITQUIRE_HOST_CLIENT_SECRET|GITQUIRE_SESSION_SECRET|GITQUIRE_HOST_GITHUB_[A-Z_]*)=' && echo leak; "
                     "echo editor; done", check_ok=False).stdout.split()
    check("Hosts R12", leaks.count("editor") >= 2 and "leak" not in leaks,
          f"editor processes: {leaks.count('editor')}, holding a host secret: {leaks.count('leak')}")
    files = h.docker("exec", NAME, "ls", "/data/server", check_ok=False).stdout.split()
    check("Hosts tokens", "agent-tokens.json" in files and "agent-tokens-github.json" in files,
          f"agent tokens are stored per host -> {[n for n in files if n.startswith('agent-tokens')]}")
    unknown = fake("/_fake/unknown").get("unknown", [])
    check("Hosts fake", None, f"GitHub calls the fake does not answer: {sorted(set(unknown))[:20]}")


if __name__ == "__main__":
    step = sys.argv[1]
    if step == "setup":
        setup()
    elif step == "test":
        try:
            test()
        finally:
            h.summary()
