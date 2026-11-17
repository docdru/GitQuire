import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { RereadFromDiskSetting } from './RereadFromDiskSetting';

const toastMock = vi.hoisted(() => ({ success: vi.fn(), warning: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast: toastMock }));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function reply(status: number, body: unknown): typeof fetch {
  return vi.fn(async () => new Response(JSON.stringify(body), { status })) as typeof fetch;
}

describe('RereadFromDiskSetting', () => {
  test('asks the server to re-read and reports what it took in', async () => {
    const fetchImpl = reply(200, { status: 'completed', found: 3 });
    render(<RereadFromDiskSetting fetchImpl={fetchImpl} />);
    fireEvent.click(screen.getByTestId('reread-from-disk-button'));
    await waitFor(() =>
      expect(toastMock.success).toHaveBeenCalledWith('Re-read the files and took in 3 changes.'),
    );
    expect(fetchImpl).toHaveBeenCalledWith(
      '/api/documents/reread',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  test('says when nothing changed', async () => {
    render(<RereadFromDiskSetting fetchImpl={reply(200, { status: 'completed', found: 0 })} />);
    fireEvent.click(screen.getByTestId('reread-from-disk-button'));
    await waitFor(() =>
      expect(toastMock.success).toHaveBeenCalledWith('Re-read the files. Nothing had changed.'),
    );
  });

  test('shows an error when the server refuses', async () => {
    render(<RereadFromDiskSetting fetchImpl={reply(503, {})} />);
    fireEvent.click(screen.getByTestId('reread-from-disk-button'));
    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith("Couldn't re-read the files. Try again."),
    );
  });
});
