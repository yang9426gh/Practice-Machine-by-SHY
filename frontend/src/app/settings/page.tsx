'use client';

import React from 'react';
import Link from 'next/link';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useSettings } from '../../lib/useSettings';
import { DEFAULT_SETTINGS, MIX_MODE_VALUES, clampNum } from '../../lib/settings';

const STEP = 0.05;
const LIMIT = 2; // 최대 ±2초

const MIX_MODE_LABELS: Record<string, string> = {
  master: "🎛️ Master",
  vocal: "🎤 Vocal",
  drums: "🥁 Drum",
  bass: "🎸 Bass",
  guitar: "🎸 Guitar",
  piano: "🎹 Piano",
};

// ← [-0.25s] → 스테퍼: 왼쪽 버튼 -0.05, 오른쪽 버튼 +0.05
function OffsetStepper({ label, value, onChange }: {
  label: string;
  value: number;
  onChange: (v: number) => void;
}) {
  const bump = (dir: 1 | -1) => onChange(clampNum(value + dir * STEP, -LIMIT, LIMIT, DEFAULT_SETTINGS.chordStampOffsetSec));
  const atMin = value <= -LIMIT + 1e-9;
  const atMax = value >= LIMIT - 1e-9;
  return (
    <div className="space-y-2">
      <div className="text-sm font-semibold text-zinc-200">{label}</div>
      <div className="flex items-center justify-center gap-6">
        <button
          onClick={() => bump(-1)}
          disabled={atMin}
          aria-label={`${label} 0.05초 일찍`}
          className="w-11 h-11 rounded-lg border border-zinc-700 flex items-center justify-center hover:bg-zinc-800 disabled:opacity-30 disabled:cursor-not-allowed"
        >
          <ChevronLeft size={20} />
        </button>
        <div className="text-3xl font-mono tabular-nums w-28 text-center">{value.toFixed(2)}s</div>
        <button
          onClick={() => bump(1)}
          disabled={atMax}
          aria-label={`${label} 0.05초 늦게`}
          className="w-11 h-11 rounded-lg border border-zinc-700 flex items-center justify-center hover:bg-zinc-800 disabled:opacity-30 disabled:cursor-not-allowed"
        >
          <ChevronRight size={20} />
        </button>
      </div>
    </div>
  );
}

export default function SettingsPage() {
  const { settings, patch, reset } = useSettings();

  return (
    <main className="min-h-screen bg-black text-white">
      <div className="max-w-3xl mx-auto p-8 space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-black">Settings</h1>
          </div>
          <div className="flex gap-2">
            <button
              onClick={reset}
              className="text-sm px-3 py-2 rounded-lg border border-zinc-800 hover:bg-zinc-900"
            >
              Reset
            </button>
            <Link
              href="/"
              className="text-sm px-3 py-2 rounded-lg border border-zinc-800 hover:bg-zinc-900"
            >
              Back
            </Link>
          </div>
        </div>

        <div className="rounded-xl border border-zinc-800 bg-zinc-950/60 p-5 space-y-4">
          <div>
            <div className="text-sm font-semibold text-zinc-200">Default Instrument (기본 악기 모드)</div>
            <p className="text-xs text-zinc-500 mt-1">
              재생창에 들어올 때 항상 이 악기의 스템 믹서가 먼저 표시됩니다. 라이브러리를 다녀와도 이 모드로 시작합니다.
            </p>
          </div>
          <select
            value={settings.defaultMixMode}
            onChange={(e) => patch({ defaultMixMode: e.target.value as typeof settings.defaultMixMode })}
            className="px-3 py-2 rounded-lg border border-zinc-700 text-sm bg-zinc-950 text-zinc-200"
            aria-label="Default Instrument"
          >
            {MIX_MODE_VALUES.map((v) => (
              <option key={v} value={v}>
                {MIX_MODE_LABELS[v]}
              </option>
            ))}
          </select>
        </div>

        <div className="rounded-xl border border-zinc-800 bg-zinc-950/60 p-5 space-y-6">
          <div>
            <div className="text-sm font-semibold text-zinc-200">Stamp timing (스탬프 타이밍)</div>
            <p className="text-xs text-zinc-500 mt-1">
              스탬프 버튼을 누를 때 기록되는 시각 조정. 음수 = 그만큼 더 일찍 기록 (기본 -0.25초), 양수 = 더 늦게 기록. 0.05초 단위, 최대 ±2초.
            </p>
          </div>
          <OffsetStepper
            label="Chord stamp (코드)"
            value={settings.chordStampOffsetSec}
            onChange={(v) => patch({ chordStampOffsetSec: clampNum(v, -LIMIT, LIMIT, DEFAULT_SETTINGS.chordStampOffsetSec) })}
          />
          <OffsetStepper
            label="Lyric stamp (가사)"
            value={settings.lyricStampOffsetSec}
            onChange={(v) => patch({ lyricStampOffsetSec: clampNum(v, -LIMIT, LIMIT, DEFAULT_SETTINGS.lyricStampOffsetSec) })}
          />
        </div>

        <div className="rounded-xl border border-zinc-800 bg-zinc-950/60 p-5 space-y-6">
          <div>
            <div className="text-sm font-semibold text-zinc-200">BTC 스탬프 채우기 타이밍 (매칭 오프셋)</div>
            <p className="text-xs text-zinc-500 mt-1">
              ✦ 스탬프 채우기 버튼이 BTC 데이터에서 코드를 찾을 때, 찍힌 스탬프 시각에 이 값을 더해서 조회합니다.
              예: 스탬프 [02:23.25] + (-0.05) → [02:23.20] 기준으로 매칭. 음수 = 스탬프보다 이른 시점의 코드, 양수 = 늦은 시점의 코드.
              0.05초 단위, 최대 ±2초.
            </p>
          </div>
          <OffsetStepper
            label="BTC stamp fill (스탬프 채우기)"
            value={settings.btcStampFillOffsetSec}
            onChange={(v) => patch({ btcStampFillOffsetSec: clampNum(v, -LIMIT, LIMIT, DEFAULT_SETTINGS.btcStampFillOffsetSec) })}
          />
        </div>
      </div>
    </main>
  );
}
