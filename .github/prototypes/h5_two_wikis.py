import base64
import json
import os
import socket
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

os.environ.setdefault("WIKIS_CONTAINER", "gq-two")

import forgejo_rows as f
import h5_forgejo as h

IMAGE = "gitquire:ci"
NAME = os.environ["WIKIS_CONTAINER"]
URL = h.WIKIS
PORT = int(urllib.parse.urlparse(URL).port or 80)
ACCESS_CHECK_SECONDS = 15
check = h.check


def start(allowed="team"):
    h.docker("rm", "-f", NAME, check_ok=False)
    env = {
        "NODE_EXTRA_CA_CERTS": "/ca/cert.pem", "GIT_SSL_CAINFO": "/ca/cert.pem",
        "PORT": str(PORT), "GITQUIRE_EXTERNAL_URL": URL,
        "GITQUIRE_WIKIS": "on", "GITQUIRE_ALLOWED_OWNERS": allowed, "GITQUIRE_ADMINS": "alice",
        "GITQUIRE_HOST": "forgejo", "GITQUIRE_HOST_URL": os.environ["FORGEJO_URL"],
        "GITQUIRE_HOST_CLIENT_ID": os.environ["WIKIS_CLIENT_ID"],
        "GITQUIRE_HOST_CLIENT_SECRET": os.environ["WIKIS_CLIENT_SECRET"],
        "GITQUIRE_HOST_TOKEN": os.environ["BOT_TOKEN"],
        "GITQUIRE_SESSION_SECRET": "0123456789abcdef0123456789abcdef",
        "GITQUIRE_ACCESS_CHECK_SECONDS": str(ACCESS_CHECK_SECONDS),
        "GITQUIRE_WIKI_IDLE_MINUTES": "1",
    }
    args = []
    for name, value in env.items():
        args += ["-e", f"{name}={value}"]
    h.docker("run", "-d", "--name", NAME, "--network", "host", "-v", "gq-wikis:/data", "-v", "/tmp/ca:/ca:ro",
             *args, IMAGE)
    deadline = time.time() + 180
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(URL + "/readyz", timeout=5) as resp:
                if resp.status == 200:
                    return True
        except Exception:
            pass
        time.sleep(1)
    return False


def restart():
    h.docker("restart", "-t", "60", NAME)
    deadline = time.time() + 180
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(URL + "/readyz", timeout=5) as resp:
                if resp.status == 200:
                    return True
        except Exception:
            pass
        time.sleep(1)
    return False


def call(op, method, path, body=None, headers=None, accept="application/json"):
    data = None
    hdrs = {"Accept": accept, "Origin": URL}
    if headers:
        hdrs.update(headers)
    if body is not None:
        data = json.dumps(body).encode()
        hdrs["Content-Type"] = "application/json"
    req = urllib.request.Request(URL + path, data=data, method=method, headers=hdrs)
    try:
        with op.open(req, timeout=180) as resp:
            return resp.status, f.parse(resp.read()), dict(resp.headers)
    except urllib.error.HTTPError as err:
        return err.code, f.parse(err.read()), dict(err.headers)


def cookies_of(op):
    jar = next(handler.cookiejar for handler in op.handlers if hasattr(handler, "cookiejar"))
    return {c.name: c.value for c in jar if c.name.startswith("gq_")}


def cookie_header(op, extra=None):
    values = cookies_of(op)
    values.update(extra or {})
    return "; ".join(f"{name}={value}" for name, value in values.items())


def upgrade(op, path):
    sock = socket.create_connection(("127.0.0.1", PORT), timeout=30)
    key = base64.b64encode(os.urandom(16)).decode()
    sock.sendall((f"GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{PORT}\r\nConnection: Upgrade\r\n"
                  f"Upgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: {key}\r\n"
                  f"Origin: {URL}\r\nCookie: {cookie_header(op)}\r\n\r\n").encode())
    head = b""
    while b"\r\n\r\n" not in head:
        chunk = sock.recv(4096)
        if not chunk:
            break
        head += chunk
    return head.split(b"\r\n", 1)[0].decode(errors="replace"), sock


