import { registerCustomTheme } from '@pierre/diffs';
import { GQ_SYNTAX_THEME_NAME, okSyntaxTheme } from './ok-syntax-theme';

let registered = false;

export function okPierreTheme(): string {
  if (!registered) {
    registerCustomTheme(GQ_SYNTAX_THEME_NAME, () => Promise.resolve(okSyntaxTheme));
    registered = true;
  }
  return GQ_SYNTAX_THEME_NAME;
}
