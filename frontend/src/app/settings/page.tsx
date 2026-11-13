'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { ChevronLeft, ChevronRight, RefreshCw, Download, CheckCircle2, AlertTriangle } from 'lucide-react';
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

type UpdateStatusResp = {
  version: string;
  configured: boolean;
  last_update: { from?: string; to?: string; finished_at?: string; files?: number } | null;
};

function UpdateCard() {
  const [status, setStatus] = useState<UpdateStatusResp | null>(null);
  const [phase, setPhase] = useState<'idle' | 'checking' | 'available' | 'latest' | 'applying' | 'restarting' | 'done'>('idle');
  const [latest, setLatest] = useState<{ version: string; notes: string } | null>(null);
  const [errMsg, setErrMsg] = useState('');

  useEffect(() => {
    fetch('/update/status')
      .then((r) => (r.ok ? r.json() : null))
      .then(setStatus)
      .catch(() => {});
  }, []);

  const check = async () => {
    setPhase('checking');
    setErrMsg('');
    try {
      const r = await fetch('/update/check');
      const d = await r.json();
      if (!r.ok) throw new Error(d.detail || '확인 실패');
      if (d.update_available) {
        setLatest({ version: d.latest, notes: d.notes || '' });
        setPhase('available');
      } else {
        setPhase('latest');
      }
    } catch (e) {
      setErrMsg(e instanceof Error ? e.message : String(e));
      setPhase('idle');
    }
  };

  const apply = async () => {
    setPhase('applying');
    setErrMsg('');
    try {
      const r = await fetch('/update/apply', { method: 'POST' });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.detail || '적용 실패');
    } catch (e) {
      setErrMsg(e instanceof Error ? e.message : String(e));
      setPhase('idle');
      return;
    }
    // 서버가 재시작됨 — 연결 실패는 정상. 살아나면 버전 확인.
    setPhase('restarting');
    const target = latest?.version;
    for (let i = 0; i < 60; i++) {
      await new Promise((res) => setTimeout(res, 1500));
      try {
        const r = await fetch('/update/status', { cache: 'no-store' });
        if (r.ok) {
          const d: UpdateStatusResp = await r.json();
          if (!target || d.version === target) {
            setStatus(d);
            setPhase('done');
            return;
          }
        }
      } catch {
        /* 재시작 중 */
      }
    }
    setErrMsg('재시작 대기 시간이 초과됐어요. 앱을 닫았다 다시 열어주세요.');
    setPhase('idle');
  };

  const cur = status?.version ?? '…';
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-950/60 p-5 space-y-4">
      <div>
        <div className="text-sm font-semibold text-zinc-200">업데이트 (Update)</div>
        <p className="text-xs text-zinc-500 mt-1">
          현재 버전 v{cur}. 확인 → 설치 한 번에 끝납니다. 곡·설정은 그대로 보존돼요.
        </p>
      </div>

      {phase === 'done' && status?.last_update && (
        <div className="flex items-center gap-2 text-sm text-green-400">
          <CheckCircle2 size={16} />
          v{status.last_update.to ?? status.version} 업데이트 완료! ({status.last_update.files ?? ''} 파일)
        </div>
      )}
      {errMsg && (
        <div className="flex items-center gap-2 text-sm text-amber-400">
          <AlertTriangle size={16} />
          {errMsg}
        </div>
      )}

      {phase === 'available' && latest && (
        <div className="space-y-2">
          <div className="text-sm text-zinc-300">
            새 버전 <span className="font-bold text-blue-400">v{latest.version}</span> 사용 가능
          </div>
          {latest.notes && <p className="text-xs text-zinc-500 whitespace-pre-line">{latest.notes}</p>}
          <button
            onClick={apply}
            className="flex items-center gap-2 px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-sm font-semibold"
          >
            <Download size={15} />
            지금 업데이트
          </button>
        </div>
      )}

      {phase === 'applying' && (
        <div className="flex items-center gap-2 text-sm text-blue-400">
          <RefreshCw size={15} className="animate-spin" />
          다운로드·적용 중… (곡 데이터는 보존됩니다)
        </div>
      )}

      {phase === 'restarting' && (
        <div className="flex items-center gap-2 text-sm text-blue-400">
          <RefreshCw size={15} className="animate-spin" />
          재시작 중… 몇 초 걸려요. 창이 잠깐 끊겨도 그대로 기다려주세요.
        </div>
      )}

      <div className="flex items-center gap-3">
        <button
          onClick={check}
          disabled={phase === 'checking' || phase === 'applying' || phase === 'restarting'}
          className="flex items-center gap-2 text-sm px-3 py-2 rounded-lg border border-zinc-700 hover:bg-zinc-800 disabled:opacity-40"
        >
          <RefreshCw size={14} className={phase === 'checking' ? 'animate-spin' : ''} />
          {phase === 'checking' ? '확인 중…' : '업데이트 확인'}
        </button>
        {phase === 'latest' && (
          <span className="text-sm text-green-400">최신 버전이에요 ✓</span>
        )}
        {status && !status.configured && (
          <span className="text-xs text-zinc-600">업데이트 서버 미설정</span>
        )}
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

        <UpdateCard />

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
