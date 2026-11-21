import base64
import html.parser
import http.cookiejar
import json
import os
import shutil
import subprocess
import sys
import tempfile
import urllib.error
import urllib.parse
import urllib.request

BASE = os.environ.get("FORGEJO_URL", "http://127.0.0.1:3000").rstrip("/")
API = BASE + "/api/v1"
ADMIN = ("root", os.environ.get("FORGEJO_ADMIN_PASSWORD", "root-password-1"))
PASSWORD = "user-password-1"
CALLBACK = "http://127.0.0.1:9999/auth/github/callback"
NO_REPLY = os.environ.get("FORGEJO_NO_REPLY", "noreply.example.org")

rows = {}
notes = []


def record(row, passed, detail):
    rows.setdefault(row, []).append((passed, detail))
    mark = "PASS" if passed else ("INFO" if passed is None else "FAIL")
    print(f"[{row}] {mark}: {detail}", flush=True)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def call(method, path, body=None, auth=None, token=None, form=None, opener=None, headers=None):
    url = path if path.startswith("http") else API + path
    data = None
    hdrs = {"Accept": "application/json"}
    if headers:
        hdrs.update(headers)
    if body is not None:
        data = json.dumps(body).encode()
        hdrs["Content-Type"] = "application/json"
    if form is not None:
        data = urllib.parse.urlencode(form).encode()
        hdrs["Content-Type"] = "application/x-www-form-urlencoded"
    if auth:
        hdrs["Authorization"] = "Basic " + base64.b64encode(f"{auth[0]}:{auth[1]}".encode()).decode()
    if token:
        hdrs["Authorization"] = "token " + token
    req = urllib.request.Request(url, data=data, method=method, headers=hdrs)
    op = opener or urllib.request.build_opener(NoRedirect)
    try:
        with op.open(req, timeout=30) as resp:
            raw = resp.read()
            return resp.status, parse(raw), dict(resp.headers)
    except urllib.error.HTTPError as err:
        raw = err.read()
        return err.code, parse(raw), dict(err.headers)
    except Exception as err:
        return 0, str(err), {}


def parse(raw):
    try:
        return json.loads(raw)
    except Exception:
        return raw.decode(errors="replace")


def git(args, cwd, env=None, check=False):
    full_env = {**os.environ, "GIT_TERMINAL_PROMPT": "0", **(env or {})}
    proc = subprocess.run(["git", *args], cwd=cwd, env=full_env, capture_output=True, text=True)
    if check and proc.returncode != 0:
        raise RuntimeError(f"git {' '.join(args)}: {proc.stderr}")
    return proc


def make_user(name, admin=False):
    status, body, _ = call("POST", "/admin/users", {
        "username": name, "email": f"{name}@example.org", "password": PASSWORD,
        "must_change_password": False, "admin": admin,
    }, auth=ADMIN)
    if status not in (201, 422):
        raise RuntimeError(f"create user {name}: {status} {body}")
    return name


def make_token(user, name, scopes, repositories=None):
    payload = {"name": name, "scopes": scopes}
    if repositories is not None:
        payload["repositories"] = repositories
    status, body, _ = call("POST", f"/users/{user}/tokens", payload, auth=(user, PASSWORD))
    return status, body


class FormParser(html.parser.HTMLParser):
    def __init__(self):
        super().__init__()
        self.forms = []
        self.current = None

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag == "form":
            self.current = {"action": a.get("action", ""), "inputs": {}}
            self.forms.append(self.current)
        elif tag in ("input", "button") and self.current is not None and a.get("name"):
            if a.get("type") in ("hidden", None, "text", "submit") or tag == "button":
                self.current["inputs"].setdefault(a["name"], a.get("value", ""))

    def handle_endtag(self, tag):
        if tag == "form":
            self.current = None


def forms_of(html_text):
    p = FormParser()
    p.feed(html_text)
    return p.forms


def browser():
    jar = http.cookiejar.CookieJar()
    return urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar), NoRedirect)


def get_html(op, url):
    req = urllib.request.Request(url, headers={"Accept": "text/html"})
    try:
        with op.open(req, timeout=30) as resp:
            return resp.status, resp.read().decode(errors="replace"), dict(resp.headers)
    except urllib.error.HTTPError as err:
        return err.code, err.read().decode(errors="replace"), dict(err.headers)


