import base64
import email
import email.policy
import glob
import http.server
import json
import os
import subprocess
import sys
import threading
import time
import urllib.parse
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

os.environ.setdefault("WIKIS_CONTAINER", "gq-pp")

import forgejo_rows as f
import h5_forgejo as h
import h5_two_wikis as t

NAME = "gq-pp"
URL = h.WIKIS
PORT = int(urllib.parse.urlparse(URL).port or 80)
MAIL_DIR = os.environ.get("PP_MAIL_DIR", "/tmp/pp-mail")
FAKE_AI_PORT = 2600
check = h.check


class FakeAnthropic(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        ok = self.path.startswith("/v1/models")
        self.send_response(200 if ok else 404)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(b'{"data":[]}' if ok else b"{}")

    def log_message(self, *args):
        return


def fake_anthropic():
    server = http.server.ThreadingHTTPServer(("127.0.0.1", FAKE_AI_PORT), FakeAnthropic)
    threading.Thread(target=server.serve_forever, daemon=True).start()


def start():
    h.docker("rm", "-f", NAME, check_ok=False)
    env = {
        "NODE_EXTRA_CA_CERTS": "/ca/cert.pem", "GIT_SSL_CAINFO": "/ca/cert.pem",
        "PORT": str(PORT), "GITQUIRE_EXTERNAL_URL": URL,
        "GITQUIRE_WIKIS": "on", "GITQUIRE_HOST_FORGEJO_ALLOWED_OWNERS": "team", "GITQUIRE_HOST_FORGEJO_ADMINS": "alice",
        "GITQUIRE_HOSTS": "forgejo", "GITQUIRE_HOST_FORGEJO_URL": os.environ["FORGEJO_URL"],
        "GITQUIRE_HOST_FORGEJO_CLIENT_ID": os.environ["WIKIS_CLIENT_ID"],
        "GITQUIRE_HOST_FORGEJO_CLIENT_SECRET": os.environ["WIKIS_CLIENT_SECRET"],
        "GITQUIRE_HOST_FORGEJO_TOKEN": os.environ["BOT_TOKEN"],
        "GITQUIRE_SESSION_SECRET": "0123456789abcdef0123456789abcdef",
        "GITQUIRE_ACCESS_CHECK_SECONDS": "15",
        "GITQUIRE_WIKI_IDLE_MINUTES": "1",
        "GITQUIRE_BRANCH_WATCH_SECONDS": "20",
        "GITQUIRE_SMTP_URL": "smtp://127.0.0.1:2525?starttls=off",
        "GITQUIRE_MAIL_FROM": "wiki@example.org",
        "GITQUIRE_ANTHROPIC_BASE_URL": f"http://127.0.0.1:{FAKE_AI_PORT}",
    }
    args = []
    for name, value in env.items():
        args += ["-e", f"{name}={value}"]
    h.docker("run", "-d", "--name", NAME, "--network", "host", "-v", "gq-wikis:/data",
             "-v", "/tmp/ca:/ca:ro", *args, "gitquire:ci")
    return t.wait_for(ready, 180, 1)


def ready():
    try:
        with urllib.request.urlopen(URL + "/readyz", timeout=5) as resp:
            return resp.status == 200
    except Exception:
        return False


def mails():
    out = []
    for path in sorted(glob.glob(os.path.join(MAIL_DIR, "*.eml"))):
        with open(path) as fh:
            raw = fh.read()
        to = raw.split("\n", 1)[0].removeprefix("X-PP-To: ")
        message = email.message_from_string(raw.split("\n", 1)[1], policy=email.policy.default)
        body = message.get_body(preferencelist=("plain",))
        text = body.get_content() if body is not None else ""
        out.append({"to": to, "subject": str(message.get("Subject", "")), "text": text})
    return out


def mails_to(address, needle):
    return [m for m in mails() if m["to"] == address and needle in m["text"]]


def put_page(repo, name, text, auth):
    path = f"mentions/{name}.md"
    status, body, _ = f.call("POST", f"/repos/team/{repo}/contents/{path}", {
        "content": base64.b64encode(text.encode()).decode(), "message": f"mention {name}", "branch": "main",
    }, auth=auth)
    return status


def mention_page(name, day):
    return (
        f"# Mention {name}\n\nThe quarterly numbers look good.\n\n"
        f"[^c-{name.replace('-', '')}]: 💬 on \"quarterly numbers\"\n\n"
        f"    - **@dave** · 2030-01-{day} 10:00 — @alice please look ({name})\n"
    )


def old_format_address():
    status, user, _ = f.call("GET", "/users/dave", auth=f.ADMIN)
    dave_id = user.get("id") if isinstance(user, dict) else None
    alpha = t.key_of("alpha")
    now = time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime())
    state = json.dumps({"version": 1, "users": {str(dave_id): {
        "read": [], "login": "dave", "email": "dave.old@example.org",
        "since": now, "lastSeen": now, "mailed": [],
    }}})
    script = (
        "set -e; f=/data/wikis/%s/.gitquire/local/gitquire/mentions.json; "
        "mkdir -p $(dirname $f); cat > $f; rm -f /data/server/people/moved.json" % alpha
    )
    proc = subprocess.run(["docker", "run", "--rm", "-i", "-v", "gq-wikis:/data", "--entrypoint", "sh",
                           "gitquire:ci", "-c", script], input=state, text=True, capture_output=True)
    return proc.returncode == 0 and dave_id is not None, proc.stderr.strip()[:200]


