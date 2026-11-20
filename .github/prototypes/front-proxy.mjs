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

const SHIM = (prefix) => `<script>(()=>{const P=${JSON.stringify(prefix.slice(0, -1))};
const fix=(u)=>{try{if(typeof u!=='string')return u;if(u.startsWith('/')&&!u.startsWith('//')&&!u.startsWith(P+'/'))return P+u;
const x=new URL(u,location.href);if(x.host===location.host&&!x.pathname.startsWith(P+'/')){x.pathname=P+x.pathname;return x.toString();}}catch{}return u;};
const of=window.fetch.bind(window);window.fetch=(i,o)=>{if(typeof i==='string'||i instanceof URL)return of(fix(String(i)),o);
if(i instanceof Request){const n=fix(i.url);return n===i.url?of(i,o):of(new Request(n,i),o);}return of(i,o);};
const OW=window.WebSocket;window.WebSocket=function(u,p){return new OW(fix(String(u)),p);};window.WebSocket.prototype=OW.prototype;
Object.assign(window.WebSocket,{CONNECTING:0,OPEN:1,CLOSING:2,CLOSED:3});
const OE=window.EventSource;if(OE){window.EventSource=function(u,c){return new OE(fix(String(u)),c);};window.EventSource.prototype=OE.prototype;}
const oo=XMLHttpRequest.prototype.open;XMLHttpRequest.prototype.open=function(m,u,...r){return oo.call(this,m,fix(String(u)),...r);};
const osb=navigator.sendBeacon?.bind(navigator);if(osb)navigator.sendBeacon=(u,d)=>osb(fix(String(u)),d);
})();</script>`;

function rewriteHeaders(headers, target) {
  const out = { ...headers };
  const loc = out.location;
  if (typeof loc === 'string') {
    const backendOrigin = `http://127.0.0.1:${port}`;
    if (loc.startsWith(backendOrigin)) out.location = target.prefix.slice(0, -1) + loc.slice(backendOrigin.length);
    else if (loc.startsWith('/') && !loc.startsWith('//') && !prefixOf(loc)) out.location = target.prefix.slice(0, -1) + loc;
  }
  const cookies = out['set-cookie'];
  if (Array.isArray(cookies)) {
    out['set-cookie'] = cookies.map((c) =>
      /;\s*path=/i.test(c) ? c.replace(/;\s*path=[^;]*/i, `; Path=${target.prefix}`) : `${c}; Path=${target.prefix}`,
    );
  }
  const wikiCookie = `${WIKI_COOKIE}=${encodeURIComponent(target.prefix)}; Path=/; HttpOnly; SameSite=Lax`;
  out['set-cookie'] = [...(out['set-cookie'] ?? []), wikiCookie];
  return out;
}

const server = http.createServer((req, res) => {
  const target = route(req);
  if (!target) {
    note('escaped', req);
    res.writeHead(404, { 'content-type': 'text/plain' }).end('no wiki in this address');
    return;
  }
  if (target.how !== 'prefix') note(target.how, req);
  const headers = { ...req.headers, 'x-forwarded-prefix': target.prefix.slice(0, -1) };
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
      const outHeaders = rewriteHeaders(up.headers, target);
      const type = String(up.headers['content-type'] ?? '');
      if (type.includes('text/html')) {
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