def post_form(op, url, form):
    req = urllib.request.Request(url, data=urllib.parse.urlencode(form).encode(), method="POST",
                                 headers={"Content-Type": "application/x-www-form-urlencoded", "Accept": "text/html"})
    try:
        with op.open(req, timeout=30) as resp:
            return resp.status, resp.read().decode(errors="replace"), dict(resp.headers)
    except urllib.error.HTTPError as err:
        return err.code, err.read().decode(errors="replace"), dict(err.headers)


def web_login(user):
    op = browser()
    _, page, _ = get_html(op, BASE + "/user/login")
    form = next((f for f in forms_of(page) if "login" in f["action"]), None)
    if form is None:
        raise RuntimeError("no login form")
    fields = dict(form["inputs"])
    fields.update({"user_name": user, "password": PASSWORD})
    status, _, headers = post_form(op, BASE + "/user/login", fields)
    if status not in (302, 303):
        raise RuntimeError(f"login {user}: {status}")
    return op


def authorize(op, client_id, scope, state):
    params = {"client_id": client_id, "redirect_uri": CALLBACK, "response_type": "code", "state": state}
    if scope:
        params["scope"] = scope
    query = urllib.parse.urlencode(params)
    return get_html(op, BASE + "/login/oauth/authorize?" + query)


def code_from(location):
    q = urllib.parse.parse_qs(urllib.parse.urlparse(location).query)
    return q.get("code", [None])[0], q.get("state", [None])[0]


def setup():
    status, body, _ = call("GET", "/version")
    record("R17", status == 200, f"GET /version -> {status} {body}")
    version = body.get("version", "") if isinstance(body, dict) else ""
    for name in ("alice", "bob", "carol", "dave", "gitquire-bot"):
        make_user(name)
    call("POST", "/orgs", {"username": "team", "visibility": "private"}, auth=ADMIN)
    for repo in ("wiki", "wiki-b"):
        status, body, _ = call("POST", "/orgs/team/repos", {
            "name": repo, "private": True, "auto_init": True, "default_branch": "main",
        }, auth=ADMIN)
        if status not in (201, 409):
            raise RuntimeError(f"create repo {repo}: {status} {body}")
    for user, perm in (("alice", "admin"), ("bob", "write")):
        call("PUT", f"/repos/team/wiki/collaborators/{user}", {"permission": perm}, auth=ADMIN)
    status, team, _ = call("POST", "/orgs/team/teams", {
        "name": "editors", "permission": "write", "includes_all_repositories": False,
        "units": ["repo.code", "repo.pulls", "repo.issues"],
        "units_map": {"repo.code": "write", "repo.pulls": "write", "repo.issues": "write"},
    }, auth=ADMIN)
    team_id = team.get("id") if isinstance(team, dict) else None
    if team_id:
        call("PUT", f"/teams/{team_id}/members/carol", auth=ADMIN)
        call("PUT", f"/teams/{team_id}/repos/team/wiki", auth=ADMIN)
    return version, team_id


