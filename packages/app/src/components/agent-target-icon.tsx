import type { TargetData } from '@inkeep/open-knowledge-core/handoff';
import {
  AGENT_ICON_COLORS,
  AGENT_ICON_COLORS_DARK,
} from '@inkeep/open-knowledge-core/utils/identity';
import { useTheme } from 'next-themes';
import type { CSSProperties, ReactNode, SVGProps } from 'react';
import { AntigravityIcon } from '@/components/icons/antigravity';
import { ClaudeIcon } from '@/components/icons/claude';
import { CodexBrandIcon } from '@/components/icons/codex';
import { CopilotIcon } from '@/components/icons/copilot';
import { CursorIcon } from '@/components/icons/cursor';
import { HermesIcon } from '@/components/icons/hermes';
import { OpenClawIcon } from '@/components/icons/openclaw';
import { OpenCodeIcon } from '@/components/icons/opencode';
import { PiIcon } from '@/components/icons/pi';
import { cn } from '@/lib/utils';

const TARGET_ICON_KEY: Record<TargetData['id'], string> = {
  'claude-cowork': 'claude',
  'claude-code': 'claude',
  codex: 'openai',
  cursor: 'cursor',
  copilot: 'github',
  opencode: 'opencode',
  pi: 'pi',
  antigravity: 'antigravity',
  openclaw: 'openclaw',
  hermes: 'hermes',
};

export function TargetIcon({
  id,
  style,
  className,
  ...props
}: { id: TargetData['id'] } & SVGProps<SVGSVGElement>): ReactNode {
  const { resolvedTheme } = useTheme();
  const iconKey = TARGET_ICON_KEY[id];
  const isDark = resolvedTheme === 'dark';
  const brandColor = iconKey
    ? ((isDark ? AGENT_ICON_COLORS_DARK[iconKey] : undefined) ?? AGENT_ICON_COLORS[iconKey])
    : undefined;
  const mergedStyle = brandColor
    ? ({ ...style, '--ok-brand-color': brandColor } as CSSProperties)
    : style;
  const mergedClass = cn(brandColor && '[&_*]:![color:var(--ok-brand-color)]', className);
  if (id === 'claude-cowork' || id === 'claude-code')
    return <ClaudeIcon style={mergedStyle} className={mergedClass} {...props} />;
  if (id === 'codex')
    return <CodexBrandIcon style={mergedStyle} className={mergedClass} {...props} />;
  if (id === 'cursor') return <CursorIcon style={mergedStyle} className={mergedClass} {...props} />;
  if (id === 'copilot')
    return <CopilotIcon style={mergedStyle} className={mergedClass} {...props} />;
  if (id === 'opencode')
    return <OpenCodeIcon style={mergedStyle} className={mergedClass} {...props} />;
  if (id === 'pi') return <PiIcon style={mergedStyle} className={mergedClass} {...props} />;
  if (id === 'antigravity')
    return <AntigravityIcon style={mergedStyle} className={mergedClass} {...props} />;
  if (id === 'openclaw')
    return <OpenClawIcon style={mergedStyle} className={mergedClass} {...props} />;
  if (id === 'hermes') return <HermesIcon style={mergedStyle} className={mergedClass} {...props} />;
  return null;
}
