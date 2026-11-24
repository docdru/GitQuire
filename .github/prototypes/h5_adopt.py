import json
import os
import sys
import time
import urllib.error
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

os.environ.setdefault("WIKIS_URL", os.environ.get("GITQUIRE_URL", "http://127.0.0.1:8200"))
os.environ.setdefault("WIKIS_CONTAINER", "gq-adopted")

import forgejo_rows as f
import h5_forgejo as h

IMAGE = "gitquire:ci"
URL = h.GQ
SOURCE, SOURCE_DRAFTS = "gq-h5", "gq-h5-drafts"
COPY, COPY_DRAFTS = "gq-adopt", "gq-adopt-drafts"
STATE = "/tmp/h5-adopt.json"


def base_env():
    return {
        "NODE_EXTRA_CA_CERTS": "/ca/cert.pem", "GIT_SSL_CAINFO": "/ca/cert.pem",
        "PORT": "8200", "GITQUIRE_EXTERNAL_URL": URL,
        "GITQUIRE_HOST": "forgejo", "GITQUIRE_HOST_URL": os.environ["FORGEJO_URL"],
        "GITQUIRE_HOST_CLIENT_ID": os.environ["OAUTH_CLIENT_ID"],
        "GITQUIRE_HOST_CLIENT_SECRET": os.environ["OAUTH_CLIENT_SECRET"],
        "GITQUIRE_HOST_TOKEN": os.environ["BOT_TOKEN"],
        "GITQUIRE_HOST_REPO_TOKEN": os.environ["REPO_TOKEN"],
        "GITQUIRE_REPO": "team/wiki",
        "GITQUIRE_SESSION_SECRET": "0123456789abcdef0123456789abcdef",
    }


def env_args(env):
    args = []
    for name, value in env.items():
        args += ["-e", f"{name}={value}"]
    return args


def volumes(drafts_at):
    return ["-v", f"{COPY}:/data", "-v", f"{COPY_DRAFTS}:{drafts_at}", "-v", "/tmp/ca:/ca:ro"]


def gitquire(*args, wikis=True):
    env = base_env()
    if wikis:
        env["GITQUIRE_WIKIS"] = "on"
    return h.docker("run", "--rm", "--network", "host", *volumes("/.gitquire-drafts"),
                    *env_args(env), "--entrypoint", "gitquire", IMAGE, *args, check_ok=False)


def on_copy(script):
    return h.docker("run", "--rm", *volumes("/.gitquire-drafts"), "--entrypoint", "sh", IMAGE,
                    "-c", script, check_ok=False)


def output(proc):
    return (proc.stdout + proc.stderr).strip()


def wait_forgejo():
    for _ in range(60):
        status, _, _ = f.call("GET", "/version")
        if status == 200:
            return
        time.sleep(2)


def prepare():
    wait_forgejo()
    alice, status, _ = h.sign_in("alice")
    check = h.check
    check("Adopt", status == 302, f"alice signs in to the single wiki before the move -> {status}")
    status, token = h.agent_token(alice, "moved agent", "/auth/agents")
    check("Adopt", token is not None, f"alice creates an agent token in the single wiki -> {status}")
    status, created, _ = h.gq("POST", "/api/gitquire/drafts", alice, {"title": "Moved draft", "open": True})
    slug = created.get("draft", {}).get("slug") if isinstance(created, dict) else None
    check("Adopt", status == 201 and slug is not None, f"alice creates a draft in the single wiki -> {status} {created}")
    made = False
    for _ in range(45):
        h.gq("GET", "/api/config", alice)
        if h.docker("exec", h.CONTAINER, "test", "-d", f"/.gitquire-drafts/data/{slug}/data/.git", check_ok=False).returncode == 0:
            made = True
            break
        time.sleep(2)
    check("Adopt", made, f"opening the draft makes its working copy in /.gitquire-drafts/data/{slug}/data")
    jar = next(handler.cookiejar for handler in alice.handlers if hasattr(handler, "cookiejar"))
    session = next((c.value for c in jar if c.name == "gq_session"), None)
    with open(STATE, "w") as fh:
        json.dump({"token": token, "slug": slug, "session": session}, fh)
    h.summary()


