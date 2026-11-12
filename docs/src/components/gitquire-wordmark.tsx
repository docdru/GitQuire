import type { SVGProps } from 'react';

export function GitQuireWordmark(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 168 40" fill="none" xmlns="http://www.w3.org/2000/svg" role="img" {...props}>
      <title>GitQuire</title>
      <rect x="1" y="1" width="38" height="38" rx="9" fill="#0F766E" />
      <rect x="13" y="7" width="17" height="22" rx="2.5" fill="#FFFFFF" fillOpacity="0.45" />
      <rect x="9" y="11" width="17" height="22" rx="2.5" fill="#FFFFFF" />
      <path d="M13 17h9M13 21h9M13 25h6" stroke="#1E3A8A" strokeWidth="1.8" strokeLinecap="round" />
      <path d="M30 29v-5a4 4 0 0 0-4-4" stroke="#FDE68A" strokeWidth="2" strokeLinecap="round" />
      <circle cx="30" cy="31" r="2.6" fill="#FDE68A" />
      <text
        x="48"
        y="27"
        fill="currentColor"
        fontFamily="var(--font-dm-sans), system-ui, sans-serif"
        fontSize="22"
        fontWeight="600"
      >
        GitQuire
      </text>
    </svg>
  );
}
