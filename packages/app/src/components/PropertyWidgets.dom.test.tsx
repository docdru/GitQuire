import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { ListWidget, TextWidget } from './PropertyWidgets';
import { resetPropertyLinkPages } from './property-link-picker';

function renderWidget(opts: {
  keyName: string;
  value: string[];
  onCommit?: (next: string[]) => void;
}) {
  const onCommit = opts.onCommit ?? vi.fn(() => {});
  const result = render(
    <TooltipProvider>
      <ListWidget keyName={opts.keyName} value={opts.value} onCommit={onCommit} />
    </TooltipProvider>,
  );
  return { ...result, onCommit };
}

describe('ListWidget — render-side invalid tag flagging', () => {
  afterEach(() => {
    cleanup();
  });

  test('seed of mixed valid + invalid tags yields the right chip count + invalid flags', () => {
    const { container } = renderWidget({
      keyName: 'tags',
      value: ['showcase', '2026', 'has spaces', 'proj/team', 'hello!'],
    });
    const chips = container.querySelectorAll('[data-testid="list-chip"]');
    expect(chips).toHaveLength(5);
    const invalid = container.querySelectorAll('[data-tag-invalid="true"]');
    expect(invalid).toHaveLength(2);
    const invalidTexts = Array.from(invalid).map((el) =>
      (el.textContent ?? '').replace(/\s+/g, ' ').trim(),
    );
    expect(invalidTexts.some((t) => t.includes('2026'))).toBe(false);
    expect(invalidTexts.some((t) => t.includes('has spaces'))).toBe(true);
    expect(invalidTexts.some((t) => t.includes('hello!'))).toBe(true);
  });

  test('a non-tag list field (categories, aliases, …) never flags chips as invalid', () => {
    const { container } = renderWidget({
      keyName: 'aliases',
      value: ['has spaces', '2026', 'hello!'],
    });
    expect(container.querySelectorAll('[data-tag-invalid="true"]')).toHaveLength(0);
  });

  test('invalid chips are wrapped in a Radix Tooltip trigger (content lazy-renders on open)', () => {
    const { container } = renderWidget({ keyName: 'tags', value: ['bad!'] });
    const invalidChip = container.querySelector('[data-tag-invalid="true"]');
    expect(invalidChip?.getAttribute('data-slot')).toBe('tooltip-trigger');
  });

  test('valid tag chips are NOT wrapped in a Tooltip (tooltip is diagnostic-only)', () => {
    const { container } = renderWidget({ keyName: 'tags', value: ['showcase'] });
    const chip = container.querySelector('[data-testid="list-chip"]');
    expect(chip?.getAttribute('data-slot')).not.toBe('tooltip-trigger');
  });

  test('valid tags render as `#tag` clickable buttons (unchanged from pre-PR behavior)', () => {
    const { container } = renderWidget({ keyName: 'tags', value: ['showcase'] });
    const tagBtn = container.querySelector('button[data-tag="showcase"]');
    expect(tagBtn).not.toBeNull();
    expect(tagBtn?.textContent).toBe('#showcase');
  });
});

