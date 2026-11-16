export const REPORT_SIDECAR_BUNDLE_DIR = 'state/bug-reports';

const REPORT_SIDECAR_STATES = [
  'generated',
  'uploading',
  'sent',
  'upload-failed',
  'email-drafted',
] as const;

type ReportSidecarKnownState = (typeof REPORT_SIDECAR_STATES)[number];

export type ReportSidecarState = ReportSidecarKnownState | 'unknown';

export const REPORT_SENT_MARKER_SUFFIX = '.sent.yaml';