def closed_within(sock, seconds):
    sock.settimeout(1)
    deadline = time.time() + seconds
    started = time.time()
    while time.time() < deadline:
        try:
            if sock.recv(65536) == b"":
                return time.time() - started
        except socket.timeout:
            continue
        except OSError:
            return time.time() - started
    return None


def key_of(name):
    status, record, _ = f.call("GET", f"/repos/team/{name}", auth=f.ADMIN)
    return f"forgejo-{record['id']}" if status == 200 else None


def editors():
    out = h.docker("exec", NAME, "sh", "-c",
                   "for p in /proc/[0-9]*; do e=$(tr '\\0' '\\n' < $p/environ 2>/dev/null) || continue; "
                   "echo \"$e\" | grep -q '^GITQUIRE_BEHIND_FRONT_DOOR=on' || continue; "
                   "echo \"$e\" | grep -q '^GITQUIRE_DRAFT' && continue; "
                   "echo \"$e\" | grep '^GITQUIRE_REPO=' | cut -d= -f2; done | sort -u", check_ok=False)
    return out.stdout.split()


def wait_for(probe, seconds, step=2):
    deadline = time.time() + seconds
    value = probe()
    while not value and time.time() < deadline:
        time.sleep(step)
        value = probe()
    return value


def sign_in(user):
    op = f.web_login(user)
    status, detail = h.door_round(op, "/auth/forgejo/login?next=%2F")
    check("Two wikis sign-in", status == 302, f"{user} signs in at the front door -> {status} {detail}")
    return op


def isolation(alice, dave, alpha, beta):
    status, listed, _ = call(alice, "GET", "/api/front-door/wikis")
    names = sorted(w.get("name") for w in listed.get("wikis", [])) if isinstance(listed, dict) else []
    check("Two wikis list", names == ["alpha", "beta"], f"alice's list -> {status} {names}")
    status, listed, _ = call(dave, "GET", "/api/front-door/wikis")
    names = sorted(w.get("name") for w in listed.get("wikis", [])) if isinstance(listed, dict) else []
    check("Two wikis list", names == ["alpha"], f"dave's list -> {status} {names}")
    status, page, _ = call(dave, "GET", "/", accept="text/html")
    check("Two wikis list", status == 200 and "/w/team/alpha/" in str(page) and "team/beta" not in str(page),
          f"dave's list page names alpha only -> {status}")

    h.docker("exec", NAME, "sh", "-c", f"printf 'beta-image' > /data/wikis/{beta}/dot.png")
    rows = [
        ("page", "/w/team/beta/", "text/html", {}),
        ("API", "/w/team/beta/api/config", "application/json", {}),
        ("file", "/w/team/beta/api/asset?path=dot.png", "*/*", {}),
        ("image by Referer", "/api/asset?path=dot.png", "*/*", {"Referer": URL + "/w/team/beta/page"}),
        ("image at the root by Referer", "/dot.png", "*/*", {"Referer": URL + "/w/team/beta/"}),
        ("drafts", "/w/team/beta/api/gitquire/drafts", "application/json", {}),
        ("address in other case", "/w/TEAM/Beta/api/config", "application/json", {}),
    ]
    for label, path, accept, headers in rows:
        status, body, _ = call(dave, "GET", path, headers=headers, accept=accept)
        check("Two wikis isolation", status == 404 and "beta-image" not in str(body),
              f"dave cannot reach beta's {label} ({path}) -> {status}")
    status, body, _ = call(alice, "GET", "/api/asset?path=dot.png", headers={"Referer": URL + "/w/team/beta/page"}, accept="*/*")
    check("Two wikis isolation", status == 200 and "beta-image" in str(body),
          f"alice gets beta's file through the Referer catch-all -> {status}")
    status, body, _ = call(dave, "GET", "/api/asset?path=dot.png", headers={"Referer": URL + "/w/team/alpha/page"}, accept="*/*")
    check("Two wikis isolation", "beta-image" not in str(body),
          f"dave with alpha as Referer gets alpha's answer, never beta's file -> {status}")
    line, sock = upgrade(dave, "/w/team/beta/collab")
    sock.close()
    check("Two wikis isolation", line.startswith("HTTP/1.1 404"), f"dave's live editing in beta is refused -> {line}")
    line, sock = upgrade(dave, "/w/team/alpha/collab")
    sock.close()
    check("Two wikis isolation", line.startswith("HTTP/1.1 101"), f"dave's live editing in alpha opens -> {line}")

    status, created, _ = call(alice, "POST", "/w/team/beta/api/gitquire/drafts", {"title": "Beta secret draft", "open": False})
    slug = created.get("draft", {}).get("slug") if isinstance(created, dict) else None
    check("Two wikis isolation", status == 201 and slug, f"alice makes a draft in beta -> {status}")
    if slug:
        own, _, _ = call(alice, "GET", f"/w/team/beta/api/gitquire/drafts/{slug}/changes")
        status, body, _ = call(dave, "GET", f"/w/team/beta/api/gitquire/drafts/{slug}/changes")
        check("Two wikis isolation", own == 200 and status == 404,
              f"dave cannot read beta's draft (alice can: {own}) -> {status}")
        forged = cookie_header(dave, {f"gq_view_{beta}": slug, f"gq_view_{alpha}": slug})
        status, body, _ = call(dave, "GET", "/w/team/alpha/api/gitquire/drafts", headers={"Cookie": forged})
        check("Two wikis isolation", "Beta secret draft" not in json.dumps(body),
              f"a forged view cookie with beta's draft shows dave nothing of it in alpha -> {status}")


