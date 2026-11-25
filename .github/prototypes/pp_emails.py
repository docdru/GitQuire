import os
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import forgejo_rows as f

FORGEJO_CONTAINER = os.environ.get("FORGEJO_CONTAINER", "forgejo")


def summary_of(body):
    if not isinstance(body, list):
        return repr(body)[:200]
    return [
        {"email": item.get("email"), "verified": item.get("verified"), "primary": item.get("primary")}
        for item in body
        if isinstance(item, dict)
    ]


def probe(label, **auth):
    status, body, _ = f.call("GET", "/user/emails", **auth)
    f.record("PP0", None, f"{label}: GET /user/emails -> {status} {summary_of(body)}")
    return status, body


def sso_account():
    added = subprocess.run(
        [
            "docker", "exec", "-u", "git", FORGEJO_CONTAINER, "forgejo", "admin", "auth", "add-oauth",
            "--name", "sso", "--provider", "openidConnect", "--key", "gitquire-probe",
            "--secret", "gitquire-probe-secret",
            "--auto-discover-url", f"{f.BASE}/.well-known/openid-configuration",
        ],
        capture_output=True, text=True,
    )
    f.record("PP0", None, f"OAuth2 source added -> exit {added.returncode} {added.stderr.strip()[:200]}")
    listed = subprocess.run(
        ["docker", "exec", "-u", "git", FORGEJO_CONTAINER, "forgejo", "admin", "auth", "list"],
        capture_output=True, text=True,
    )
    source = None
    for line in listed.stdout.splitlines():
        parts = line.split()
        if len(parts) > 1 and parts[1] == "sso" and parts[0].isdigit():
            source = int(parts[0])
    if source is None:
        f.record("PP0", None, f"no OAuth2 source id in: {listed.stdout.strip()[:300]}")
        return
    status, body, _ = f.call("POST", "/admin/users", {
        "username": "carol", "email": "carol@example.org", "login_name": "carol",
        "source_id": source, "must_change_password": False, "password": f.PASSWORD,
    }, auth=f.ADMIN)
    f.record("PP0", None, f"account attached to the OAuth2 source -> {status} {repr(body)[:160]}")
    probe("account attached to an OAuth2 source (admin acting as carol)", auth=f.ADMIN,
          headers={"Sudo": "carol"})


def main():
    f.make_user("erin")
    status, token = f.make_token("erin", "pp-read-user", ["read:user"])
    if status != 201:
        f.record("PP0", False, f"read:user token for erin -> {status} {token}")
        return
    probe("read:user token, admin-created account", token=token["sha1"])
    status, body, _ = f.call("POST", "/user/emails", {"emails": ["erin.other@example.org"]},
                             auth=("erin", f.PASSWORD))
    f.record("PP0", None, f"second address added by erin -> {status} {summary_of(body)}")
    probe("read:user token after a second address", token=token["sha1"])
    status, narrow = f.make_token("erin", "pp-repo-only", ["read:repository"])
    if status == 201:
        probe("token without read:user", token=narrow["sha1"])
    sso_account()


if __name__ == "__main__":
    main()