describe('ListWidget — input-side grammar gate (tags field only)', () => {
  afterEach(() => {
    cleanup();
  });

  test('addChip rejects invalid input on Enter — no onCommit fires; draft persists', () => {
    const onCommit = vi.fn(() => {});
    const { container } = renderWidget({ keyName: 'tags', value: [], onCommit });
    const input = container.querySelector('[data-testid="list-chip-input"]') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'bad!' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onCommit).toHaveBeenCalledTimes(0);
    expect(input.value).toBe('bad!');
    expect(input.getAttribute('data-tag-invalid')).toBe('true');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    const alert = container.querySelector('[data-testid="list-chip-input-error"]');
    expect(alert).not.toBeNull();
    expect(alert?.getAttribute('role')).toBe('alert');
    expect(alert?.textContent).toContain('Tags must start with a letter');
  });

  test('addChip accepts a valid tag on Enter — commits + clears draft + no rejection state', () => {
    const onCommit = vi.fn(() => {});
    const { container } = renderWidget({ keyName: 'tags', value: [], onCommit });
    const input = container.querySelector('[data-testid="list-chip-input"]') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'showcase' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit.mock.calls[0]?.[0]).toEqual(['showcase']);
    expect(input.value).toBe('');
    expect(input.getAttribute('aria-invalid')).toBeNull();
    expect(container.querySelector('[data-testid="list-chip-input-error"]')).toBeNull();
  });

  test('addChip accepts a digit-leading tag like a year (2026)', () => {
    const onCommit = vi.fn(() => {});
    const { container } = renderWidget({ keyName: 'tags', value: [], onCommit });
    const input = container.querySelector('[data-testid="list-chip-input"]') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '2026' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit.mock.calls[0]?.[0]).toEqual(['2026']);
    expect(input.value).toBe('');
    expect(input.getAttribute('aria-invalid')).toBeNull();
  });

  test('typing after a rejection clears the rejection state immediately', () => {
    const { container } = renderWidget({ keyName: 'tags', value: [] });
    const input = container.querySelector('[data-testid="list-chip-input"]') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'bad!' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(input.getAttribute('aria-invalid')).toBe('true');
    fireEvent.change(input, { target: { value: 'bad!x' } });
    expect(input.getAttribute('aria-invalid')).toBeNull();
    expect(container.querySelector('[data-testid="list-chip-input-error"]')).toBeNull();
  });

  test('Escape clears rejection state without committing', () => {
    const onCommit = vi.fn(() => {});
    const { container } = renderWidget({ keyName: 'tags', value: [], onCommit });
    const input = container.querySelector('[data-testid="list-chip-input"]') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'bad!' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(input.getAttribute('aria-invalid')).toBe('true');
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(input.getAttribute('aria-invalid')).toBeNull();
    expect(onCommit).toHaveBeenCalledTimes(0);
  });

  test('input strips leading `#` before commit (Obsidian-shape paste tolerance)', () => {
    const onCommit = vi.fn(() => {});
    const { container } = renderWidget({ keyName: 'tags', value: [], onCommit });
    const input = container.querySelector('[data-testid="list-chip-input"]') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '#showcase' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit.mock.calls[0]?.[0]).toEqual(['showcase']);
    expect(input.value).toBe('');
    expect(input.getAttribute('aria-invalid')).toBeNull();
  });

  test('a non-tag list field preserves a leading `#` (no tags-specific normalization)', () => {
    const onCommit = vi.fn(() => {});
    const { container } = renderWidget({ keyName: 'aliases', value: [], onCommit });
    const input = container.querySelector('[data-testid="list-chip-input"]') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '#literal' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit.mock.calls[0]?.[0]).toEqual(['#literal']);
  });

  test('a non-tag list field commits any string — grammar gate stays scoped', () => {
    const onCommit = vi.fn(() => {});
    const { container } = renderWidget({ keyName: 'aliases', value: [], onCommit });
    const input = container.querySelector('[data-testid="list-chip-input"]') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '2026' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit.mock.calls[0]?.[0]).toEqual(['2026']);
    expect(input.value).toBe('');
  });
});

function renderTextWidget(opts: {
  keyName: string;
  value: string;
  onCommit?: (next: string) => void;
}) {
  const onCommit = opts.onCommit ?? vi.fn(() => {});
  const result = render(
    <TooltipProvider>
      <TextWidget keyName={opts.keyName} value={opts.value} onCommit={onCommit} />
    </TooltipProvider>,
  );
  return { ...result, onCommit };
}

