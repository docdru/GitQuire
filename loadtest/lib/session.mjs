import { performance } from 'node:perf_hooks';

export class Session {
  constructor(base, fake, login) {
    this.base = base.replace(/\/$/, '');
    this.fake = fake.replace(/\/$/, '');
    this.login = login;
    this.cookies = new Map();
  }

  cookieHeader() {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  keep(res) {
    for (const line of res.headers.getSetCookie?.() ?? []) {
      const [pair] = line.split(';');
      const at = pair.indexOf('=');
      const name = pair.slice(0, at).trim();
      const value = pair.slice(at + 1).trim();
      if (/max-age=0|expires=thu, 01 jan 1970/i.test(line) || value === '')
        this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }

  async raw(url, init = {}) {
    const own = url.startsWith(this.base);
    const headers = { ...init.headers };
    if (own && this.cookies.size > 0) headers.cookie = this.cookieHeader();
    if (own && init.method && init.method !== 'GET') headers.origin = this.base;
    const res = await fetch(url, { ...init, headers, redirect: 'manual' });
    if (own) this.keep(res);
    return res;
  }

  async round(startPath) {
    await fetch(`${this.fake}/_fake/next-login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ login: this.login }),
    });
    let res = await this.raw(this.base + startPath);
    for (let hop = 0; hop < 6 && res.status >= 300 && res.status < 400; hop++) {
      const next = new URL(res.headers.get('location'), this.base).toString();
      await res.arrayBuffer();
      if (next.startsWith(this.base) && !next.includes('/auth/')) return { ok: true, at: next };
      res = await this.raw(next);
    }
    const text = await res.text();
    return { ok: res.status < 400, status: res.status, text: text.slice(0, 300) };
  }

  async signIn() {
    const out = await this.round('/auth/github/login?next=%2F');
    if (!out.ok) throw new Error(`sign-in of ${this.login} failed: ${JSON.stringify(out)}`);
  }

  async call(method, path, body) {
    const started = performance.now();
    const init = { method, headers: { accept: 'application/json' } };
    if (body !== undefined) {
      init.body = JSON.stringify(body);
      init.headers['content-type'] = 'application/json';
    }
    const res = await this.raw(this.base + path, init);
    const text = await res.text();
    const ms = performance.now() - started;
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    return { status: res.status, ms, json, text };
  }
}
