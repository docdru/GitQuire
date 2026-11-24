import { cn } from '@/lib/utils';

export function LeftTruncatedName({
  name,
  className,
  ...rest
}: {
  name: string;
  className?: string;
  'data-testid'?: string;
  'data-app-header-center-label'?: string;
}) {
  return (
    <span
      dir="rtl"
      title={name}
      className={cn('min-w-0 truncate text-start', className)}
      data-full-name={name}
      {...rest}
    >
      <bdi dir="ltr">{name}</bdi>
    </span>
  );
}
