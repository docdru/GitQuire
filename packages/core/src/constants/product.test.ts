import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  currentCliCommandName,
  DESKTOP_PRODUCTS,
  DEV_FALLBACK_CLI_REFUSAL,
  defaultToDevChannel,
  desktopChannelLabel,
  desktopProductForCliCommand,
  envWithoutDevChannel,
  GqCliCommand,
  isDevChannel,
  resolveDesktopProductName,
  userHomeDisplayPath,
} from './product.ts';

describe('resolveDesktopProductName', () => {
  it('reads the channel from GITQUIRE_CHANNEL and defaults to Stable', () => {
    expect(resolveDesktopProductName({ GITQUIRE_CHANNEL: 'Beta' })).toBe('beta');
    expect(resolveDesktopProductName({ GITQUIRE_CHANNEL: 'stable' })).toBe('stable');
    expect(resolveDesktopProductName({})).toBe('stable');
  });

  it('rejects an unknown GITQUIRE_CHANNEL instead of guessing', () => {
    expect(() => resolveDesktopProductName({ GITQUIRE_CHANNEL: 'nightly' })).toThrow(
      /GITQUIRE_CHANNEL/,
    );
  });

  it('gives every channel a distinct MCP server name and chain tag', () => {
    const products = Object.values(DESKTOP_PRODUCTS);
    expect(new Set(products.map((p) => p.mcpServerName)).size).toBe(products.length);
    expect(new Set(products.map((p) => p.mcpChainTag)).size).toBe(products.length);
  });

  it('gives every channel a distinct user home and keychain service, keeping Stable unchanged', () => {
    const products = Object.values(DESKTOP_PRODUCTS);
    expect(new Set(products.map((p) => p.userHomeDirName)).size).toBe(products.length);
    expect(new Set(products.map((p) => p.keyringService)).size).toBe(products.length);
    expect(DESKTOP_PRODUCTS.stable.userHomeDirName).toBe('.gitquire');
    expect(DESKTOP_PRODUCTS.stable.keyringService).toBe('open-knowledge');
  });

  it('gives the dev channel its own home, keychain, MCP key and lock channel', () => {
    const dev = resolveDesktopProductName({ GITQUIRE_CHANNEL: 'dev' });
    expect(dev).toBe('dev');
    expect(DESKTOP_PRODUCTS[dev]).toMatchObject({
      userHomeDirName: '.gitquire-dev',
      keyringService: 'open-knowledge-dev',
      mcpServerName: 'open-knowledge-dev',
    });
  });
});

describe('defaultToDevChannel', () => {
  it('selects dev when no channel is set', () => {
    const env: Record<string, string | undefined> = {};
    defaultToDevChannel(env);
    expect(env.GITQUIRE_CHANNEL).toBe('dev');
    expect(isDevChannel(env)).toBe(true);
    expect(resolveDesktopProductName(env)).toBe('dev');
  });

  it.each(['stable', 'beta', 'Beta'])('keeps an explicit GITQUIRE_CHANNEL=%s', (channel) => {
    const env: Record<string, string | undefined> = { GITQUIRE_CHANNEL: channel };
    defaultToDevChannel(env);
    expect(env.GITQUIRE_CHANNEL).toBe(channel);
    expect(isDevChannel(env)).toBe(false);
  });

  it('treats a blank GITQUIRE_CHANNEL as unset', () => {
    const env: Record<string, string | undefined> = { GITQUIRE_CHANNEL: '  ' };
    defaultToDevChannel(env);
    expect(env.GITQUIRE_CHANNEL).toBe('dev');
  });
});

describe('desktopChannelLabel', () => {
  it.each([
    ['stable', 'OpenKnowledge (Stable)'],
    ['beta', 'OpenKnowledge Beta'],
    ['dev', 'OpenKnowledge Dev'],
    ['cloud', 'OpenKnowledge (cloud)'],
  ])('%s is named %s', (channel, expected) => {
    expect(desktopChannelLabel(channel)).toBe(expected);
  });
});

describe('channel CLI command name', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('names gq on Stable', () => {
    vi.stubEnv('GITQUIRE_CHANNEL', 'stable');
    expect(currentCliCommandName()).toBe('gq');
  });

  it('names gq-beta on Beta', () => {
    vi.stubEnv('GITQUIRE_CHANNEL', 'beta');
    expect(currentCliCommandName()).toBe('gq-beta');
  });

  it('names gq-dev on the dev channel, a bare command name like every other channel', () => {
    vi.stubEnv('GITQUIRE_CHANNEL', 'dev');
    expect(currentCliCommandName()).toBe('gq-dev');
    expect(desktopProductForCliCommand('gq-dev')).toBe(DESKTOP_PRODUCTS.dev);
  });

  it('maps a command name back to its product, and anything else to Stable', () => {
    expect(desktopProductForCliCommand('gq-beta')).toBe(DESKTOP_PRODUCTS.beta);
    expect(desktopProductForCliCommand('gq')).toBe(DESKTOP_PRODUCTS.stable);
    expect(desktopProductForCliCommand(null)).toBe(DESKTOP_PRODUCTS.stable);
    expect(desktopProductForCliCommand('gitquire-beta')).toBe(DESKTOP_PRODUCTS.stable);
  });

  it('names each product home folder for display', () => {
    expect(userHomeDisplayPath(DESKTOP_PRODUCTS.stable, 'secrets.yml')).toBe(
      '~/.gitquire/secrets.yml',
    );
    expect(userHomeDisplayPath(DESKTOP_PRODUCTS.beta, 'secrets.yml')).toBe(
      '~/.gitquire-beta/secrets.yml',
    );
  });
});