def f1(scope="read:user", app_name="GitQuire", user="bob"):
    status, app, _ = call("POST", "/user/applications/oauth2", {
        "name": app_name, "redirect_uris": [CALLBACK], "confidential_client": True,
    }, auth=ADMIN)
    if status != 201:
        record("F1", False, f"create OAuth application -> {status} {app}")
        return None
    client_id, secret = app["client_id"], app["client_secret"]
    record("F1", None, f"--- scope {scope!r}, person {user}")
    op = web_login(user)
    status, page, headers = authorize(op, client_id, scope, "s1")
    location = headers.get("Location", "")
    if status == 200:
        grant = next((f for f in forms_of(page) if "grant" in f["action"]), None)
        if grant is None:
            record("F1", False, f"first authorize -> 200 without a grant form")
            return None
        fields = dict(grant["inputs"])
        fields["granted"] = "true"
        status, _, headers = post_form(op, BASE + "/login/oauth/grant", fields)
        location = headers.get("Location", "")
        record("F1", None, f"first authorize shows a consent page; grant -> {status}")
    code, state = code_from(location)
    record("F1", bool(code) and state == "s1", f"first sign-in redirect to callback with a code: {bool(code)}, state kept: {state == 's1'}")
    status, tok, _ = call("POST", BASE + "/login/oauth/access_token", form={
        "client_id": client_id, "client_secret": secret, "code": code or "",
        "grant_type": "authorization_code", "redirect_uri": CALLBACK,
    })
    token = tok.get("access_token") if isinstance(tok, dict) else None
    record("F1", bool(token), f"code exchange (form body, Accept json) -> {status}, token_type {tok.get('token_type') if isinstance(tok, dict) else tok}, scope {tok.get('scope') if isinstance(tok, dict) else ''}")
    if not token:
        return None
    for scheme in ("token", "Bearer"):
        s, me, _ = call("GET", "/user", headers={"Authorization": f"{scheme} {token}"})
        record("F1", s == 200 and isinstance(me, dict) and me.get("login") == user,
               f"GET /api/v1/user with '{scheme}' -> {s}, fields id/login/full_name/avatar_url/email present: "
               f"{all(k in me for k in ('id', 'login', 'full_name', 'avatar_url', 'email')) if isinstance(me, dict) else False}")
    s, repo, _ = call("GET", "/repos/team/wiki", headers={"Authorization": f"Bearer {token}"})
    perms = repo.get("permissions") if isinstance(repo, dict) else None
    record("F1", s == 200 and perms and perms.get("push") is True,
           f"GET /repos/team/wiki as {user} -> {s}, permissions {perms}")
    s, created, _ = call("POST", "/user/repos", {"name": "made-with-signin-token", "private": True},
                         headers={"Authorization": f"Bearer {token}"})
    record("F1", None, f"sign-in token asked for {scope}; creating a repo with it -> {s} "
           f"({'token is NOT limited' if s == 201 else 'token is limited'})")
    status, page, headers = authorize(op, client_id, scope, "s2")
    code2, state2 = code_from(headers.get("Location", ""))
    record("F1", status in (302, 303) and bool(code2),
           f"second authorize for an approved application -> {status}, silent redirect with code: {bool(code2)}")
    return {"client_id": client_id, "secret": secret}


def f2_to_f6(bot_token, tmp):
    results = {}
    for user in ("gitquire-bot", "x-access-token", "oauth2", "anything"):
        url = BASE.replace("://", f"://{user}:{bot_token}@") + "/team/wiki.git"
        p = git(["ls-remote", url], tmp)
        results[user] = p.returncode == 0
    record("F2", any(results.values()), f"git ls-remote with the bot token as password, per user name: {results}")
    work = os.path.join(tmp, "work")
    user = next((u for u, ok in results.items() if ok), "gitquire-bot")
    auth = base64.b64encode(f"{user}:{bot_token}".encode()).decode()
    header_env = {"GIT_CONFIG_COUNT": "1", "GIT_CONFIG_KEY_0": "http.extraHeader",
                  "GIT_CONFIG_VALUE_0": f"Authorization: Basic {auth}"}
    p = git(["clone", BASE + "/team/wiki.git", work], tmp, header_env)
    record("F2", p.returncode == 0, f"clone with the token in an Authorization header (as GitQuire sends it), user '{user}' -> {p.returncode} {p.stderr.strip()[-200:]}")
    if p.returncode != 0:
        return None
    git(["config", "user.name", "Bob"], work)
    git(["config", "user.email", f"bob@{NO_REPLY}"], work)
    with open(os.path.join(work, "index.md"), "w") as fh:
        fh.write("# Index\n\nThe quarterly numbers look good.\n")
    git(["add", "."], work)
    git(["commit", "-m", "Add index"], work)
    p = git(["push", "origin", "HEAD:main"], work, header_env)
    record("F2", p.returncode == 0, f"push to main -> {p.returncode} {p.stderr.strip()[-200:]}")
    status, commit, _ = call("GET", f"/repos/team/wiki/git/commits/{git(['rev-parse', 'HEAD'], work).stdout.strip()}", auth=ADMIN)
    linked = commit.get("author") if isinstance(commit, dict) else None
    record("F6", bool(linked) and linked.get("login") == "bob",
           f"commit authored as bob@{NO_REPLY}: linked to account {linked.get('login') if linked else None}, avatar {bool(linked and linked.get('avatar_url'))}")
    git(["config", "user.email", "bob@example.org"], work)
    with open(os.path.join(work, "plain.md"), "w") as fh:
        fh.write("plain\n")
    git(["add", "."], work)
    git(["commit", "-m", "Commit with the account email"], work)
    git(["push", "origin", "HEAD:main"], work, header_env)
    status, commit, _ = call("GET", f"/repos/team/wiki/git/commits/{git(['rev-parse', 'HEAD'], work).stdout.strip()}", auth=ADMIN)
    linked = commit.get("author") if isinstance(commit, dict) else None
    record("F6", None, f"for comparison, commit with the account's own email: linked to {linked.get('login') if linked else None}")
    return work, header_env


