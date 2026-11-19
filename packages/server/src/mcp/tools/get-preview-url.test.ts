import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { AutoStartDisabledError } from '../../autostart.ts';
import { resolveLockDir } from '../../config/paths.ts';
import { type Config, ConfigSchema } from '../../config/schema.ts';
import { markServerLockDraining } from '../../server-lock.ts';
import { register } from './get-preview-url.ts';
import { bindTestServerLock, bindTestUiServerLock } from './preview-url-test-helpers.ts';
import type { ServerInstance } from './shared.ts';

beforeEach(() => {
  vi.stubEnv('GITQUIRE_CHANNEL', 'stable');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

const ownedDirectories: string[] = [];
function temporaryProject(prefix = 'ok-get-preview-url-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  ownedDirectories.push(dir);
  return dir;
}
afterEach(() => {
  const owned = ownedDirectories.splice(0);
  for (const dir of owned) rmSync(dir, { recursive: true, force: true });
  for (const dir of owned) expect(existsSync(dir)).toBe(false);
});

const BASE_CONFIG: Config = ConfigSchema.parse({});
const CONFIG_AUTOOPEN_OFF: Config = ConfigSchema.parse({
  appearance: { preview: { autoOpen: false } },
});

interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

type ToolHandler = (args: {
  document?: string;
  folder?: string;
  skill?: { name: string; scope?: 'project' | 'global' };
  cwd?: string;
}) => Promise<ToolResult>;

interface EnsureDeps {
  serverUrl?: (cwd?: string) => Promise<string | undefined>;
  uiBindWait?: { timeoutMs?: number; pollIntervalMs?: number };
  isHostedAgent?: boolean;
}

function captureRegistration(
  cwd: string,
  config: Config = BASE_CONFIG,
  ensure?: EnsureDeps,
): ToolHandler {
  let captured: ToolHandler | null = null;
  const server = {
    registerTool(_name: string, _config: unknown, handler: ToolHandler) {
      captured = handler;
    },
    tool() {
      throw new Error('legacy tool() should not be called by preview_url');
    },
  } as unknown as ServerInstance;
  register(server, {
    config,
    resolveCwd: async () => cwd,
    ...ensure,
  });
  if (!captured) throw new Error('tool not registered');
  return captured;
}

describe('preview_url tool — UI running', () => {
  test('with document: composes baseUrl + the doc route', async () => {
    const cwd = temporaryProject();
    const uiBase = bindTestUiServerLock(cwd);
    const handler = captureRegistration(cwd);
    const result = await handler({ document: 'specs/foo/SPEC' });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent?.running).toBe(true);
    expect(result.structuredContent?.baseUrl).toBe(uiBase);
    expect(result.structuredContent?.url).toBe(`${uiBase}/#/specs/foo/SPEC`);
    expect(result.structuredContent?.autoOpen).toBe(true);
    expect(result.content[0]?.text).toContain(`${uiBase}/#/specs/foo/SPEC`);
  });

  test('with folder: composes the folder route with a trailing slash', async () => {
    const cwd = temporaryProject();
    const uiBase = bindTestUiServerLock(cwd);
    const handler = captureRegistration(cwd);
    const result = await handler({ folder: 'specs/foo' });
    expect(result.structuredContent?.url).toBe(`${uiBase}/#/specs/foo/`);
  });

  test('folder route tolerates surrounding slashes and per-segment encodes', async () => {
    const cwd = temporaryProject();
    const uiBase = bindTestUiServerLock(cwd);
    const handler = captureRegistration(cwd);
    const result = await handler({ folder: '/My Notes/sub/' });
    expect(result.structuredContent?.url).toBe(`${uiBase}/#/My%20Notes/sub/`);
  });

  describe('isHostedAgent steer (desktop terminal or in-app agent panel)', () => {
    test('document: response leads with `gq open <doc>` and tells the agent not to navigate the URL', async () => {
      const cwd = temporaryProject();
      bindTestUiServerLock(cwd);
      const handler = captureRegistration(cwd, BASE_CONFIG, { isHostedAgent: true });
      const result = await handler({ document: 'specs/foo/SPEC' });
      const text = result.content[0]?.text ?? '';
      expect(text).toContain('gq open specs/foo/SPEC');
      expect(text).toMatch(/Don't navigate the URL|reference only/);
      expect(result.structuredContent?.running).toBe(true);
      expect(result.structuredContent?.okOpenCommand).toBe('gq open specs/foo/SPEC');
    });

    test('document: steer tells the agent not to paste the URL into its reply', async () => {
      const cwd = temporaryProject();
      bindTestUiServerLock(cwd);
      const handler = captureRegistration(cwd, BASE_CONFIG, { isHostedAgent: true });
      const result = await handler({ document: 'specs/foo/SPEC' });
      expect(result.content[0]?.text ?? '').toContain('paste the URL into your reply');
    });

    test('folder: steers to `gq open <folder>`', async () => {
      const cwd = temporaryProject();
      bindTestUiServerLock(cwd);
      const handler = captureRegistration(cwd, BASE_CONFIG, { isHostedAgent: true });
      const result = await handler({ folder: 'specs/foo' });
      expect(result.content[0]?.text ?? '').toContain('gq open specs/foo');
      expect(result.structuredContent?.okOpenCommand).toBe('gq open specs/foo');
    });

    test('no target (root): no steer — nothing to `gq open`', async () => {
      const cwd = temporaryProject();
      bindTestUiServerLock(cwd);
      const handler = captureRegistration(cwd, BASE_CONFIG, { isHostedAgent: true });
      const result = await handler({});
      expect(result.content[0]?.text ?? '').not.toContain('gq open');
    });

    test('NOT a hosted agent (default): no steer — plain Preview URL', async () => {
      const cwd = temporaryProject();
      bindTestUiServerLock(cwd);
      const handler = captureRegistration(cwd);
      const result = await handler({ document: 'specs/foo/SPEC' });
      expect(result.content[0]?.text ?? '').not.toContain('gq open');
      expect(result.structuredContent?.okOpenCommand ?? null).toBeNull();
    });

    test('hosted agent + no UI running: steer + okOpenCommand still fire (gq open does not need the UI)', async () => {
      const cwd = temporaryProject();
      const handler = captureRegistration(cwd, BASE_CONFIG, { isHostedAgent: true });
      const result = await handler({ document: 'specs/foo/SPEC' });
      expect(result.structuredContent?.running).toBe(false);
      expect(result.structuredContent?.okOpenCommand).toBe('gq open specs/foo/SPEC');
      expect(result.content[0]?.text ?? '').toContain('gq open specs/foo/SPEC');
      expect(result.content[0]?.text ?? '').toContain('paste the URL into your reply');
    });

    test('document with a space: okOpenCommand shell-quotes the path', async () => {
      const cwd = temporaryProject();
      bindTestUiServerLock(cwd);
      const handler = captureRegistration(cwd, BASE_CONFIG, { isHostedAgent: true });
      const result = await handler({ document: 'notes/My Doc' });
      expect(result.structuredContent?.okOpenCommand).toBe("gq open 'notes/My Doc'");
    });

    test('document with an embedded single quote: okOpenCommand POSIX-escapes it', async () => {
      const cwd = temporaryProject();
      bindTestUiServerLock(cwd);
      const handler = captureRegistration(cwd, BASE_CONFIG, { isHostedAgent: true });
      const result = await handler({ document: "Q&A/what's new" });
      expect(result.structuredContent?.okOpenCommand).toBe("gq open 'Q&A/what'\\''s new'");
    });

    test('hosted agent + no UI + folder: okOpenCommand still fires', async () => {
      const cwd = temporaryProject();
      const handler = captureRegistration(cwd, BASE_CONFIG, { isHostedAgent: true });
      const result = await handler({ folder: 'specs/foo' });
      expect(result.structuredContent?.running).toBe(false);
      expect(result.structuredContent?.okOpenCommand).toBe('gq open specs/foo');
    });
  });

  test('docName + folder together is rejected (mutually exclusive)', async () => {
    const cwd = temporaryProject();
    bindTestUiServerLock(cwd);
    const handler = captureRegistration(cwd);
    const result = await handler({ document: 'specs/foo/SPEC', folder: 'specs/foo' });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('mutually exclusive');
  });

  test('without docName: returns the UI root URL', async () => {
    const cwd = temporaryProject();
    const uiBase = bindTestUiServerLock(cwd);
    const handler = captureRegistration(cwd);
    const result = await handler({});
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent?.running).toBe(true);
    expect(result.structuredContent?.url).toBe(uiBase);
    expect(result.structuredContent?.baseUrl).toBe(uiBase);
    expect(result.structuredContent?.autoOpen).toBe(true);
  });

  test('per-segment encodes docName when composing the URL', async () => {
    const cwd = temporaryProject();
    const uiBase = bindTestUiServerLock(cwd);
    const handler = captureRegistration(cwd);
    const result = await handler({ document: 'notes/My Doc' });
    expect(result.structuredContent?.url).toBe(`${uiBase}/#/notes/My%20Doc`);
  });
});

describe('preview_url tool — no UI running', () => {
  test('returns running:false + the ok-start hint when nothing is running', async () => {
    const cwd = temporaryProject();
    const handler = captureRegistration(cwd);
    const result = await handler({ document: 'specs/foo/SPEC' });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent?.running).toBe(false);
    expect(result.structuredContent?.url).toBeNull();
    expect(result.structuredContent?.baseUrl).toBeNull();
    expect(result.structuredContent?.autoOpen).toBe(true);
    expect(result.content[0]?.text).toContain('No GitQuire server is running');
    expect(result.content[0]?.text).toContain('`gq start`');
    expect(result.content[0]?.text).not.toContain('`gq ui`');
  });

  test('no-UI branch is the same regardless of docName', async () => {
    const cwd = temporaryProject();
    const handler = captureRegistration(cwd);
    const result = await handler({});
    expect(result.structuredContent?.running).toBe(false);
    expect(result.structuredContent?.url).toBeNull();
    expect(result.structuredContent?.autoOpen).toBe(true);
  });

  test('draining ui-capable server: transient retry hint, no spawn advice', async () => {
    const cwd = temporaryProject();
    bindTestServerLock(cwd, 4321, ['http', 'ws', 'ui']);
    markServerLockDraining(resolveLockDir(cwd));
    const handler = captureRegistration(cwd);
    const result = await handler({ document: 'specs/foo/SPEC' });
    expect(result.structuredContent?.running).toBe(false);
    expect(result.content[0]?.text).toContain('OK server is running');
    expect(result.content[0]?.text).toContain('Retry in a few seconds');
    expect(result.content[0]?.text).not.toContain('`gq start`');
  });

  test('--only server (capabilities omit ui): permanent hint, no "Retry" (UI never binds on its own)', async () => {
    const cwd = temporaryProject();
    bindTestServerLock(cwd, 4321, ['http', 'ws']);
    const handler = captureRegistration(cwd);
    const result = await handler({ document: 'specs/foo/SPEC' });
    expect(result.structuredContent?.running).toBe(false);
    expect(result.content[0]?.text).toContain('no preview UI is mounted');
    expect(result.content[0]?.text).toContain('--only server');
    expect(result.content[0]?.text).toContain('Restart it with plain `gq start`');
    expect(result.content[0]?.text).not.toContain('`gq ui`');
    expect(result.content[0]?.text).not.toContain('Retry');
  });

  test('ui-capable server.lock resolves directly (single-listener): running, own origin, no ui.lock needed', async () => {
    const cwd = temporaryProject();
    bindTestServerLock(cwd, 4321, ['http', 'ws', 'ui']);
    const handler = captureRegistration(cwd);
    const result = await handler({ document: 'specs/foo/SPEC' });
    expect(result.structuredContent?.running).toBe(true);
    expect(result.structuredContent?.url).toBe('http://localhost:4321/#/specs/foo/SPEC');
    expect(result.content[0]?.text).not.toContain('no preview UI is mounted');
  });
});

