// Minimal line icons (inline SVG, no external assets).
const P: Record<string, string> = {
  star: "M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z",
  gauge: "M4 16a8 8 0 1 1 16 0M12 16l4-6M7 16h.01M17 16h.01",
  gear: "M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1",
  info: "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 11v6M12 7h.01",
  power: "M12 3v9M6.3 6.3a8 8 0 1 0 11.4 0",
  exit: "M14 4h6v16h-6M3 12h12M11 8l4 4-4 4",
  search: "M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM21 21l-5-5",
  help: "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6V14M12 17h.01",
  reset: "M3 12a9 9 0 1 0 3-6.7M3 4v5h5",
};

export function Icon({ name }: { name: string }) {
  return (
    <svg className="ico" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={P[name] ?? P.info} />
    </svg>
  );
}
