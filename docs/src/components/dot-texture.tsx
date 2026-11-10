import Image from 'next/image';
import { cn } from '@/lib/utils';

type DotTextureVariant = 'right' | 'left';

interface DotTextureProps {
  variant: DotTextureVariant;
  className?: string;
  priority?: boolean;
}

const VARIANTS: Record<DotTextureVariant, { src: string; width: number; height: number }> = {
  right: {
    src: '/images/home/hero-dotted-bg.svg',
    width: 482,
    height: 389,
  },
  left: {
    src: '/images/home/dotted-bg-left.svg',
    width: 515,
    height: 858,
  },
};

export function DotTexture({ variant, className, priority }: DotTextureProps) {
  const { src, width, height } = VARIANTS[variant];
  return (
    <Image
      src={src}
      alt=""
      aria-hidden
      width={width}
      height={height}
      priority={priority}
      className={cn('pointer-events-none absolute z-0 h-auto select-none', className)}
    />
  );
}