describe('preview_url tool — backend demand-ensure', () => {
  test('cold project: ensure spawns the backend and the call returns a live URL', async () => {
    const cwd = temporaryProject();
    let resolverCalls = 0;
    let uiBase = '';
    const handler = captureRegistration(cwd, BASE_CONFIG, {
      serverUrl: async () => {
        resolverCalls += 1;
        uiBase = bindTestUiServerLock(cwd, 4321);
        return 'http://localhost:4321';
      },
      uiBindWait: { timeoutMs: 1500, pollIntervalMs: 10 },
    });
    const result = await handler({ document: 'specs/foo/SPEC' });
    expect(resolverCalls).toBe(1);
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent?.running).toBe(true);
    expect(result.structuredContent?.url).toBe(`${uiBase}/#/specs/foo/SPEC`);
  });

  test('resolver runs on every call, even with a live UI (orphan-heal contract)', async () => {
    const cwd = temporaryProject();
    const uiBase = bindTestUiServerLock(cwd);
    let resolverCalls = 0;
    const handler = captureRegistration(cwd, BASE_CONFIG, {
      serverUrl: async () => {
        resolverCalls += 1;
        return 'http://localhost:4321';
      },
    });
    const result = await handler({});
    expect(resolverCalls).toBe(1);
    expect(result.structuredContent?.running).toBe(true);
    expect(result.structuredContent?.url).toBe(uiBase);
  });

  test('auto-start opt-out: soft not-running payload naming the knob', async () => {
    const cwd = temporaryProject();
    const handler = captureRegistration(cwd, BASE_CONFIG, {
      serverUrl: async () => {
        throw new AutoStartDisabledError(
          'GitQuire server is not running and GITQUIRE_MCP_AUTOSTART=0 disables auto-start.',
        );
      },
    });
    const result = await handler({ document: 'specs/foo/SPEC' });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent?.running).toBe(false);
    expect(result.structuredContent?.url).toBeNull();
    expect(result.content[0]?.text).toContain('`gq start`');
    expect(result.content[0]?.text).toContain('GITQUIRE_MCP_AUTOSTART=0');
    expect(result.content[0]?.text).not.toContain('`gq ui`');
  });

  test('spawn failure surfaces as a tool error carrying the resolver message', async () => {
    const cwd = temporaryProject();
    const handler = captureRegistration(cwd, BASE_CONFIG, {
      serverUrl: async () => {
        throw new Error('server did not start within 5000ms stderr:\nboom');
      },
    });
    const result = await handler({ document: 'specs/foo/SPEC' });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('did not start within');
  });

  test('fresh spawn that comes up draining: server-running retry hint after the bounded wait', async () => {
    const cwd = temporaryProject();
    const handler = captureRegistration(cwd, BASE_CONFIG, {
      serverUrl: async () => {
        bindTestServerLock(cwd, 4321, ['http', 'ws', 'ui']);
        markServerLockDraining(resolveLockDir(cwd));
        return 'http://localhost:4321';
      },
      uiBindWait: { timeoutMs: 60, pollIntervalMs: 10 },
    });
    const result = await handler({ document: 'specs/foo/SPEC' });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent?.running).toBe(false);
    expect(result.content[0]?.text).toContain('OK server is running');
    expect(result.content[0]?.text).toContain('Retry in a few seconds');
    expect(result.content[0]?.text).not.toContain('`gq start`');
  });

  test('spawn failure during demand-ensure surfaces isError', async () => {
    const cwd = temporaryProject();
    const handler = captureRegistration(cwd, BASE_CONFIG, {
      serverUrl: async () => {
        throw new Error('spawn failed: ENOENT');
      },
    });
    const result = await handler({ document: 'specs/foo/SPEC' });
    expect(result.isError).toBe(true);
  });
});