def drafts(alice, alpha):
    stamp = int(time.time())
    status, created, _ = call(alice, "POST", "/w/team/alpha/api/gitquire/drafts", {"title": f"Entered draft {stamp}", "open": True})
    slug = created.get("draft", {}).get("slug") if isinstance(created, dict) else None
    view = cookies_of(alice).get(f"gq_view_{alpha}")
    check("Two wikis drafts", status == 201 and slug and view == slug,
          f"alice opens a new draft in alpha; the front door keeps it in gq_view_{alpha} -> {status} {view}")
    folder = f"/data/wikis/.gitquire-drafts/{alpha}/{slug}/{alpha}"
    made = False
    for _ in range(45):
        call(alice, "GET", "/w/team/alpha/api/config")
        if h.docker("exec", NAME, "test", "-d", f"{folder}/.git", check_ok=False).returncode == 0:
            made = True
            break
        time.sleep(2)
    check("Two wikis drafts", made, f"entering the draft makes its working copy beside the wiki's folder: {folder}")
    status, _, _ = call(alice, "POST", "/w/team/alpha/api/gitquire/view", {"slug": None})
    check("Two wikis drafts", not cookies_of(alice).get(f"gq_view_{alpha}"), f"leaving the draft clears the view -> {status}")

    title = f"Published draft {stamp}"
    status, created, _ = call(alice, "POST", "/w/team/alpha/api/gitquire/drafts", {"title": title, "open": False})
    draft = created.get("draft", {}) if isinstance(created, dict) else {}
    slug = draft.get("slug")
    branch = draft.get("branch") or f"draft/{slug}"
    status, _, _ = f.call("POST", "/repos/team/alpha/contents/two-wikis-draft.md", {
        "content": base64.b64encode(b"# From the draft in alpha\n").decode(),
        "message": "Edit in the draft", "branch": branch,
    }, auth=f.ADMIN)
    check("Two wikis drafts", status == 201, f"a second draft, with a change on its branch {branch} -> {status}")
    status, published, _ = call(alice, "POST", f"/w/team/alpha/api/gitquire/drafts/{slug}/publish", {})
    state = published.get("draft", {}).get("status") if isinstance(published, dict) else None
    check("Two wikis drafts", status == 200 and state == "published", f"publish it -> {status} {state} {published if status != 200 else ''}")
    status, commits, _ = f.call("GET", "/repos/team/alpha/commits?sha=main&limit=10", auth=f.ADMIN)
    titles = [c.get("commit", {}).get("message", "") for c in commits] if isinstance(commits, list) else []
    check("Two wikis drafts", any(t.startswith(title) for t in titles), f"team/alpha's main has the squash commit -> {titles[:3]}")
    authors = [c.get("commit", {}).get("author", {}).get("email", "") for c in commits
               if c.get("commit", {}).get("message", "").startswith(title)] if isinstance(commits, list) else []
    check("Two wikis drafts", authors != [] and authors[0].startswith("alice@"),
          f"the squash commit is by alice, who published it -> {authors[:1]}")
    status, beta_commits, _ = f.call("GET", "/repos/team/beta/commits?sha=main&limit=10", auth=f.ADMIN)
    beta_titles = [c.get("commit", {}).get("message", "") for c in beta_commits] if isinstance(beta_commits, list) else []
    check("Two wikis drafts", not any(t.startswith(title) for t in beta_titles), "team/beta has no trace of it")