def copy_volumes():
    for source, target in ((SOURCE, COPY), (SOURCE_DRAFTS, COPY_DRAFTS)):
        h.docker("volume", "create", target)
        h.docker("run", "--rm", "-v", f"{source}:/from:ro", "-v", f"{target}:/to", "--entrypoint", "sh",
                 IMAGE, "-c", "cp -a /from/. /to/")


def start(name, wikis):
    env = base_env()
    if wikis:
        env["GITQUIRE_WIKIS"] = "on"
    else:
        env["GITQUIRE_ALLOW_EXTERNAL"] = "1"
    drafts_at = "/drafts-unused" if wikis else "/.gitquire-drafts"
    h.docker("run", "-d", "--name", name, "--network", "host", *volumes(drafts_at), *env_args(env), IMAGE)
    return h.wait_ready(180)


def stop(name):
    h.docker("stop", "-t", "60", name, check_ok=False)


def mcp_reads(token, label, path):
    agent = h.Mcp(token, path)
    status, _ = agent.start()
    status, result = agent.call("exec", {"command": "cat pulled.md"})
    text = h.result_text(result)
    h.check("Adopt", status == 200 and isinstance(result, dict) and not result.get("isError") and "Pulled" in text,
            f"{label}: alice's agent token from before the move reaches the wiki at {path} -> {status} {text[:120]}")