describe('preview_url tool — autoOpen field', () => {
  test('echoes resolved autoOpen=false when the user has disabled it', async () => {
    const cwd = temporaryProject();
    bindTestUiServerLock(cwd);
    const handler = captureRegistration(cwd, CONFIG_AUTOOPEN_OFF);
    const result = await handler({ document: 'specs/foo/SPEC' });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent?.running).toBe(true);
    expect(result.structuredContent?.autoOpen).toBe(false);
  });

  test('echoes autoOpen=false when no UI is running', async () => {
    const cwd = temporaryProject();
    const handler = captureRegistration(cwd, CONFIG_AUTOOPEN_OFF);
    const result = await handler({});
    expect(result.structuredContent?.running).toBe(false);
    expect(result.structuredContent?.autoOpen).toBe(false);
  });

  test('reads config fresh per call (resolver invoked on every invocation)', async () => {
    const cwd = temporaryProject();
    bindTestUiServerLock(cwd);
    let currentAutoOpen = true;
    const configResolver = async (): Promise<Config> =>
      ConfigSchema.parse({ appearance: { preview: { autoOpen: currentAutoOpen } } });
    let captured: ToolHandler | null = null;
    const server = {
      registerTool(_name: string, _config: unknown, handler: ToolHandler) {
        captured = handler;
      },
      tool() {
        throw new Error('legacy tool() should not be called by preview_url');
      },
    } as unknown as ServerInstance;
    register(server, {
      config: configResolver,
      resolveCwd: async () => cwd,
    });
    if (!captured) throw new Error('tool not registered');
    const handler = captured as ToolHandler;

    const first = await handler({ document: 'foo' });
    expect(first.structuredContent?.autoOpen).toBe(true);

    currentAutoOpen = false;
    const second = await handler({ document: 'foo' });
    expect(second.structuredContent?.autoOpen).toBe(false);
  });
});