def cut_off(dave):
    line, sock = upgrade(dave, "/w/team/alpha/collab")
    check("Two wikis R8", line.startswith("HTTP/1.1 101"), f"dave is in alpha's live editing -> {line}")
    status, _, _ = f.call("DELETE", "/repos/team/alpha/collaborators/dave", auth=f.ADMIN)
    limit = ACCESS_CHECK_SECONDS * 2 + 20
    took = closed_within(sock, limit)
    sock.close()
    check("Two wikis R8", took is not None,
          f"dave removed from team/alpha ({status}): the connection is cut after {round(took, 1) if took else 'more than ' + str(limit)} s "
          f"(access answers kept {ACCESS_CHECK_SECONDS} s, re-check every {ACCESS_CHECK_SECONDS} s)")
    status, body, _ = call(dave, "GET", "/w/team/alpha/api/config")
    check("Two wikis R8", status == 404, f"dave can no longer open alpha -> {status}")
    f.call("PUT", "/repos/team/alpha/collaborators/dave", {"permission": "write"}, auth=f.ADMIN)


def sleep_and_wake(alice):
    call(alice, "GET", "/w/team/alpha/api/config")
    running = editors()
    check("Two wikis sleep", "team/alpha" in running, f"alpha's process runs after use: {running}")
    stopped = wait_for(lambda: "team/alpha" not in editors(), 300, 5)
    check("Two wikis sleep", stopped, f"alpha's process stops once idle (GITQUIRE_WIKI_IDLE_MINUTES=1) and pushed and clean: {editors()}")
    status, me, _ = call(alice, "GET", "/w/team/alpha/auth/me")
    check("Two wikis sleep", status == 200 and "team/alpha" in editors(), f"the next request starts it again -> {status} {editors()}")


def rename(alice, beta):
    status, _, _ = f.call("PATCH", "/repos/team/beta", {"name": "beta2"}, auth=f.ADMIN)
    check("Two wikis R10", status == 200, f"team/beta renamed to team/beta2 on Forgejo -> {status}")
    check("Two wikis R10", restart(), "the front door restarts and looks every wiki up by id")
    moved = wait_for(lambda: call(alice, "GET", "/w/team/beta/api/config")[0] == 301, 60)
    status, _, headers = call(alice, "GET", "/w/team/beta/api/config")
    check("Two wikis R10", moved and headers.get("Location") == "/w/team/beta2/api/config",
          f"the old address redirects -> {status} {headers.get('Location')}")
    status, me, _ = call(alice, "GET", "/w/team/beta2/auth/me")
    proc = h.docker("exec", NAME, "test", "-f", f"/data/wikis/{beta}/dot.png", check_ok=False)
    check("Two wikis R10", status == 200 and proc.returncode == 0, f"the new address opens the same folder /data/wikis/{beta}/ -> {status}")


