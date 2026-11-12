import { type SVGProps, useId } from 'react';

export function OkIcon(props: SVGProps<SVGSVGElement>) {
  const gradientId = `gq-bg-${useId().replace(/:/g, '')}`;
  return (
    <svg
      role="img"
      aria-label="GitQuire icon"
      fill="none"
      height={24}
      width={24}
      viewBox="0 0 64 64"
      xmlns="http://www.w3.org/2000/svg"
      {...props}
    >
      <title>GitQuire icon</title>
      <defs>
        <linearGradient
          id={gradientId}
          x1="6"
          y1="4"
          x2="58"
          y2="60"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#0F766E" />
          <stop offset="1" stopColor="#1E3A8A" />
        </linearGradient>
      </defs>
      <rect x="2" y="2" width="60" height="60" rx="14" fill={`url(#${gradientId})`} />
      <rect x="21" y="12" width="26" height="34" rx="4" fill="#FFFFFF" fillOpacity="0.45" />
      <rect x="15" y="18" width="26" height="34" rx="4" fill="#FFFFFF" />
      <path
        d="M21 27h14M21 33h14M21 39h9"
        stroke="#1E3A8A"
        strokeWidth="2.5"
        strokeLinecap="round"
      />
      <path d="M47 46v-8a6 6 0 0 0-6-6" stroke="#FDE68A" strokeWidth="3" strokeLinecap="round" />
      <circle cx="47" cy="49" r="4" fill="#FDE68A" />
    </svg>
  );
}