def f3(bot_token, work, header_env):
    tok = {"token": bot_token}

    def branch(name, content):
        git(["checkout", "-q", "-B", name, "origin/main"], work)
        with open(os.path.join(work, "index.md"), "w") as fh:
            fh.write(content)
        git(["commit", "-qam", f"Edit on {name}"], work)
        return git(["push", "-q", "origin", f"HEAD:refs/heads/{name}"], work, header_env)

    git(["fetch", "-q", "origin"], work, header_env)
    p1 = branch("draft/one", "# Index\n\nLine from draft one.\n")
    p2 = branch("draft/two", "# Index\n\nLine from draft two.\n")
    record("F3", p1.returncode == 0 and p2.returncode == 0, "branches created through Git push")
    s, pr1, _ = call("POST", "/repos/team/wiki/pulls", {"head": "draft/one", "base": "main", "title": "Draft one"}, **tok)
    s2, pr2, _ = call("POST", "/repos/team/wiki/pulls", {"head": "draft/two", "base": "main", "title": "Draft two"}, **tok)
    record("F3", s == 201 and s2 == 201, f"create pull requests -> {s}, {s2}")
    if s != 201 or s2 != 201:
        return
    n1, n2 = pr1["number"], pr2["number"]
    s, body, _ = call("GET", "/repos/team/wiki/pulls?state=open&head=team:draft/one", **tok)
    heads = [p["head"]["ref"] for p in body] if isinstance(body, list) else body
    record("F3", None, f"list pulls with head=team:draft/one -> {s}, heads returned {heads} (filter honoured: {heads == ['draft/one']})")
    s, body, _ = call("POST", f"/repos/team/wiki/pulls/{n1}/merge", {
        "Do": "squash", "MergeTitleField": "Publish draft one", "MergeMessageField": "",
        "delete_branch_after_merge": False,
    }, **tok)
    record("F3", s == 200, f"squash merge with a title -> {s} {body if s != 200 else ''}")
    s, merged, _ = call("GET", f"/repos/team/wiki/pulls/{n1}", **tok)
    record("F3", isinstance(merged, dict) and merged.get("merged") is True,
           f"pull request reads merged: {merged.get('merged') if isinstance(merged, dict) else merged}, merge commit {merged.get('merge_commit_sha') if isinstance(merged, dict) else ''}")
    s, cm, _ = call("GET", "/repos/team/wiki/commits?sha=main&limit=1", **tok)
    title = cm[0]["commit"]["message"].splitlines()[0] if isinstance(cm, list) and cm else cm
    record("F3", title == "Publish draft one", f"squash commit title on main: {title!r}")
    s, body, _ = call("GET", f"/repos/team/wiki/pulls/{n2}", **tok)
    record("F3", None, f"conflicting pull request reads mergeable={body.get('mergeable') if isinstance(body, dict) else body}")
    s, body, _ = call("POST", f"/repos/team/wiki/pulls/{n2}/merge", {"Do": "squash", "MergeTitleField": "Publish draft two"}, **tok)
    record("F3", s in (405, 409), f"merging the conflicting pull request -> {s} {str(body)[:160]}")
    s, body, _ = call("POST", f"/repos/team/wiki/pulls/{n1}/merge", {"Do": "squash", "MergeTitleField": "again"}, **tok)
    record("F3", None, f"merging an already merged pull request -> {s} {str(body)[:160]}")
    s, body, _ = call("PATCH", f"/repos/team/wiki/pulls/{n2}", {"state": "closed"}, **tok)
    record("F3", s == 201 and isinstance(body, dict) and body.get("state") == "closed", f"close a pull request -> {s} state {body.get('state') if isinstance(body, dict) else body}")
    for name in ("draft/one", "draft/two"):
        s, body, _ = call("DELETE", f"/repos/team/wiki/branches/{urllib.parse.quote(name, safe='')}", **tok)
        record("F3", s == 204, f"delete branch {name} through the API -> {s}")
    p = git(["push", "-q", "origin", "--delete", "draft/none"], work, header_env)
    record("F3", None, f"delete a missing branch through Git -> exit {p.returncode}")