describe('preview_url tool — error path', () => {
  test('returns isError when resolveCwd rejects', async () => {
    let captured: ToolHandler | undefined;
    const server = {
      registerTool(_name: string, _config: unknown, handler: ToolHandler) {
        captured = handler;
      },
      tool() {
        throw new Error('legacy tool() should not be called by preview_url');
      },
    } as unknown as ServerInstance;
    register(server, {
      config: BASE_CONFIG,
      resolveCwd: async () => {
        throw new Error('no roots configured');
      },
    });
    if (!captured) throw new Error('tool not registered');
    const result = await captured({ document: 'specs/foo/SPEC' });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('no roots configured');
  });
});

describe('preview_url tool — names the running channel command', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  test('a Beta hosted agent is steered to gq-beta open', async () => {
    vi.stubEnv('GITQUIRE_CHANNEL', 'beta');
    const cwd = temporaryProject();
    bindTestUiServerLock(cwd);
    const handler = captureRegistration(cwd, BASE_CONFIG, { isHostedAgent: true });

    const doc = await handler({ document: 'specs/foo/SPEC' });
    expect(doc.structuredContent?.okOpenCommand).toBe('gq-beta open specs/foo/SPEC');
    expect(doc.content[0]?.text ?? '').toContain('run `gq-beta open specs/foo/SPEC`');
  });

  test('a Beta server with nothing running says gq-beta start', async () => {
    vi.stubEnv('GITQUIRE_CHANNEL', 'beta');
    const handler = captureRegistration(temporaryProject());
    const result = await handler({ document: 'specs/foo/SPEC' });
    expect(result.content[0]?.text).toContain('Start it with `gq-beta start`');
    expect(result.content[0]?.text).not.toContain('`gq start`');
  });

  test('a Beta server without a mounted UI says gq-beta start', async () => {
    vi.stubEnv('GITQUIRE_CHANNEL', 'beta');
    const cwd = temporaryProject();
    bindTestServerLock(cwd, 4321, ['http', 'ws']);
    const result = await captureRegistration(cwd)({ document: 'specs/foo/SPEC' });
    expect(result.content[0]?.text).toContain('Restart it with plain `gq-beta start`');
  });

  test('Stable hints stay byte-identical', async () => {
    vi.stubEnv('GITQUIRE_CHANNEL', 'stable');
    const cwd = temporaryProject();
    bindTestUiServerLock(cwd);
    const steered = await captureRegistration(cwd, BASE_CONFIG, { isHostedAgent: true })({
      folder: 'specs/foo',
    });
    expect(steered.structuredContent?.okOpenCommand).toBe('gq open specs/foo');

    const idle = await captureRegistration(temporaryProject())({ document: 'specs/foo/SPEC' });
    expect(idle.content[0]?.text).toContain(
      'No GitQuire server is running for this project. Start it with `gq start` (also starts the preview UI), or open the project in OK Electron.',
    );
  });
});