def main():
    fake_anthropic()
    moved_ok, detail = old_format_address()
    check("PP move", moved_ok, f"dave's confirmed address written into alpha in the old per-wiki format {detail}")
    check("PP", start(), "the front door starts on the two-wiki volume with mail, a short branch check and a fake AI provider")
    alice = t.sign_in("alice")
    dave = t.sign_in("dave")

    status, body, _ = t.call(dave, "GET", "/w/forgejo/team/alpha/api/gitquire/mentions/email")
    check("PP move", status == 200 and isinstance(body, dict) and body.get("use") == "other"
          and body.get("address") == "dave.old@example.org",
          f"after the move dave's old confirmed address is his address for every wiki, switched on -> {status} {body}")

    status, before, _ = t.call(alice, "GET", "/w/forgejo/team/alpha/api/gitquire/mentions/email")
    account = before.get("account", {}) if isinstance(before, dict) else {}
    check("PP P7", status == 200 and account.get("address") == "alice@example.org" and before.get("use") is None,
          f"alice's verified Forgejo address is offered, mail is off -> {status} {before}")
    check("PP P7", mails() == [], f"reading the account address sent nothing: {len(mails())} mails")
    status, on, _ = t.call(alice, "PUT", "/w/forgejo/team/alpha/api/gitquire/mentions/email", {"use": "account"})
    check("PP switch", status == 200 and on.get("address") == "alice@example.org", f"one switch in alpha -> {status} {on}")
    status, inbeta, _ = t.call(alice, "GET", "/w/forgejo/team/beta/api/gitquire/mentions/email")
    check("PP switch", status == 200 and inbeta.get("use") == "account", f"the same answer in beta -> {status} {inbeta}")
    status, other, _ = t.call(dave, "GET", "/w/forgejo/team/alpha/api/gitquire/mentions/email")
    check("PP P1", "alice@example.org" not in json.dumps(other), "dave's answer does not carry alice's address")

    asleep = t.wait_for(lambda: not t.editors(), 240, 5)
    check("PP sleep", asleep, f"both wiki processes are asleep before the pushes: {t.editors()}")
    a = put_page("alpha", "alpha-1", mention_page("alpha-1", "01"), ("dave", f.PASSWORD))
    b = put_page("beta", "beta-1", mention_page("beta-1", "02"), f.ADMIN)
    check("PP mail", a == 201 and b == 201, f"mentions of alice pushed to alpha and beta through Git -> {a} {b}")
    both = t.wait_for(lambda: mails_to("alice@example.org", "alpha-1") and mails_to("alice@example.org", "beta-1"), 300, 5)
    subjects = [m["subject"] for m in mails() if m["to"] == "alice@example.org"]
    check("PP mail", bool(both), f"both mentions are mailed to the one address, the sleeping wikis woken by the branch check: {subjects}")
    check("PP mail", any("team/alpha" in s for s in subjects) and any("team/beta" in s for s in subjects),
          f"each mail names its wiki: {subjects}")

    status, _, _ = f.call("DELETE", "/repos/team/beta/collaborators/alice", auth=f.ADMIN)
    check("PP P3", status == 204, f"alice removed from team/beta -> {status}")
    time.sleep(20)
    put_page("beta", "beta-2", mention_page("beta-2", "03"), f.ADMIN)
    put_page("alpha", "alpha-2", mention_page("alpha-2", "05"), ("dave", f.PASSWORD))
    got = t.wait_for(lambda: mails_to("alice@example.org", "alpha-2"), 300, 5)
    time.sleep(90)
    check("PP P3", bool(got) and not mails_to("alice@example.org", "beta-2"),
          f"the alpha mention is mailed, the beta mention is not: {[m['subject'] for m in mails()]}")
    f.call("PUT", "/repos/team/beta/collaborators/alice", {"permission": "admin"}, auth=f.ADMIN)

    key = "sk-ant-api03-" + "k" * 40
    status, saved, _ = t.call(alice, "PUT", "/w/forgejo/team/alpha/api/gitquire/chat/keys/claude", {"key": key})
    check("PP P8", status == 200 and key not in json.dumps(saved), f"alice saves an AI key in alpha -> {status} {saved}")
    status, overview, _ = t.call(alice, "GET", "/w/forgejo/team/beta/api/gitquire/chat")
    claude = next((p for p in overview.get("providers", []) if p.get("id") == "claude"), {}) if isinstance(overview, dict) else {}
    check("PP P8", status == 200 and claude.get("key", {}).get("configured") is True,
          f"the key works in beta too -> {status} {claude.get('key')}")
    env = h.docker("exec", NAME, "sh", "-c", "cat /proc/[0-9]*/environ 2>/dev/null | tr '\\0' '\\n'", check_ok=False).stdout
    check("PP P8", key not in env and "GITQUIRE_CHAT_KEY_SECRET" not in env, "no process environment holds the key or a chat key secret")
    disk = h.docker("exec", NAME, "sh", "-c", f"grep -rl '{key}' /data || true", check_ok=False).stdout.strip()
    check("PP P8", disk == "", f"the key is nowhere on the volume unsealed: {disk or 'none'}")

    logs = h.docker("logs", NAME, check_ok=False)
    check("PP P1", "alice@example.org" not in (logs.stdout + logs.stderr), "the address is not in the front door's log")
    h.docker("stop", "-t", "60", NAME, check_ok=False)
    h.summary()


if __name__ == "__main__":
    main()
