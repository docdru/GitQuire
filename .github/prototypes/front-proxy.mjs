import { appendFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';

const port = Number(process.env.PROXY_PORT ?? 9000);
const logFile = process.env.PROXY_LOG ?? '/tmp/proxy-escapes.log';
const wikis = JSON.parse(process.env.PROXY_WIKIS ?? '{}');
const prefixes = Object.keys(wikis).sort((a, b) => b.length - a.length);
const WIKI_COOKIE = 'gq_proto_wiki';

function note(kind, req, detail = '') {
  const line = JSON.stringify({ kind, method: req.method, url: req.url, referer: req.headers.referer ?? null, detail });
  appendFileSync(logFile, `${line}\n`);
}

function prefixOf(path) {
  return prefixes.find((p) => path === p.slice(0, -1) || path.startsWith(p)) ?? null;
}

function cookieWiki(req) {
  const match = /(?:^|;\s*)gq_proto_wiki=([^;]+)/.exec(req.headers.cookie ?? '');
  return match ? decodeURIComponent(match[1]) : null;
}

function route(req) {
  const url = req.url ?? '/';
  const direct = prefixOf(url);
  if (direct) return { prefix: direct, path: url.slice(direct.length - 1) || '/', how: 'prefix' };
  if (url.startsWith('/auth/github/callback')) {
    const wiki = cookieWiki(req);
    if (wiki && wikis[wiki]) return { prefix: wiki, path: url, how: 'callback-cookie' };
  }
  if (req.method === 'GET' || req.method === 'HEAD') {
    const ref = req.headers.referer;
    if (ref) {
      const refPrefix = prefixOf(new URL(ref).pathname);
      if (refPrefix) return { prefix: refPrefix, path: url, how: 'referer' };
    }
  }
  return null;
}

const SHIM_BODY = (prefix) => `(()=>{const P=${JSON.stringify(prefix.slice(0, -1))};window.__gqProtoShim=P;
const fix=(u)=>{try{if(typeof u!=='string')return u;if(u.startsWith('/')&&!u.startsWith('//')&&!u.startsWith(P+'/'))return P+u;
const x=new URL(u,location.href);if(x.host===location.host&&!x.pathname.startsWith(P+'/')){x.pathname=P+x.pathname;return x.toString();}}catch{}return u;};
const of=window.fetch.bind(window);window.fetch=(i,o)=>{if(typeof i==='string'||i instanceof URL)return of(fix(String(i)),o);
if(i instanceof Request){const n=fix(i.url);return n===i.url?of(i,o):of(new Request(n,i),o);}return of(i,o);};
const OW=window.WebSocket;window.WebSocket=function(u,p){return new OW(fix(String(u)),p);};window.WebSocket.prototype=OW.prototype;
Object.assign(window.WebSocket,{CONNECTING:0,OPEN:1,CLOSING:2,CLOSED:3});
const OE=window.EventSource;if(OE){window.EventSource=function(u,c){return new OE(fix(String(u)),c);};window.EventSource.prototype=OE.prototype;}
const oo=XMLHttpRequest.prototype.open;XMLHttpRequest.prototype.open=function(m,u,...r){return oo.call(this,m,fix(String(u)),...r);};
const osb=navigator.sendBeacon?.bind(navigator);if(osb)navigator.sendBeacon=(u,d)=>osb(fix(String(u)),d);
})();`;
const SHIM = (prefix) => `<script src="${prefix}__gq_proto_shim.js"></script>`;

const HOST_AUTHORIZE = process.env.PROXY_HOST_AUTHORIZE ?? 'http://127.0.0.1:3000/login/oauth/authorize';
const ADD_SCOPE = process.env.PROXY_OAUTH_SCOPE ?? '';

function wikiSuffix(prefix) {
  return `__${prefix.replace(/[^a-z0-9]+/gi, '_').replace(/^_|_$/g, '')}`;
}

function cookiesFor(header, prefix) {
  if (!header) return header;
  const mine = wikiSuffix(prefix);
  const all = header.split(/;\s*/).filter(Boolean);
  const kept = [];
  for (const pair of all) {
    const name = pair.split('=')[0];
    if (name.endsWith(mine)) kept.push(pair.replace(`${mine}=`, '='));
    else if (!/__w_/.test(name) && name !== WIKI_COOKIE) kept.push(pair);
  }
  return kept.join('; ');
}

function rewriteHeaders(headers, target, req) {
  const out = { ...headers };
  const loc = out.location;
  if (typeof loc === 'string' && loc.startsWith(HOST_AUTHORIZE)) {
    const u = new URL(loc);
    const added = [];
    if (!u.searchParams.has('response_type')) {
      u.searchParams.set('response_type', 'code');
      added.push('response_type=code');
    }
    if (ADD_SCOPE && !u.searchParams.has('scope')) {
      u.searchParams.set('scope', ADD_SCOPE);
      added.push(`scope=${ADD_SCOPE}`);
    }
    if (added.length) note('host-authorize-patched', req, added.join(' '));
    out.location = u.toString();
  } else if (typeof loc === 'string') {
    const backendOrigin = `http://127.0.0.1:${port}`;
    if (loc.startsWith(backendOrigin)) out.location = target.prefix.slice(0, -1) + loc.slice(backendOrigin.length);
    else if (loc.startsWith('/') && !loc.startsWith('//') && !prefixOf(loc)) out.location = target.prefix.slice(0, -1) + loc;
  }
  const cookies = out['set-cookie'];
  const signInStart = target.path.startsWith('/auth/github/login');
  if (Array.isArray(cookies) && signInStart) {
    note('sign-in-cookie-kept-at-root', req, cookies.map((c) => c.split('=')[0]).join(','));
  } else if (Array.isArray(cookies)) {
    const suffix = wikiSuffix(target.prefix);
    out['set-cookie'] = cookies.map((c) => {
      const renamed = c.replace(/^([^=]+)=/, (_, name) => `${name}${suffix}=`);
      return /;\s*path=/i.test(renamed) ? renamed.replace(/;\s*path=[^;]*/i, '; Path=/') : `${renamed}; Path=/`;
    });
  }
  const wikiCookie = `${WIKI_COOKIE}=${encodeURIComponent(target.prefix)}; Path=/; HttpOnly; SameSite=Lax`;
  out['set-cookie'] = [...(out['set-cookie'] ?? []), wikiCookie];
  return out;
}

const server = http.createServer((req, res) => {
  const shimPrefix = prefixes.find((p) => req.url === `${p}__gq_proto_shim.js`);
  if (shimPrefix) {
    res.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'no-store' }).end(SHIM_BODY(shimPrefix));
    return;
  }
  const target = route(req);
  if (!target) {
    note('escaped', req);
    res.writeHead(404, { 'content-type': 'text/plain' }).end('no wiki in this address');
    return;
  }
  if (target.how !== 'prefix') note(target.how, req);
  const headers = { ...req.headers, 'x-forwarded-prefix': target.prefix.slice(0, -1) };
  if (headers.cookie) headers.cookie = cookiesFor(headers.cookie, target.prefix);
  if (headers.referer) {
    try {
      const r = new URL(headers.referer);
      const rp = prefixOf(r.pathname);
      if (rp) {
        r.pathname = r.pathname.slice(rp.length - 1) || '/';
        headers.referer = r.toString();
      }
    } catch {}
  }
  delete headers['accept-encoding'];
  const upstream = http.request(
    { host: '127.0.0.1', port: wikis[target.prefix], method: req.method, path: target.path, headers },
    (up) => {
      const outHeaders = rewriteHeaders(up.headers, target, req);
      const type = String(up.headers['content-type'] ?? '');
      if (type.includes('text/html')) note('html', req, `${up.statusCode} ${type} encoding=${up.headers['content-encoding'] ?? 'none'}`);
      if (type.includes('text/html') && !up.headers['content-encoding']) {
        const chunks = [];
        up.on('data', (c) => chunks.push(c));
        up.on('end', () => {
          let body = Buffer.concat(chunks).toString('utf8');
          body = body.includes('<head>') ? body.replace('<head>', `<head>${SHIM(target.prefix)}`) : SHIM(target.prefix) + body;
          delete outHeaders['content-length'];
          res.writeHead(up.statusCode ?? 502, outHeaders).end(body);
        });
        return;
      }
      res.writeHead(up.statusCode ?? 502, outHeaders);
      up.pipe(res);
    },
  );
  upstream.on('error', (err) => {
    note('upstream-error', req, String(err));
    if (!res.headersSent) res.writeHead(502).end('upstream error');
  });
  req.pipe(upstream);
});