describe('envWithoutDevChannel', () => {
  it('drops the dev channel and keeps everything else', () => {
    expect(
      envWithoutDevChannel({ PATH: '/usr/bin', GITQUIRE_CHANNEL: 'dev', EMPTY: undefined }),
    ).toEqual({
      PATH: '/usr/bin',
    });
  });

  it('drops the dev channel under any key casing, as a Windows environment can carry it', () => {
    expect(envWithoutDevChannel({ Path: 'C:\\Windows', gitquire_channel: ' Dev ' })).toEqual({
      Path: 'C:\\Windows',
    });
  });

  it('keeps a shipped channel, which every released CLI knows', () => {
    expect(envWithoutDevChannel({ GITQUIRE_CHANNEL: 'beta' })).toEqual({
      GITQUIRE_CHANNEL: 'beta',
    });
  });
});

describe('GqCliCommand', () => {
  const checkoutCli = ['node', '/src/cli.mjs'];

  it('pins dev only on a CLI the host supplies', () => {
    const cli = GqCliCommand.resolve({
      host: { cliArgs: checkoutCli },
      env: { GITQUIRE_CHANNEL: 'dev' },
    });
    expect(cli.runnerInvocation(['auth', 'login'])).toEqual({
      cliArgs: [...checkoutCli, 'auth', 'login'],
      cliEnv: { GITQUIRE_CHANNEL: 'dev' },
    });
    expect(cli.refusalFor(['auth', 'login'])).toBeUndefined();
  });

  it('never hands dev to the CLI on PATH, which a released build may be', () => {
    const cli = GqCliCommand.resolve({ env: { GITQUIRE_CHANNEL: 'dev' } });
    expect(cli.runnerInvocation(['auth', 'status'])).toEqual({
      cliArgs: ['gitquire', 'auth', 'status'],
      cliEnv: {},
    });
    expect(cli.spawn(['status'], { PATH: '/usr/bin', GITQUIRE_CHANNEL: 'dev' })).toEqual({
      command: 'gitquire',
      args: ['status'],
      env: { PATH: '/usr/bin' },
    });
  });

  it.each([
    [['auth', 'login', '--json']],
    [['auth', 'pat', '--token-stdin']],
    [['auth', 'token']],
    [['auth', 'signout', '--host', 'github.com']],
    [['clone', '--json', 'https://github.com/o/r.git', '/tmp/r']],
    [['start', '--port', '0']],
  ])('refuses %j on every path when a dev build falls back to the CLI on PATH', (args) => {
    const cli = GqCliCommand.resolve({ env: { GITQUIRE_CHANNEL: 'dev' } });
    expect(cli.refusalFor(args)).toBe(DEV_FALLBACK_CLI_REFUSAL);
    expect(cli.runnerInvocation(args)).toEqual({ refused: DEV_FALLBACK_CLI_REFUSAL });
    expect(cli.spawn(args, {})).toEqual({ refused: DEV_FALLBACK_CLI_REFUSAL });
    expect(() => cli.stdioServer(args)).toThrow(DEV_FALLBACK_CLI_REFUSAL);
    expect(() => cli.shellCommand(args, (part) => part)).toThrow(DEV_FALLBACK_CLI_REFUSAL);
  });

  it('tells the developer to build and restart, since the CLI is resolved once per launch', () => {
    expect(DEV_FALLBACK_CLI_REFUSAL).toContain('pnpm build');
    expect(DEV_FALLBACK_CLI_REFUSAL).toContain('restart this dev build');
    expect(DEV_FALLBACK_CLI_REFUSAL).not.toMatch(/retry/i);
  });

  it('lets a fallback dev build read through the CLI on PATH', () => {
    const cli = GqCliCommand.resolve({ env: { GITQUIRE_CHANNEL: 'dev' } });
    expect(cli.refusalFor(['auth', 'status'])).toBeUndefined();
    expect(cli.refusalFor(['auth', 'git-credential'])).toBeUndefined();
    expect(cli.refusalFor(['share', 'owners', '--json'])).toBeUndefined();
  });

  it('pins a shipped non-Stable channel on any CLI', () => {
    expect(
      GqCliCommand.resolve({
        host: { cliArgs: [] },
        env: { GITQUIRE_CHANNEL: 'beta' },
      }).runnerInvocation([]),
    ).toEqual({
      cliArgs: ['gitquire'],
      cliEnv: { GITQUIRE_CHANNEL: 'beta' },
    });
  });

  it('pins nothing on Stable and refuses nothing', () => {
    const cli = GqCliCommand.resolve({
      host: { cliArgs: ['ok'] },
      env: { GITQUIRE_CHANNEL: 'stable' },
    });
    expect(cli.runnerInvocation(['start'])).toEqual({ cliArgs: ['ok', 'start'], cliEnv: {} });
    expect(cli.refusalFor(['auth', 'login'])).toBeUndefined();
  });

  it('carries the channel with the argv into every form a caller can take', () => {
    const cli = GqCliCommand.resolve({
      host: { cliArgs: checkoutCli },
      env: { GITQUIRE_CHANNEL: 'dev' },
    });
    expect(cli.spawn(['mcp'], { GITQUIRE_CHANNEL: 'dev', HOME: '/h' })).toEqual({
      command: 'node',
      args: ['/src/cli.mjs', 'mcp'],
      env: { HOME: '/h', GITQUIRE_CHANNEL: 'dev' },
    });
    expect(cli.stdioServer(['mcp'])).toEqual({
      command: 'node',
      args: ['/src/cli.mjs', 'mcp'],
      env: { GITQUIRE_CHANNEL: 'dev' },
    });
    expect(cli.shellCommand(['auth', 'git-credential'], (part) => part)).toBe(
      'GITQUIRE_CHANNEL=dev node /src/cli.mjs auth git-credential',
    );
  });
});
