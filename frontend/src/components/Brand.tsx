"use client";

import { useState } from "react";
import { createPortal } from "react-dom";

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

function VenmoMark() {
  return <span className="font-extrabold text-lg tracking-tight text-[#008CFF]">venmo</span>;
}

function PayPalMark() {
  return (
    <span className="font-extrabold italic text-lg tracking-tight">
      <span className="text-[#0f5fbf]">Pay</span>
      <span className="text-[#009CDE]">Pal</span>
    </span>
  );
}

function ZelleMark() {
  return <span className="font-extrabold text-lg tracking-tight text-[#6D1ED4]">Zelle</span>;
}

export function SupportButton() {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  const copyZelle = async () => {
    try {
      await navigator.clipboard.writeText("yang9426@gmail.com");
    } catch {}
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="px-2.5 py-1.5 rounded-lg border border-zinc-700 text-xs text-zinc-300 hover:bg-zinc-800 hover:text-white transition-colors shrink-0"
        title="Support"
      >
        ♥ Support
      </button>

      {/* Portal로 body에 렌더 — 헤더의 backdrop-blur가 fixed 기준점을 바꾸는 문제 회피 */}
      {open && typeof document !== "undefined"
        ? createPortal(
            <div
              className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 backdrop-blur-sm p-4"
              onClick={() => setOpen(false)}
            >
              <div
                className="bg-zinc-900 border border-zinc-700 rounded-2xl p-5 w-[340px] max-w-[92vw] shadow-2xl"
                onClick={(e) => e.stopPropagation()}
              >
                <div className="flex items-center justify-between mb-4">
                  <div className="text-base font-bold text-zinc-100">Support ♥</div>
                  <button
                    onClick={() => setOpen(false)}
                    className="w-7 h-7 rounded-lg text-zinc-500 hover:text-white hover:bg-zinc-800 transition-colors"
                    title="닫기"
                  >
                    ✕
                  </button>
                </div>

                {/* Venmo */}
                <a
                  href="https://venmo.com/u/Seung-Yang-19"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="w-full flex items-center gap-3 rounded-xl border border-zinc-800 bg-zinc-950/60 px-4 py-3.5 hover:bg-zinc-800/60 transition-colors"
                >
                  <VenmoMark />
                  <span className="text-sm text-zinc-200">@Seung-Yang-19</span>
                  <span className="ml-auto text-[10px] text-zinc-600">열기 ↗</span>
                </a>

                {/* PayPal */}
                <a
                  href="https://paypal.me/SeungHoYang"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="w-full flex items-center gap-3 rounded-xl border border-zinc-800 bg-zinc-950/60 px-4 py-3.5 hover:bg-zinc-800/60 transition-colors mt-2.5"
                >
                  <PayPalMark />
                  <span className="text-sm text-zinc-200">yang9426@hotmail.com</span>
                  <span className="ml-auto text-[10px] text-zinc-600">열기 ↗</span>
                </a>

                {/* Zelle — 클릭하면 이메일 복사 */}
                <button
                  onClick={copyZelle}
                  className="w-full flex items-center gap-3 rounded-xl border border-zinc-800 bg-zinc-950/60 px-4 py-3.5 hover:bg-zinc-800/60 transition-colors mt-2.5"
                >
                  <ZelleMark />
                  <span className="text-sm text-zinc-200">yang9426@gmail.com</span>
                  {copied ? (
                    <span className="ml-auto text-[11px] text-emerald-400 shrink-0">복사됨 ✓</span>
                  ) : (
                    <span className="ml-auto text-[10px] text-zinc-600 shrink-0">탭하여 복사</span>
                  )}
                </button>

                <div className="text-[11px] text-zinc-600 text-center mt-4">
                  감사합니다 — 연습 머신이 계속 돌아가게 해줍니다 🎵
                </div>
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