server.on('upgrade', (req, socket, head) => {
  const target = route(req);
  if (!target) {
    note('escaped-upgrade', req);
    socket.end('HTTP/1.1 404 Not Found\r\n\r\n');
    return;
  }
  const upstream = net.connect(wikis[target.prefix], '127.0.0.1', () => {
    const lines = [`${req.method} ${target.path} HTTP/1.1`];
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      const name = req.rawHeaders[i];
      let value = req.rawHeaders[i + 1];
      if (name.toLowerCase() === 'cookie') value = cookiesFor(value, target.prefix);
      lines.push(`${name}: ${value}`);
    }
    lines.push(`X-Forwarded-Prefix: ${target.prefix.slice(0, -1)}`);
    upstream.write(`${lines.join('\r\n')}\r\n\r\n`);
    if (head?.length) upstream.write(head);
    socket.pipe(upstream).pipe(socket);
  });
  upstream.on('error', () => socket.destroy());
  socket.on('error', () => upstream.destroy());
});

server.listen(port, '127.0.0.1', () => console.log(`front proxy on ${port}: ${JSON.stringify(wikis)}`));

const shimPort = Number(process.env.HOST_SHIM_PORT ?? 0);
const hostPort = Number(process.env.HOST_PORT ?? 3000);
if (shimPort) {
  http
    .createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        let body = Buffer.concat(chunks);
        const headers = { ...req.headers, host: `127.0.0.1:${hostPort}` };
        if (req.method === 'POST' && req.url?.startsWith('/login/oauth/access_token')) {
          const type = String(req.headers['content-type'] ?? '');
          if (type.includes('json')) {
            const parsed = JSON.parse(body.toString('utf8') || '{}');
            if (!parsed.grant_type) {
              parsed.grant_type = 'authorization_code';
              note('host-exchange-patched', req, 'grant_type=authorization_code');
            }
            body = Buffer.from(JSON.stringify(parsed));
          }
          headers['content-length'] = String(body.length);
        }
        const up = http.request({ host: '127.0.0.1', port: hostPort, method: req.method, path: req.url, headers }, (r) => {
          const out = { ...r.headers };
          if (req.url?.startsWith('/login/oauth/access_token')) {
            const parts = [];
            r.on('data', (c) => parts.push(c));
            r.on('end', () => {
              const text = Buffer.concat(parts).toString('utf8');
              note('host-exchange-answer', req, `${r.statusCode} ${text.includes('access_token') ? 'token issued' : text.slice(0, 200)}`);
              res.writeHead(r.statusCode ?? 502, out).end(text);
            });
            return;
          }
          res.writeHead(r.statusCode ?? 502, out);
          r.pipe(res);
        });
        up.on('error', () => res.writeHead(502).end());
        up.end(body);
      });
    })
    .listen(shimPort, '127.0.0.1', () => console.log(`host shim on ${shimPort} -> ${hostPort}`));
}
