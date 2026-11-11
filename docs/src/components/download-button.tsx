const UPSTREAM_DOWNLOAD_URL = 'https://openknowledge.ai/download';

export function DownloadButton(_props: { cta?: string }) {
  return (
    <p className="my-4 rounded-lg border bg-fd-card p-4 text-sm">
      The desktop app described here is OpenKnowledge's. GitQuire runs as a self-hosted server
      instead; see <a href="../../gitquire/run-with-docker/">Run with Docker</a>. To try the desktop
      app, download it from{' '}
      <a href={UPSTREAM_DOWNLOAD_URL} target="_blank" rel="noreferrer">
        OpenKnowledge
      </a>
      .
    </p>
  );
}