def bot_removed(alice, dave, beta):
    status, _, _ = f.call("DELETE", "/repos/team/beta2/collaborators/gitquire-bot", auth=f.ADMIN)
    check("Two wikis R11", status == 204, f"the bot is removed from team/beta2 -> {status}")
    gone = wait_for(lambda: call(alice, "GET", "/w/team/beta2/api/config")[0] == 403, ACCESS_CHECK_SECONDS * 2 + 30)
    status, page, _ = call(alice, "GET", "/w/team/beta2/", accept="text/html")
    check("Two wikis R11", gone and "is disconnected" in str(page), f"alice, its admin, sees it disconnected -> {status}")
    status, listed, _ = call(alice, "GET", "/api/front-door/wikis")
    entry = next((w for w in listed.get("wikis", []) if w.get("name") == "beta2"), {}) if isinstance(listed, dict) else {}
    check("Two wikis R11", entry.get("state") == "disconnected" and entry.get("why"),
          f"her list says why -> {entry.get('state')} {entry.get('reason')} {entry.get('why')}")
    status, _, _ = call(dave, "GET", "/w/team/beta2/api/config")
    check("Two wikis R11", status == 404, f"for dave it is no wiki at all -> {status}")
    proc = h.docker("exec", NAME, "test", "-d", f"/data/wikis/{beta}/.git", check_ok=False)
    check("Two wikis R11", proc.returncode == 0, "nothing was deleted")
    f.call("PUT", "/repos/team/beta2/collaborators/gitquire-bot", {"permission": "admin"}, auth=f.ADMIN)
    check("Two wikis R11", restart(), "the front door restarts with the bot back")
    back = wait_for(lambda: call(alice, "GET", "/w/team/beta2/api/config")[0] == 200, 90)
    check("Two wikis R11", back, "the wiki is connected again")


def host_down(alice, dave):
    call(alice, "GET", "/w/team/alpha/auth/me")
    h.docker("stop", h.FORGEJO_CONTAINER)
    time.sleep(ACCESS_CHECK_SECONDS + 5)
    status, _, _ = call(alice, "GET", "/w/team/alpha/auth/me")
    check("Two wikis R14", status == 200, f"alice stays inside alpha while Forgejo is down -> {status}")
    status, _, _ = call(dave, "GET", "/w/team/alpha/auth/me")
    check("Two wikis R14", status == 200, f"dave stays inside alpha too -> {status}")
    status, _, _ = call(dave, "GET", "/w/team/beta2/auth/me")
    check("Two wikis R14", status in (404, 503), f"dave, never let into beta2, is not let in now -> {status}")
    h.docker("start", h.FORGEJO_CONTAINER)
    wait_for(lambda: f.call("GET", "/version")[0] == 200, 120)