def run():
    wait_forgejo()
    with open(STATE) as fh:
        state = json.load(fh)
    token, slug = state["token"], state["slug"]
    copy_volumes()
    check = h.check

    proc = gitquire("wikis", "adopt", "/data", "--dry-run")
    unchanged = on_copy("test -d /data/.git && test ! -e /data/server && test ! -e /data/wikis")
    check("Adopt", proc.returncode == 0 and "Dry run" in proc.stdout and unchanged.returncode == 0,
          f"a dry run lists the steps and changes nothing -> exit {proc.returncode}: {output(proc)[-400:]}")

    on_copy("echo typed > /data/unpushed-probe.md")
    proc = gitquire("wikis", "adopt", "/data")
    check("Adopt", proc.returncode == 78 and "Not everything is pushed" in output(proc)
          and on_copy("test -d /data/.git").returncode == 0,
          f"an uncommitted file stops the move without --force -> exit {proc.returncode}: {output(proc)[-300:]}")
    on_copy("rm /data/unpushed-probe.md")

    proc = gitquire("wikis", "adopt", "/data")
    check("Adopt", proc.returncode == 0, f"gitquire wikis adopt -> exit {proc.returncode}: {output(proc)[-800:]}")
    status, record, _ = f.call("GET", "/repos/team/wiki", auth=f.ADMIN)
    key = f"forgejo-{record['id']}" if status == 200 else "forgejo-?"
    layout = on_copy(
        f"test -d /data/wikis/{key}/.git && test ! -e /data/.git && ls /data | tr '\\n' ' ' && "
        f"cat /data/server/wikis.json && test -f /data/server/agent-tokens-forgejo.json && "
        f"grep -q '\"{key}\"' /data/server/repo-tokens.json && stat -c %a /data/server/repo-tokens.json")
    check("Adopt", layout.returncode == 0 and '"team"' in layout.stdout and '"wiki"' in layout.stdout
          and layout.stdout.strip().endswith("600"),
          f"checkout in /data/wikis/{key}/, the wiki table, the agent tokens and the wiki's limited token (0600) are in place -> {output(layout)[-600:]}")
    original = on_copy(f"test -d /.gitquire-drafts/data/{slug}/data/.git").returncode == 0
    copied = on_copy(f"test -d /data/wikis/.gitquire-drafts/{key}/{slug}/{key}/.git").returncode == 0
    check("Adopt", copied and original,
          f"draft working copy: original in /.gitquire-drafts/data/{slug}/data {'kept' if original else 'not made by the single wiki'}, "
          f"copy in /data/wikis/.gitquire-drafts/{key}/{slug}/{key} {'made' if copied else 'missing'}")
    env = base_env()
    env["GITQUIRE_ALLOW_EXTERNAL"] = "1"
    proc = h.docker("run", "--rm", "--network", "host", *volumes("/.gitquire-drafts"), *env_args(env), IMAGE,
                    check_ok=False)
    after = on_copy("ls -A /data | tr '\\n' ' '")
    check("Adopt", proc.returncode == 78 and "several wikis" in output(proc) and after.stdout.split() == ["server", "wikis"],
          f"started with GITQUIRE_WIKIS off, the moved volume is refused before anything is written -> exit {proc.returncode}: {output(proc)[-200:]}; /data: {after.stdout.strip()}")
    proc = gitquire("wikis", "adopt", "/data")
    check("Adopt", proc.returncode == 0 and "nothing to do" in proc.stdout,
          f"adopt again changes nothing -> exit {proc.returncode}: {output(proc)[-200:]}")

    ready = start("gq-adopted", True)
    check("Adopt", ready, "the front door starts on the moved volume")
    if state.get("session"):
        kept = urllib.request.Request(URL + "/w/forgejo/team/wiki/auth/me", headers={
            "Accept": "application/json", "Cookie": f"gq_session={state['session']}"})
        try:
            with urllib.request.urlopen(kept, timeout=120) as resp:
                kept_status, kept_body = resp.status, f.parse(resp.read())
        except urllib.error.HTTPError as err:
            kept_status, kept_body = err.code, f.parse(err.read())
        check("Adopt", kept_status == 200 and isinstance(kept_body, dict) and kept_body.get("login") == "alice",
              f"alice's session from the single wiki still works at the front door -> {kept_status}")
    alice = f.web_login("alice")
    status, detail = h.door_round(alice, "/auth/forgejo/login?next=%2F")
    check("Adopt", status == 302, f"alice signs in at the front door -> {status} {detail}")
    status, listed, _ = h.door_call("GET", "/api/front-door/wikis", alice)
    names = [f"{w.get('owner')}/{w.get('name')}" for w in listed.get("wikis", [])] if isinstance(listed, dict) else []
    check("Adopt", status == 200 and names == ["team/wiki"], f"her wiki list holds the moved wiki -> {status} {names}")
    status, me, _ = h.door_call("GET", "/w/forgejo/team/wiki/auth/me", alice)
    check("Adopt", status == 200 and isinstance(me, dict) and me.get("login") == "alice",
          f"/w/forgejo/team/wiki/auth/me -> {status}")
    status, drafts, _ = h.door_call("GET", "/w/forgejo/team/wiki/api/gitquire/drafts", alice)
    check("Adopt", status == 200 and slug in json.dumps(drafts),
          f"the draft made in the single wiki is listed behind the front door -> {status}")
    if token:
        mcp_reads(token, "behind the front door", "/mcp/forgejo")
    stop("gq-adopted")

    proc = gitquire("wikis", "unadopt", "/data", "--dry-run")
    check("Unadopt", proc.returncode == 0 and "Dry run" in proc.stdout
          and on_copy("test -f /data/server/wikis.json").returncode == 0,
          f"a dry run of the way back changes nothing -> exit {proc.returncode}")
    proc = gitquire("wikis", "unadopt", "/data")
    check("Unadopt", proc.returncode == 0, f"gitquire wikis unadopt -> exit {proc.returncode}: {output(proc)[-800:]}")
    layout = on_copy("test -d /data/.git && test ! -e /data/server/wikis.json && "
                     "ls -d /data/.gitquire/local/gitquire/several-wikis-*/server/wikis.json")
    check("Unadopt", layout.returncode == 0,
          f"/data is a single wiki again and the front door's files are kept -> {output(layout)[-300:]}")

    ready = start("gq-unadopted", False)
    check("Unadopt", ready, "the single wiki starts on the volume again")
    alice, status, _ = h.sign_in("alice")
    check("Unadopt", status == 302, f"alice signs in to the single wiki again -> {status}")
    status, drafts, _ = h.gq("GET", "/api/gitquire/drafts", alice)
    check("Unadopt", status == 200 and slug in json.dumps(drafts), f"the draft is still there -> {status}")
    if token:
        mcp_reads(token, "back in the single wiki", "/mcp")
    stop("gq-unadopted")
    h.summary()


if __name__ == "__main__":
    {"prepare": prepare, "run": run}[sys.argv[1]]()