def f4_f8_f9(team_id):
    statuses = {}
    s, bot_tok_body = make_token("gitquire-bot", "f4", ["write:repository", "read:user", "read:organization"])
    bot_token = bot_tok_body.get("sha1") if isinstance(bot_tok_body, dict) else None
    call("PUT", "/repos/team/wiki/collaborators/gitquire-bot", {"permission": "write"}, auth=ADMIN)
    for who in ("bob", "dave", "carol"):
        s, body, _ = call("GET", f"/repos/team/wiki/collaborators/{who}/permission", token=bot_token)
        statuses[f"writer asks {who}"] = (s, body.get("permission") if isinstance(body, dict) else str(body)[:80])
    record("F4", statuses["writer asks bob"][0] == 403, f"bot as writer: {statuses}")
    call("PUT", "/repos/team/wiki/collaborators/gitquire-bot", {"permission": "admin"}, auth=ADMIN)
    admin_statuses = {}
    for who in ("bob", "alice", "dave", "carol", "nobody-such-user"):
        s, body, _ = call("GET", f"/repos/team/wiki/collaborators/{who}/permission", token=bot_token)
        admin_statuses[who] = (s, body.get("permission") if isinstance(body, dict) else str(body)[:80])
    ok = admin_statuses["bob"] == (200, "write") and admin_statuses["alice"] == (200, "admin")
    record("F4", ok, f"bot as repo admin: {admin_statuses}")
    s, repo, _ = call("GET", "/repos/team/wiki", token=bot_token)
    owner = repo.get("owner", {}) if isinstance(repo, dict) else {}
    record("R18", s == 200 and isinstance(owner.get("id"), int),
           f"repo record carries owner id {owner.get('id')} (login {owner.get('login')}), repo id {repo.get('id') if isinstance(repo, dict) else None}")
    if isinstance(repo, dict):
        s, by_id, _ = call("GET", f"/repositories/{repo['id']}", token=bot_token)
        record("R10", s == 200 and by_id.get("full_name") == "team/wiki", f"GET /repositories/{{id}} -> {s} {by_id.get('full_name') if isinstance(by_id, dict) else by_id}")
    op = web_login("carol")
    s, carol_tok = make_token("carol", "f8", ["read:repository", "read:user"])
    ct = carol_tok.get("sha1") if isinstance(carol_tok, dict) else None
    s, repo, _ = call("GET", "/repos/team/wiki", token=ct)
    perms = repo.get("permissions") if isinstance(repo, dict) else None
    sign_in_sees = s == 200 and perms and perms.get("push") is True
    record("F8", sign_in_sees, f"carol (team member only): sign-in check GET repo -> {s}, permissions {perms}")
    bot_sees = admin_statuses["carol"][1] in ("write", "admin")
    record("F8", bot_sees, f"carol: bot re-check -> {admin_statuses['carol']}")
    s, collabs, _ = call("GET", "/repos/team/wiki/collaborators?limit=50", token=bot_token)
    logins = [c["login"] for c in collabs] if isinstance(collabs, list) else collabs
    record("F8", None, f"collaborators list -> {s} {logins}; includes carol: {'carol' in logins if isinstance(logins, list) else False}"
           + ("" if isinstance(logins, list) and "carol" in logins else " (people list must fall back to people who have signed in)"))
    return bot_token


