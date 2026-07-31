export function DinoMark({ size = 22 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M9 26v-4.5c0-4 2.6-6.6 6-7.2" />
      <path d="M23 26v-5.4" />
      <path d="M12.4 14.4c0-4 3-6.9 7-6.9 3.2 0 5.6 1.8 5.6 1.8l2.4-1-.8 2.6c.6 1 .9 2.2.9 3.5 0 3.6-2.4 6-6.2 6.6" />
      <path d="M21.6 12.1h.02" strokeWidth="2.6" />
      <path d="M12.4 14.4c-2.6.5-4.4 1.6-5.9 3.2C5.4 18.9 4.6 20.4 4 22" />
      <path d="M18.9 21c-1.8 1.1-3.4 2.6-4.4 4.3" />
    </svg>
  );
}
