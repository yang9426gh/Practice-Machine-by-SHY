"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { BrandHeader, SupportButton } from "../../components/Brand";

const BACKEND = process.env.NEXT_PUBLIC_BACKEND_URL || (typeof window !== "undefined" ? window.location.origin : "http://localhost:8011");

type Preset = {
  id: string;
  name: string;
  source_url: string;
  video_id: string;
  title?: string | null;
  thumbnail_url?: string | null;
  bpm?: number | null;
  key_tonic?: string | null;
  key_mode?: string | null;
  semitones?: number;
  master_volume?: number;
  vocal_volume?: number;
  has_lyrics?: boolean;
  has_chords?: boolean;
};

type QueueItem = {
  video_id: string;
  url: string;
  task_id: string;
  name: string | null;
  thumbnail_url: string | null;
  status: string; // queued | downloading | separating | processing | completed | error
  stage: string;
  progress: number;
  error: string | null;
};

export default function LibraryPage() {
  const router = useRouter();
  const [presets, setPresets] = useState<Preset[]>([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);

  const [sort, setSort] = useState<"recent" | "bpm_asc" | "bpm_desc" | "key_asc" | "key_desc">("recent");

  // ---------- Queue state ----------
  const [queueItems, setQueueItems] = useState<QueueItem[]>([]);
  const [queueUrl, setQueueUrl] = useState("");
  const [queueBusy, setQueueBusy] = useState(false);
  const [toastMsg, setToastMsg] = useState("");
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const toast = (msg: string) => {
    setToastMsg(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToastMsg(""), 2200);
  };

  const refresh = async () => {
    setLoading(true);
    try {
      const r = await fetch(`${BACKEND}/presets?sort=${encodeURIComponent(sort)}`);
      const j = await r.json();
      setPresets((j.items || []) as Preset[]);
    } catch {
      setPresets([]);
    } finally {
      setLoading(false);
    }
  };

  const refreshQueue = async () => {
    try {
      const r = await fetch(`${BACKEND}/queue`);
      if (r.ok) {
        const j = await r.json();
        setQueueItems(j.items || []);
      }
    } catch {}
  };

  useEffect(() => {
    refresh();
    refreshQueue();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sort]);

  // 큐 폴링: 활성 작업 1초, 그 외 라이브러리 열려있으면 4초
  useEffect(() => {
    const active = queueItems.some((q) => !["completed", "error"].includes(q.status));
    const iv = setInterval(refreshQueue, active ? 1000 : 4000);
    return () => clearInterval(iv);
  }, [queueItems]);

  // 활성 곡 하나씩 완료될 때마다 프리셋 갱신 (완료 개수 변화 감지)
  const prevDoneRef = useRef<number | null>(null);
  useEffect(() => {
    const done = queueItems.filter((q) => q.status === "completed").length;
    if (prevDoneRef.current === null) {
      prevDoneRef.current = done;
      return;
    }
    if (done > prevDoneRef.current) {
      refresh(); // 새 곡이 라이브러리에 자동 반영
    }
    prevDoneRef.current = done;
  }, [queueItems]);

  const extractId = (u: string): string => {
    const m = u.match(/(?:v=|youtu\.be\/|shorts\/|embed\/)([A-Za-z0-9_-]{11})/);
    return m ? m[1] : /^[A-Za-z0-9_-]{11}$/.test(u.trim()) ? u.trim() : "";
  };

  const addToQueue = async () => {
    const id = extractId(queueUrl);
    if (!id) {
      toast("유효한 YouTube URL이 아닙니다");
      return;
    }
    setQueueBusy(true);
    try {
      const thumb = `https://i.ytimg.com/vi/${id}/mqdefault.jpg`;
      const r = await fetch(
        `${BACKEND}/queue?url=${encodeURIComponent(`https://www.youtube.com/watch?v=${id}`)}&thumbnail_url=${encodeURIComponent(thumb)}`,
        { method: "POST" }
      );
      const j = await r.json();
      if (!r.ok) {
        toast(j?.detail === "Queue is full (max 5)" ? "큐 가득 참 (최대 5개)" : "추가 실패");
      } else if (j.status === "completed") {
        toast("이미 준비된 곡입니다 — 아래에서 바로 재생");
      } else if (j.status === "already_queued") {
        toast("이미 큐에 있습니다");
      } else {
        toast("큐에 추가됨");
        setQueueUrl("");
      }
      await refreshQueue();
    } catch {
      toast("추가 실패 — 서버 확인");
    } finally {
      setQueueBusy(false);
    }
  };

  const removeFromQueue = async (vid: string) => {
    await fetch(`${BACKEND}/queue/${vid}`, { method: "DELETE" });
    await refreshQueue();
  };

  const clearCompleted = async () => {
    await fetch(`${BACKEND}/queue/clear-completed`, { method: "POST" });
    await refreshQueue();
  };

  const queueProgress = (q: QueueItem) =>
    q.status === "completed" ? 100 : Math.max(2, Math.min(99, q.progress || 0));

  const queueStatusLabel = (q: QueueItem) => {
    if (q.status === "error") return `실패: ${q.error || ""}`;
    if (q.status === "queued") return "대기 중";
    if (q.status === "completed") return "완료 ✅";
    if (q.status === "separating" || q.status === "processing") return "스템 분리 중…";
    return "다운로드 중…";
  };

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return presets;
    return presets.filter((p) => {
      const hay = `${p.name || ""} ${p.title || ""} ${p.video_id || ""} ${p.source_url || ""}`.toLowerCase();
      return hay.includes(q);
    });
  }, [presets, query]);

  // 큐에 있거나 완료된 video_id — 라이브러리 카드에 상태 배지 표시
  const queuedIds = useMemo(
    () => new Set(queueItems.filter((q) => !["completed", "error"].includes(q.status)).map((q) => q.video_id)),
    [queueItems]
  );

  const openPreset = (p: Preset) => {
    const url = p.source_url || `https://www.youtube.com/watch?v=${p.video_id}`;
    const bpm = p.bpm != null ? String(p.bpm) : "";
    const qp = new URLSearchParams();
    qp.set("url", url);
    if (bpm) qp.set("bpm", bpm);
    router.push(`/?${qp.toString()}`);
  };

  const renamePreset = async (p: Preset) => {
    const nn = prompt("Rename", p.name || p.title || p.video_id);
    if (!nn) return;
    await fetch(`${BACKEND}/presets`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: p.id,
        name: nn,
        source_url: p.source_url,
        video_id: p.video_id,
        title: p.title || null,
        thumbnail_url: p.thumbnail_url || null,
        bpm: p.bpm ?? null,
        semitones: p.semitones ?? 0,
        master_volume: p.master_volume ?? 1.0,
        vocal_volume: p.vocal_volume ?? 1.0,
      }),
    });
    await refresh();
  };

  const deletePreset = async (p: Preset) => {
    const ok = confirm(`Delete from Library?\n\n${p.name || p.title || p.video_id}`);
    if (!ok) return;
    await fetch(`${BACKEND}/presets/${encodeURIComponent(p.id)}`, { method: "DELETE" });
    await refresh();
  };

  const visibleQueue = queueItems.filter((q) => q.status !== "completed");

  return (
    <main className="min-h-screen bg-black text-white pb-24">
      <div className="sticky top-0 z-10 border-b border-zinc-800 bg-zinc-950/90 backdrop-blur">
        <div className="max-w-6xl mx-auto px-4 py-4 flex items-center gap-3 relative">
          <button onClick={() => router.push("/")} className="px-3 py-2 rounded-lg border border-zinc-700 text-sm">
            Back
          </button>
          <div className="text-sm text-zinc-200 font-semibold">Library</div>
          {/* 브랜드 헤더 — 상단 중앙 */}
          <div className="absolute left-1/2 -translate-x-1/2 hidden sm:block">
            <BrandHeader compact />
          </div>
          {/* Support 버튼 — 중앙 로고 바로 왼쪽 (넓은 화면에서만) */}
          <div className="absolute right-1/2 mr-[152px] top-1/2 -translate-y-1/2 hidden md:block">
            <SupportButton />
          </div>
          <div className="flex-1" />

          <select
            value={sort}
            onChange={(e) => setSort(e.target.value as any)}
            className="px-3 py-2 rounded-lg border border-zinc-700 text-sm bg-zinc-950"
          >
            <option value="recent">Recent</option>
            <option value="bpm_asc">BPM (slow → fast)</option>
            <option value="bpm_desc">BPM (fast → slow)</option>
            <option value="key_asc">Key (C → B)</option>
            <option value="key_desc">Key (B → C)</option>
          </select>

          <button onClick={refresh} className="px-3 py-2 rounded-lg border border-zinc-700 text-sm">
            {loading ? "Refreshing…" : "Refresh"}
          </button>
        </div>
        <div className="max-w-6xl mx-auto px-4 pb-4">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search…"
            className="w-full bg-zinc-900 border border-zinc-700 rounded-xl px-4 py-3 text-sm"
          />
        </div>
      </div>

      <div className="max-w-6xl mx-auto px-4 py-6">
        {/* ---------- URL → 큐 추가 ---------- */}
        <div className="rounded-2xl border border-zinc-800 bg-zinc-950/70 p-4 mb-6">
          <div className="text-xs text-zinc-400 font-semibold mb-2">ADD NEW SONG</div>
          <div className="flex items-center gap-2">
            <input
              className="flex-1 bg-zinc-900 border border-zinc-700 rounded-lg px-3 py-2.5 text-sm"
              placeholder="YouTube URL 붙여넣기 (여러 개 순서대로 가능, 최대 5개)"
              value={queueUrl}
              onChange={(e) => setQueueUrl(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") addToQueue();
              }}
            />
            <button
              onClick={addToQueue}
              disabled={queueBusy}
              className="px-4 py-2.5 rounded-lg border border-zinc-600 text-sm bg-zinc-900 hover:bg-zinc-800 disabled:opacity-50 whitespace-nowrap"
            >
              {queueBusy ? "추가 중…" : "+ Queue"}
            </button>
          </div>

          {/* 큐 목록 (썸네일 + 원형 progress) */}
          {visibleQueue.length > 0 ? (
            <div className="mt-3 space-y-2">
              {visibleQueue.map((q) => {
                const pct = queueProgress(q);
                const isActive = !["queued", "error"].includes(q.status);
                return (
                  <div key={q.video_id} className="flex items-center gap-3 rounded-xl border border-zinc-800 p-2">
                    <div className="relative w-14 h-14 shrink-0">
                      {q.thumbnail_url ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={q.thumbnail_url} alt="" className="w-14 h-14 rounded-lg object-cover border border-zinc-800" />
                      ) : (
                        <div className="w-14 h-14 rounded-lg bg-zinc-900 border border-zinc-800" />
                      )}
                      {isActive ? (
                        <svg className="absolute -inset-1" viewBox="0 0 64 64">
                          <circle cx="32" cy="32" r="29" fill="none" stroke="rgba(255,255,255,0.12)" strokeWidth="4" />
                          <circle
                            cx="32" cy="32" r="29" fill="none" stroke="#3b82f6" strokeWidth="4"
                            strokeLinecap="round"
                            strokeDasharray={2 * Math.PI * 29}
                            strokeDashoffset={2 * Math.PI * 29 * (1 - pct / 100)}
                            transform="rotate(-90 32 32)"
                            style={{ transition: "stroke-dashoffset 0.5s ease" }}
                          />
                        </svg>
                      ) : null}
                      <div className="absolute inset-0 flex items-center justify-center">
                        <span className="text-[10px] font-bold text-white bg-black/70 rounded px-1">
                          {q.status === "error" ? "!" : `${pct}%`}
                        </span>
                      </div>
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm text-zinc-200 truncate">
                        {q.name || q.video_id}
                      </div>
                      <div className={`text-[11px] ${q.status === "error" ? "text-red-400" : "text-zinc-500"}`}>
                        {queueStatusLabel(q)}
                      </div>
                    </div>
                    {q.status === "queued" ? (
                      <button
                        onClick={() => removeFromQueue(q.video_id)}
                        className="text-[11px] px-2 py-1 rounded-md border border-zinc-800 text-zinc-400"
                      >
                        취소
                      </button>
                    ) : null}
                  </div>
                );
              })}
            </div>
          ) : null}
        </div>

        {/* ---------- 라이브러리 그리드 ---------- */}
        {filtered.length === 0 ? (
          <div className="text-zinc-500 text-sm">No items.</div>
        ) : null}

        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
          {filtered.map((p) => (
            <div key={p.id} className="relative rounded-2xl border border-zinc-800 bg-zinc-950/60 hover:bg-zinc-900/60 overflow-hidden">
              <button onClick={() => openPreset(p)} className="block w-full text-left">
                <div className="aspect-square bg-zinc-900 relative">
                  {p.thumbnail_url ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={p.thumbnail_url} alt="thumb" className="w-full h-full object-cover" />
                  ) : null}
                  {queuedIds.has(p.video_id) ? (
                    <div className="absolute top-2 left-2 text-[10px] px-2 py-0.5 rounded-full bg-blue-600/90 text-white font-semibold">
                      준비 중…
                    </div>
                  ) : null}
                </div>
                <div className="p-3 space-y-1">
                  <div className="text-sm text-zinc-100 line-clamp-2">{p.title || p.name || p.video_id}</div>
                  <div className="text-[11px] text-zinc-500 line-clamp-1">{p.video_id}</div>
                  <div className="flex items-center gap-2 pt-1 flex-wrap">
                    {p.bpm != null ? <div className="text-[11px] px-2 py-0.5 rounded-full border border-zinc-800 text-zinc-300">{p.bpm} BPM</div> : null}
                    {p.key_tonic && p.key_mode ? (
                      <div className="text-[11px] px-2 py-0.5 rounded-full border border-zinc-800 text-zinc-300">
                        {p.key_tonic}{p.key_mode === "minor" ? "m" : "M"}
                      </div>
                    ) : null}
                    {p.has_lyrics ? (
                      <div className="text-[11px] px-2 py-0.5 rounded-full border border-violet-800/60 bg-violet-950/30 text-violet-300">가사</div>
                    ) : null}
                    {p.has_chords ? (
                      <div className="text-[11px] px-2 py-0.5 rounded-full border border-emerald-800/60 bg-emerald-950/30 text-emerald-300">코드</div>
                    ) : null}
                  </div>
                </div>
              </button>

              <div className="absolute top-2 right-2 flex gap-2">
                <button
                  onClick={() => renamePreset(p)}
                  className="text-[11px] px-2 py-1 rounded-md border border-zinc-800 bg-zinc-950/70"
                >
                  Rename
                </button>
                <button
                  onClick={() => deletePreset(p)}
                  className="text-[11px] px-2 py-1 rounded-md border border-red-900 bg-red-950/40 text-red-200"
                >
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* toast */}
      {toastMsg ? (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 px-4 py-2 rounded-xl bg-zinc-800 border border-zinc-700 text-sm shadow-lg">
          {toastMsg}
        </div>
      ) : null}
    </main>
  );
}
