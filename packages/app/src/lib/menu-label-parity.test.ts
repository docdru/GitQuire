import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { COMMAND_IDENTITIES, MENU_LABELS } from '@inkeep/open-knowledge-core';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  PALETTE_COMMAND_LABELS,
  type PaletteLabelKey,
} from '@/components/command-palette-commands';
import { i18n } from '@/lib/i18n';

function collectStrings(node: unknown, out: Set<string>): void {
  if (typeof node === 'string') {
    out.add(node);
  } else if (Array.isArray(node)) {
    for (const child of node) collectStrings(child, out);
  } else if (node && typeof node === 'object') {
    for (const child of Object.values(node)) collectStrings(child, out);
  }
}

const catalogStrings = new Set<string>();

beforeAll(() => {
  i18n.activate('en');
  const catalog = JSON.parse(
    readFileSync(join(import.meta.dir, '..', 'locales', 'en', 'messages.json'), 'utf8'),
  ) as { messages: Record<string, unknown> };
  collectStrings(catalog.messages, catalogStrings);
});

describe('shared menu labels stay in sync between the native menu and the renderer', () => {
  for (const [key, label] of Object.entries(MENU_LABELS)) {
    it(`renderer catalog contains MENU_LABELS.${key} ("${label}")`, () => {
      expect(catalogStrings.has(label)).toBe(true);
    });
  }
});

describe('palette label map covers every registry labelKey (Phase 2b)', () => {
  for (const cmd of COMMAND_IDENTITIES) {
    if (!cmd.palette) continue;
    const keys = cmd.stateToggle
      ? [cmd.stateToggle.showKey, cmd.stateToggle.hideKey]
      : cmd.placementToggle
        ? [cmd.placementToggle.bottomKey, cmd.placementToggle.rightKey]
        : cmd.labelKey !== undefined
          ? [cmd.labelKey]
          : [];
    for (const key of keys) {
      it(`palette command "${cmd.id}" label key "${key}" has a descriptor`, () => {
        expect(key in PALETTE_COMMAND_LABELS).toBe(true);
      });
    }
  }
});

describe('every palette descriptor is in the catalog and agrees with MENU_LABELS', () => {
  for (const [key, descriptor] of Object.entries(PALETTE_COMMAND_LABELS)) {
    const paletteString = i18n._(descriptor);
    it(`palette label "${key}" resolves to a catalog string`, () => {
      expect(catalogStrings.has(paletteString)).toBe(true);
    });
    if (key in MENU_LABELS) {
      it(`palette label "${key}" equals MENU_LABELS.${key}`, () => {
        expect(paletteString).toBe(MENU_LABELS[key as keyof typeof MENU_LABELS]);
      });
    }
  }

  it('every palette label key is a MENU_LABELS key (no orphan palette labels)', () => {
    const orphans = (Object.keys(PALETTE_COMMAND_LABELS) as PaletteLabelKey[]).filter(
      (key) => !(key in MENU_LABELS),
    );
    expect(orphans).toEqual([]);
  });
});