describe('TextWidget — link-mode predicate', () => {
  afterEach(() => {
    cleanup();
  });

  test('http URL renders as link-widget with correct href + aria-label', () => {
    const { container } = renderTextWidget({
      keyName: 'linear',
      value: 'https://linear.app/inkeep/issue/PRD-6781',
    });
    const link = container.querySelector('[data-testid="link-widget"]');
    expect(link).not.toBeNull();
    const anchor = link?.querySelector('a');
    expect(anchor?.getAttribute('href')).toBe('https://linear.app/inkeep/issue/PRD-6781');
    expect(anchor?.getAttribute('target')).toBe('_blank');
    expect(anchor?.getAttribute('rel')).toBe('noopener noreferrer');
    expect(anchor?.getAttribute('aria-label')).toBe('Open linear in browser');
    expect(container.querySelector('[data-testid="text-widget"]')).toBeNull();
  });

  test('https URL with mixed case is still recognized (regex is /^https?:\\/\\//i)', () => {
    const { container } = renderTextWidget({ keyName: 'site', value: 'HTTPS://example.com' });
    expect(container.querySelector('[data-testid="link-widget"]')).not.toBeNull();
  });

  test('empty string renders as text-widget, NOT link-widget (zero-width chip bug guard)', () => {
    const { container } = renderTextWidget({ keyName: 'note', value: '' });
    expect(container.querySelector('[data-testid="link-widget"]')).toBeNull();
    expect(container.querySelector('[data-testid="text-widget"]')).not.toBeNull();
  });

  test('whitespace-only value renders as text-widget (trim before scheme check)', () => {
    const { container } = renderTextWidget({ keyName: 'note', value: '   ' });
    expect(container.querySelector('[data-testid="link-widget"]')).toBeNull();
    expect(container.querySelector('[data-testid="text-widget"]')).not.toBeNull();
  });

  test.each([
    ['relative path', '/abs/path'],
    ['relative sibling', './sib'],
    ['anchor', '#section'],
    ['query', '?q=1'],
    ['mailto scheme', 'mailto:user@example.com'],
    ['tel scheme', 'tel:+15551234567'],
    ['ftp scheme', 'ftp://files.example.com'],
    ['plain text', 'just some notes'],
  ])('non-http(s) value (%s = %s) renders as text-widget', (_label, value) => {
    const { container } = renderTextWidget({ keyName: 'note', value });
    expect(container.querySelector('[data-testid="link-widget"]')).toBeNull();
    expect(container.querySelector('[data-testid="text-widget"]')).not.toBeNull();
  });

  test('pencil click switches link view → textarea edit view', () => {
    const { container } = renderTextWidget({ keyName: 'site', value: 'https://example.com' });
    expect(container.querySelector('[data-testid="link-widget"]')).not.toBeNull();
    const pencil = container.querySelector('[data-testid="link-widget-edit"]') as HTMLButtonElement;
    expect(pencil).not.toBeNull();
    fireEvent.click(pencil);
    expect(container.querySelector('[data-testid="link-widget"]')).toBeNull();
    expect(container.querySelector('[data-testid="text-widget"]')).not.toBeNull();
  });

  test('textarea blur with URL value returns to link view', () => {
    const { container } = renderTextWidget({ keyName: 'site', value: 'https://example.com' });
    const pencil = container.querySelector('[data-testid="link-widget-edit"]') as HTMLButtonElement;
    fireEvent.click(pencil);
    const textarea = container.querySelector('[data-testid="text-widget"]') as HTMLTextAreaElement;
    expect(textarea).not.toBeNull();
    fireEvent.blur(textarea);
    expect(container.querySelector('[data-testid="link-widget"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="text-widget"]')).toBeNull();
  });

  test('edit + change + blur commits the new URL value', () => {
    const commits: string[] = [];
    const { container } = renderTextWidget({
      keyName: 'site',
      value: 'https://example.com',
      onCommit: (next) => commits.push(next),
    });
    const pencil = container.querySelector('[data-testid="link-widget-edit"]') as HTMLButtonElement;
    fireEvent.click(pencil);
    const textarea = container.querySelector('[data-testid="text-widget"]') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'https://updated.com' } });
    fireEvent.blur(textarea);
    expect(commits).toEqual(['https://updated.com']);
    expect(container.querySelector('[data-testid="link-widget"]')).not.toBeNull();
  });
});

describe('property values — link picker after [[', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    resetPropertyLinkPages();
  });

  function stubPages() {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown) => {
        const url = String(input);
        if (url.includes('/api/pages')) {
          return new Response(
            JSON.stringify({
              pages: [
                {
                  docName: 'plans/roadmap',
                  title: 'Roadmap',
                  docExt: '.md',
                  size: 1,
                  modified: '2026-01-01T00:00:00.000Z',
                },
              ],
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        return new Response(JSON.stringify({ documents: [] }), { status: 200 });
      }),
    );
  }

  test('a text value: choosing a page writes the link', async () => {
    stubPages();
    const onCommit = vi.fn();
    const { getByTestId, findByTestId } = render(
      <TextWidget keyName="supersedes" value="" onCommit={onCommit} />,
    );
    const textarea = getByTestId('text-widget') as HTMLTextAreaElement;
    textarea.focus();
    fireEvent.change(textarea, { target: { value: '[[road', selectionStart: 6 } });
    await findByTestId('property-link-option-plans/roadmap');
    fireEvent.keyDown(textarea, { key: 'Enter' });
    expect(textarea.value).toBe('[[plans/roadmap]]');
    expect(onCommit).not.toHaveBeenCalled();
    fireEvent.keyDown(textarea, { key: 'Enter' });
    expect(onCommit).toHaveBeenCalledWith('[[plans/roadmap]]');
  });

  test('a list value: choosing a page adds it as an item', async () => {
    stubPages();
    const { getByTestId, findByTestId, onCommit } = renderWidget({ keyName: 'blocks', value: [] });
    const input = getByTestId('list-chip-input') as HTMLInputElement;
    input.focus();
    fireEvent.change(input, { target: { value: '[[road', selectionStart: 6 } });
    fireEvent.mouseDown(await findByTestId('property-link-option-plans/roadmap'));
    expect(onCommit).toHaveBeenCalledWith(['[[plans/roadmap]]']);
  });

  test('Escape closes the picker without dropping what was typed', async () => {
    stubPages();
    const { getByTestId, findByTestId, queryByTestId } = render(
      <TextWidget keyName="supersedes" value="" onCommit={vi.fn()} />,
    );
    const textarea = getByTestId('text-widget') as HTMLTextAreaElement;
    textarea.focus();
    fireEvent.change(textarea, { target: { value: '[[road', selectionStart: 6 } });
    await findByTestId('property-link-picker');
    fireEvent.keyDown(textarea, { key: 'Escape' });
    expect(queryByTestId('property-link-picker')).toBeNull();
    expect(textarea.value).toBe('[[road');
  });
});
