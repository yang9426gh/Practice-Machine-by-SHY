export function CassetteLogo({ size = 26 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true">
      <defs>
        <linearGradient id="cass-body" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#2e2e38" />
          <stop offset="1" stopColor="#17171c" />
        </linearGradient>
        <linearGradient id="cass-label" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#fbbf24" />
          <stop offset="1" stopColor="#d97706" />
        </linearGradient>
      </defs>
      <rect x="4" y="16" width="56" height="32" rx="5" fill="url(#cass-body)" stroke="#f59e0b" strokeWidth="2.5" />
      <rect x="9" y="20" width="46" height="9" rx="2" fill="url(#cass-label)" />
      <rect x="14" y="32" width="36" height="11" rx="5.5" fill="#08080a" />
      <circle cx="26" cy="37.5" r="4" fill="#ececf1" />
      <circle cx="38" cy="37.5" r="4" fill="#ececf1" />
      <circle cx="26" cy="37.5" r="1.6" fill="#08080a" />
      <circle cx="38" cy="37.5" r="1.6" fill="#08080a" />
    </svg>
  );
}

export function BrandHeader({ compact = false }: { compact?: boolean }) {
  return (
    <div className="flex items-center justify-center gap-2 select-none pointer-events-none">
      <CassetteLogo size={compact ? 20 : 26} />
      <div className="text-center leading-none">
        <div
          className={`font-extrabold tracking-tight bg-gradient-to-r from-amber-200 via-amber-400 to-orange-500 bg-clip-text text-transparent ${
            compact ? "text-sm" : "text-lg"
          }`}
        >
          Practice Machine
        </div>
        <div
          className={`font-medium tracking-[0.35em] text-zinc-500 uppercase ${
            compact ? "text-[8px] mt-0.5" : "text-[9px] mt-1"
          }`}
        >
          by SHY
        </div>
      </div>
    </div>
  );
}