def f9(bot_token, tmp):
    call("DELETE", "/repos/team/wiki/collaborators/gitquire-bot", auth=ADMIN)
    s1, _, _ = call("GET", "/repos/team/wiki", token=bot_token)
    s2, b2, _ = call("GET", "/repos/team/wiki/collaborators/bob/permission", token=bot_token)
    p = git(["ls-remote", BASE.replace("://", f"://gitquire-bot:{bot_token}@") + "/team/wiki.git"], tmp)
    record("F9", None, f"bot removed from the repo: GET repo -> {s1}, permission -> {s2}, git ls-remote exit {p.returncode} ({p.stderr.strip()[-120:]})")
    s, tokens, _ = call("GET", "/users/gitquire-bot/tokens", auth=("gitquire-bot", PASSWORD))
    for t in tokens if isinstance(tokens, list) else []:
        call("DELETE", f"/users/gitquire-bot/tokens/{t['id']}", auth=("gitquire-bot", PASSWORD))
    s3, _, _ = call("GET", "/user", token=bot_token)
    s4, _, _ = call("GET", "/repos/team/wiki-b", token=bot_token)
    p = git(["ls-remote", BASE.replace("://", f"://gitquire-bot:{bot_token}@") + "/team/wiki.git"], tmp)
    record("F9", None, f"bot token revoked: GET /user -> {s3}, GET repo -> {s4}, git ls-remote exit {p.returncode}")
    s5, _, _ = call("GET", "/repos/team/wiki", headers={})
    record("F9", None, f"for comparison, no token at all on the private repo -> {s5}")
    distinct = s3 == 401 and s1 in (403, 404)
    record("F9", distinct, "refused (401 revoked token; 403/404 removed bot) is distinct from unreachable (no HTTP status)")


def f5():
    s, spec, _ = call("GET", BASE + "/swagger.v1.json")
    schema = spec.get("definitions", {}).get("CreateAccessTokenOption", {}) if isinstance(spec, dict) else {}
    props = sorted(schema.get("properties", {}).keys())
    record("F5", None, f"CreateAccessTokenOption fields: {props}")
    field = next((p for p in props if "repo" in p), None)
    if field is None:
        record("F5", False, "no repository field on token creation in this version's API description")
        return None
    s, wiki = call("GET", "/repos/team/wiki", auth=ADMIN)[:2]
    call("PUT", "/repos/team/wiki/collaborators/gitquire-bot", {"permission": "admin"}, auth=ADMIN)
    call("PUT", "/repos/team/wiki-b/collaborators/gitquire-bot", {"permission": "admin"}, auth=ADMIN)
    item_schema = schema["properties"][field].get("items", {})
    if "$ref" in item_schema:
        ref = item_schema["$ref"].split("/")[-1]
        rprops = sorted(spec["definitions"].get(ref, {}).get("properties", {}).keys())
        record("F5", None, f"{field} items are {ref} with fields {rprops}")
        value = [{k: ("team" if k == "owner" else "wiki") for k in rprops if k in ("owner", "name")}]
    else:
        value = ["team/wiki"]
    s, body = make_token("gitquire-bot", "f5", ["write:repository", "read:user"], None)
    payload = {"name": "f5-limited", "scopes": ["write:repository"], field: value}
    s, body, _ = call("POST", "/users/gitquire-bot/tokens", payload, auth=("gitquire-bot", PASSWORD))
    token = body.get("sha1") if isinstance(body, dict) else None
    record("F5", s == 201 and bool(token), f"create a token limited to team/wiki ({field}={value}) -> {s} {'' if token else body}")
    if not token:
        return None
    s, full = make_token("gitquire-bot", "f10-unlimited", ["write:repository", "read:user"])
    f10(token, full.get("sha1") if isinstance(full, dict) else "")
    tmp = tempfile.mkdtemp()
    try:
        ok = git(["ls-remote", BASE.replace("://", f"://gitquire-bot:{token}@") + "/team/wiki.git"], tmp).returncode == 0
        other = git(["ls-remote", BASE.replace("://", f"://gitquire-bot:{token}@") + "/team/wiki-b.git"], tmp).returncode == 0
        record("F5", ok and not other, f"limited token: Git on team/wiki {ok}, on team/wiki-b {other}")
        s1, _, _ = call("GET", "/repos/team/wiki/collaborators/bob/permission", token=token)
        s2, _, _ = call("POST", "/repos/team/wiki/pulls", {"head": "main", "base": "main", "title": "x"}, token=token)
        s3, _, _ = call("GET", "/repos/team/wiki/pulls?state=all", token=token)
        s4, _, _ = call("GET", "/repos/team/wiki-b", token=token)
        s5, c5, _ = call("GET", "/repos/team/wiki-b/contents/README.md", token=token)
        s6, _, _ = call("POST", "/repos/team/wiki-b/pulls", {"head": "main", "base": "main", "title": "x"}, token=token)
        s7, _, _ = call("GET", "/repos/team/wiki/collaborators/bob/permission", auth=("gitquire-bot", PASSWORD))
        record("F5", None, f"limited token on the OTHER repo: GET repo -> {s4}, GET file contents -> {s5}, create pull request -> {s6}; "
               f"the same permission check with the bot's password (unlimited) -> {s7}")
        record("F5", s1 == 200 and s3 == 200 and s4 in (403, 404),
               f"limited token: permission check -> {s1}, pull request create (same branch, expect 422) -> {s2}, list pulls -> {s3}, other repo -> {s4}")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    return token


