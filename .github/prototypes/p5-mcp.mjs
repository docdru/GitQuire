import http from 'node:http';

const port = Number(process.env.PORT ?? 8765);
const wikis = {
  'team/wiki': {
    title: 'Wiki A',
    pages: { index: '# Index of Wiki A\n\nThe first line of Wiki A.\n' },
  },
  'team/wiki-b': {
    title: 'Wiki B',
    pages: { index: '# Index of Wiki B\n\nThe first line of Wiki B.\n' },
  },
};
const calls = [];

const tools = [
  {
    name: 'list_wikis',
    description:
      'List the wikis this person can open. Every other tool needs one of these names as its wiki argument.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'read_page',
    description: 'Read one page of a wiki as Markdown.',
    inputSchema: {
      type: 'object',
      properties: {
        wiki: {
          type: 'string',
          description: 'The wiki, as list_wikis names it, for example team/wiki',
        },
        path: { type: 'string', description: 'Page name without .md, for example index' },
      },
      required: ['wiki', 'path'],
      additionalProperties: false,
    },
  },
];

function result(id, value) {
  return { jsonrpc: '2.0', id, result: value };
}

function text(value, isError = false) {
  return { content: [{ type: 'text', text: value }], isError };
}

function handle(msg) {
  const { id, method, params } = msg;
  if (method === 'initialize') {
    return result(id, {
      protocolVersion: params?.protocolVersion ?? '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'gitquire-p5-prototype', version: '0.0.1' },
    });
  }
  if (method === 'tools/list') return result(id, { tools });
  if (method === 'tools/call') {
    const { name, arguments: args = {} } = params ?? {};
    calls.push({ at: new Date().toISOString(), name, args });
    console.log(`[P5] call ${name} ${JSON.stringify(args)}`);
    if (name === 'list_wikis') {
      return result(
        id,
        text(
          Object.entries(wikis)
            .map(([k, v]) => `${k} — ${v.title}`)
            .join('\n'),
        ),
      );
    }
    if (name === 'read_page') {
      const wiki = wikis[args.wiki];
      if (!wiki)
        return result(id, text(`Unknown wiki "${args.wiki}". Call list_wikis first.`, true));
      const page = wiki.pages[args.path];
      if (!page) return result(id, text(`No page "${args.path}" in ${args.wiki}.`, true));
      return result(id, text(page));
    }
    return { jsonrpc: '2.0', id, error: { code: -32601, message: `unknown tool ${name}` } };
  }
  if (method === 'ping') return result(id, {});
  if (id === undefined) return null;
  return { jsonrpc: '2.0', id, error: { code: -32601, message: `unknown method ${method}` } };
}

http
  .createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/calls') {
      res
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify(calls, null, 2));
      return;
    }
    if (req.method !== 'POST' || !req.url?.startsWith('/mcp')) {
      res.writeHead(req.method === 'GET' ? 405 : 404).end();
      return;
    }
    let body = '';
    req.on('data', (c) => {
      body += c;
    });
    req.on('end', () => {
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch {
        res.writeHead(400).end();
        return;
      }
      const replies = (Array.isArray(parsed) ? parsed : [parsed]).map(handle).filter(Boolean);
      if (replies.length === 0) {
        res.writeHead(202).end();
        return;
      }
      res
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify(Array.isArray(parsed) ? replies : replies[0]));
    });
  })
  .listen(port, () => console.log(`P5 prototype MCP server on :${port}/mcp, calls at /calls`));
