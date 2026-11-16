import { t } from '@lingui/core/macro';

type OkignoreWarningCode =
  | 'trailing-backslash'
  | 'unmatched-bracket'
  | 'lone-bang'
  | 'leading-whitespace'
  | 'embedded-newline';

export interface OkignoreWarning {
  readonly code: OkignoreWarningCode;
  readonly message: string;
}

export function warningMessage(code: OkignoreWarningCode): string {
  switch (code) {
    case 'trailing-backslash':
      return t`Trailing backslash — line continuation isn't supported.`;
    case 'unmatched-bracket':
      return t`Unmatched [ — character class is open.`;
    case 'lone-bang':
      return t`Lone ! — negation needs a pattern after it.`;
    case 'leading-whitespace':
      return t`Leading whitespace — the rule may not match as expected.`;
    case 'embedded-newline':
      return t`Embedded line break — the row spans multiple lines.`;
  }
}

export function checkHeuristicWarnings(line: string): OkignoreWarning[] {
  const warnings: OkignoreWarning[] = [];
  if (line.length === 0) return warnings;
  if (line.trimStart().startsWith('#')) return warnings;

  if (/[\r\n]/.test(line)) {
    warnings.push({ code: 'embedded-newline', message: warningMessage('embedded-newline') });
  }
  if (/^\s/.test(line)) {
    warnings.push({ code: 'leading-whitespace', message: warningMessage('leading-whitespace') });
  }

  const trimmed = line.trim();
  if (trimmed === '!') {
    warnings.push({ code: 'lone-bang', message: warningMessage('lone-bang') });
  }
  if (trimmed.endsWith('\\')) {
    warnings.push({
      code: 'trailing-backslash',
      message: warningMessage('trailing-backslash'),
    });
  }

  const opens = countMatches(trimmed, '[');
  const closes = countMatches(trimmed, ']');
  if (opens > closes) {
    warnings.push({ code: 'unmatched-bracket', message: warningMessage('unmatched-bracket') });
  }

  return warnings;
}

function countMatches(s: string, ch: string): number {
  let count = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === ch) count++;
  }
  return count;
}