def owners():
    alice = sign_in("alice")
    f.call("POST", "/orgs", {"username": "other", "visibility": "private"}, auth=f.ADMIN)
    status, body, _ = f.call("POST", "/orgs/other/repos", {"name": "notes", "private": True, "auto_init": True,
                                                           "default_branch": "main"}, auth=f.ADMIN)
    f.call("PUT", "/repos/other/notes/collaborators/alice", {"permission": "admin"}, auth=f.ADMIN)
    f.call("PUT", "/repos/other/notes/collaborators/gitquire-bot", {"permission": "admin"}, auth=f.ADMIN)
    _, record, _ = f.call("GET", "/repos/other/notes", auth=f.ADMIN)
    status, detail = h.door_round(alice, "/auth/forgejo/add-wiki?next=%2F")
    check("Two wikis R18", status == 302, f"the Add a wiki round -> {status} {detail}")
    status, addable, _ = call(alice, "GET", "/api/front-door/addable")
    names = [f"{r.get('owner')}/{r.get('name')}" for r in addable.get("repos", [])] if isinstance(addable, dict) else []
    check("Two wikis R18", "team/alpha" in names and "other/notes" not in names,
          f"Add a wiki offers team's repositories and not other/notes -> {names}")
    status, refused, _ = call(alice, "POST", "/api/front-door/wikis", {"id": record.get("id"), "token": os.environ["ALPHA_TOKEN"]})
    check("Two wikis R18", status in (403, 404) and isinstance(refused, dict) and refused.get("error") in ("owner-not-allowed", "not-addable"),
          f"Make this a wiki for other/notes is refused -> {status} {refused}")
    status, page, _ = call(alice, "GET", "/w/other/notes/", accept="text/html")
    check("Two wikis R18", status == 404 and "This server hosts wikis from team" in str(page),
          f"its address says which owners this server hosts -> {status}")
    check("Two wikis R18", start("other"), "the front door restarts with GITQUIRE_ALLOWED_OWNERS=other")
    out = wait_for(lambda: call(alice, "GET", "/w/team/alpha/api/config")[0] == 403, 90)
    status, listed, _ = call(alice, "GET", "/api/front-door/wikis")
    reasons = sorted((w.get("name"), w.get("state"), w.get("reason")) for w in listed.get("wikis", [])) if isinstance(listed, dict) else []
    check("Two wikis R18", out and all(state == "disconnected" and reason == "owner-not-allowed" for _, state, reason in reasons) and len(reasons) == 2,
          f"with team removed from the allowed owners, team's wikis are disconnected -> {reasons}")
    proc = h.docker("exec", NAME, "sh", "-c", "ls /data/wikis | grep -c forgejo-", check_ok=False)
    check("Two wikis R18", proc.stdout.strip() == "2", f"and kept: {proc.stdout.strip()} folders")
    check("Two wikis R18", start("team"), "the front door restarts with team allowed again")
    back = wait_for(lambda: call(alice, "GET", "/w/team/alpha/api/config")[0] == 200, 90)
    check("Two wikis R18", back, "team's wikis are connected again")
    return alice


def stop_pushes(alice):
    status, token = h.agent_token(alice, "r6 agent")
    if token is None:
        check("Two wikis R6", False, f"alice's agent token -> {status}")
        return
    agent = h.Mcp(token)
    agent.start()
    page = f"r6-{int(time.time())}"
    marker = f"written right before docker stop {page}"
    status, result = agent.call("write", {"wiki": "team/alpha", "document": {"path": page, "content": f"# R6\n\n{marker}\n"}})
    check("Two wikis R6", status == 200 and isinstance(result, dict) and not result.get("isError"),
          f"alice's agent writes {page} in alpha -> {status} {h.result_text(result)[:160]}")
    status, _, _ = f.call("GET", f"/repos/team/alpha/contents/{page}.md", auth=f.ADMIN)
    check("Two wikis R6", None, f"on Forgejo before the stop: {status} (404 means not pushed yet)")
    started = time.time()
    h.docker("stop", "-t", "60", NAME)
    took = round(time.time() - started, 1)
    status, body, _ = f.call("GET", f"/repos/team/alpha/contents/{page}.md", auth=f.ADMIN)
    content = base64.b64decode(body.get("content", "")).decode(errors="replace") if isinstance(body, dict) else ""
    check("Two wikis R6", status == 200 and marker in content,
          f"after docker stop ({took} s) the page is on Forgejo -> {status}")


def main():
    check("Two wikis", start(), "the front door starts on the two-wiki volume with short re-check and idle times")
    alpha, beta = key_of("alpha"), key_of("beta")
    alice = sign_in("alice")
    dave = sign_in("dave")
    isolation(alice, dave, alpha, beta)
    drafts(alice, alpha)
    cut_off(dave)
    dave = sign_in("dave")
    sleep_and_wake(alice)
    rename(alice, beta)
    bot_removed(alice, dave, beta)
    host_down(alice, dave)
    alice = owners()
    stop_pushes(alice)
    h.summary()


if __name__ == "__main__":
    main()