def f10(limited, unlimited):
    tmp = tempfile.mkdtemp()
    try:
        auth = base64.b64encode(f"gitquire-bot:{limited}".encode()).decode()
        env = {"GIT_CONFIG_COUNT": "1", "GIT_CONFIG_KEY_0": "http.extraHeader",
               "GIT_CONFIG_VALUE_0": f"Authorization: Basic {auth}"}
        work = os.path.join(tmp, "w")
        p = git(["clone", "-q", BASE + "/team/wiki.git", work], tmp, env)
        if p.returncode != 0:
            record("F10", False, f"clone with the limited token -> {p.returncode} {p.stderr.strip()[-160:]}")
            return
        git(["config", "user.name", "Bob"], work)
        git(["config", "user.email", f"bob@{NO_REPLY}"], work)
        tok = {"token": limited}
        made = {}
        for name, text in (("draft/limited-one", "one"), ("draft/limited-two", "two"), ("draft/limited-three", "three")):
            git(["checkout", "-q", "-B", name, "origin/main"], work)
            with open(os.path.join(work, f"{name.split('/')[1]}.md"), "w") as fh:
                fh.write(f"Draft {text}\n")
            git(["add", "."], work)
            git(["commit", "-qm", f"Draft {text}"], work)
            pushed = git(["push", "-q", "origin", f"HEAD:refs/heads/{name}"], work, env).returncode == 0
            s, pr, _ = call("POST", "/repos/team/wiki/pulls", {"head": name, "base": "main", "title": f"Draft {text}"}, **tok)
            made[name] = pr.get("number") if s == 201 and isinstance(pr, dict) else None
            record("F10", pushed and s == 201, f"limited token: push branch {name} -> {pushed}, open pull request -> {s}")
        one, two, three = (made[k] for k in ("draft/limited-one", "draft/limited-two", "draft/limited-three"))
        if one:
            s, body, _ = call("POST", f"/repos/team/wiki/pulls/{one}/merge", {
                "Do": "squash", "MergeTitleField": "Publish limited one", "delete_branch_after_merge": False}, **tok)
            s2, pr, _ = call("GET", f"/repos/team/wiki/pulls/{one}", **tok)
            merged = isinstance(pr, dict) and pr.get("merged") is True
            s3, cm, _ = call("GET", "/repos/team/wiki/commits?sha=main&limit=1", **tok)
            title = cm[0]["commit"]["message"].splitlines()[0] if isinstance(cm, list) and cm else cm
            record("F10", s == 200 and merged and title == "Publish limited one",
                   f"limited token: squash merge with a title -> {s} {'' if s == 200 else str(body)[:160]}; reads merged {merged}; title on main {title!r}")
        if two:
            s, body, _ = call("PATCH", f"/repos/team/wiki/pulls/{two}", {"state": "closed"}, **tok)
            record("F10", s == 201 and isinstance(body, dict) and body.get("state") == "closed",
                   f"limited token: close a pull request -> {s} state {body.get('state') if isinstance(body, dict) else str(body)[:120]}")
        for name in ("draft/limited-one", "draft/limited-two"):
            s, body, _ = call("DELETE", f"/repos/team/wiki/branches/{urllib.parse.quote(name, safe='')}", **tok)
            record("F10", s == 204, f"limited token: delete branch {name} through the API -> {s} {'' if s == 204 else str(body)[:120]}")
        p = git(["push", "-q", "origin", "--delete", "draft/limited-three"], work, env)
        record("F10", p.returncode == 0, f"limited token: delete branch draft/limited-three through Git -> exit {p.returncode} {p.stderr.strip()[-120:]}")
        s, body, _ = call("GET", "/repos/team/wiki/collaborators?limit=50", **tok)
        record("F10", None, f"limited token: collaborators list (people for @mentions) -> {s}")
        s, body, _ = call("GET", "/repos/team/wiki", **tok)
        record("F10", None, f"limited token: repo record (clone address, default branch) -> {s} default_branch {body.get('default_branch') if isinstance(body, dict) else ''}")
        for label, kw in (("unlimited token", {"token": unlimited}), ("limited token", tok)):
            s, body, _ = call("POST", "/users/gitquire-bot/tokens", {
                "name": f"minted-by-{label.split()[0]}", "scopes": ["write:repository"],
                "repositories": [{"owner": "team", "name": "wiki-b"}]}, **kw)
            record("F10", None, f"create a repository-limited token with the bot's {label} (no password) -> {s} {'' if s == 201 else str(body)[:160]}")
        s, body, _ = call("POST", "/users/gitquire-bot/tokens", {
            "name": "minted-by-site-admin", "scopes": ["write:repository"],
            "repositories": [{"owner": "team", "name": "wiki-b"}]}, auth=ADMIN, headers={"Sudo": "gitquire-bot"})
        record("F10", None, f"create one as site admin acting as the bot (Sudo header, admin password) -> {s} {'' if s == 201 else str(body)[:160]}")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def f7(token):
    page = ("# Page\n\nThe quarterly numbers[^c-7f3a] look good.\n\n"
            "```mermaid\ngraph TD; A-->B\n```\n\n"
            "Inline math $a^2+b^2=c^2$ and a block:\n\n$$\n\\int_0^1 x\\,dx\n$$\n\n"
            "Typed link [[Meeting notes]] and a task:\n\n- [ ] Prepare the agenda\n\n"
            "[^c-7f3a]: 💬 on \"quarterly numbers\"\n\n"
            "    - **@alice** · 2026-11-14 10:32 — Where do these come from?\n"
            "    - **@bob** · 2026-11-14 11:02 — From the Q3 controlling export.\n")
    s, body, _ = call("POST", "/markdown", {"Text": page, "Mode": "gfm", "Context": "team/wiki", "Wiki": False}, auth=ADMIN)
    out = body if isinstance(body, str) else str(body)
    checks = {
        "footnote mark": 'href="#fn:user-content-c-7f3a"' in out,
        "footnote thread text": "Where do these come from" in out,
        "thread list kept as list": "<li>" in out and "@alice" in out,
        "mermaid block marked": "mermaid" in out,
        "inline math marked": "language-math" in out and "a^2" in out,
        "block math source kept": "\\int_0^1 x\\,dx" in out,
        "task checkbox": 'type="checkbox"' in out,
        "wiki link": "Meeting notes" in out,
    }
    record("F7", checks["footnote mark"] and checks["footnote thread text"], f"render through /markdown -> {s}: {checks}")
    print("::group::F7 rendered HTML")
    print(out)
    print("::endgroup::")


