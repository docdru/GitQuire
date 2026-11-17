import { Command } from 'commander';
import { getCliLogger } from '../cli-logger.ts';
import { collectReportBundle } from '../report-bundle.ts';
import { defaultBugReportZipPath } from './bug-report-bundle.ts';

export function bugReportCommand(): Command {
  return new Command('bug-report')
    .description('Generate a diagnostic bundle for bug reporting')
    .action(async () => {
      try {
        const { zipPath, summary } = await collectReportBundle({
          level: 'standard',
          projectDir: process.cwd(),
          redact: true,
          outputPath: defaultBugReportZipPath(),
          logger: getCliLogger(),
        });

        process.stdout.write(`${zipPath}\n`);

        if (summary.redactedLineCount > 0) {
          process.stderr.write(
            `gq bug-report: ${summary.redactedLineCount} line(s) auto-redacted across ${summary.redactions.length} file(s)\n`,
          );
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`gq bug-report: failed — ${msg}\n`);
        process.exitCode = 1;
      }
    });
}