def main():
    version, team_id = setup()
    print(f"Forgejo version {version}")
    f1("", "GitQuire no scope")
    f1("read:user", "GitQuire user only")
    f1("read:user read:repository", "GitQuire repo read")
    f1("read:user read:repository", "GitQuire repo read, team member", "carol")
    tmp = tempfile.mkdtemp()
    try:
        s, body = make_token("gitquire-bot", "f2", ["write:repository", "read:user"])
        bot_token = body.get("sha1") if isinstance(body, dict) else None
        call("PUT", "/repos/team/wiki/collaborators/gitquire-bot", {"permission": "write"}, auth=ADMIN)
        got = f2_to_f6(bot_token, tmp)
        if got:
            f3(bot_token, *got)
        admin_token = f4_f8_f9(team_id)
        f5()
        f7(admin_token)
        call("PUT", "/repos/team/wiki/collaborators/gitquire-bot", {"permission": "admin"}, auth=ADMIN)
        f9(admin_token, tmp)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    lines = [f"### Forgejo prototype rows (Forgejo {version})", "", "| Row | Result | Detail |", "| --- | --- | --- |"]
    for row, entries in rows.items():
        for passed, detail in entries:
            mark = "pass" if passed else ("note" if passed is None else "**fail**")
            lines.append(f"| {row} | {mark} | {detail.replace('|', '/')} |")
    summary = "\n".join(lines) + "\n"
    print(summary)
    if os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a") as fh:
            fh.write(summary)
    failed = [row for row, entries in rows.items() if any(p is False for p, _ in entries)]
    print("FAILED ROWS:", failed or "none")
    return 0


if __name__ == "__main__":
    sys.exit(main())
