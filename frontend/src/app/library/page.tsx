"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { BrandHeader, SupportButton } from "../../components/Brand";
import { LayoutGrid, List, Download, Upload, Check } from "lucide-react";

const BACKEND = process.env.NEXT_PUBLIC_BACKEND_URL || (typeof window !== "undefined" ? window.location.origin : "http://localhost:8011");

const LIBRARY_VIEW_KEY = "karaoke_library_view"; // "cards" | "list"

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
  video_ready?: boolean;
  lyrics_lrc?: string | null;
  chords_lrc?: string | null;
};

// 공유 .pmd 항목 (다른 사용자와 주고받는 곡 메타데이터)
type PmdItem = {
  video_id: string;
  url: string;
  title: string | null;
  thumbnail_url: string | null;
  bpm: number | null;
  key_tonic: string | null;
  key_mode: string | null;
  lyrics_lrc: string | null;
  chords_lrc: string | null;
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

  const [sort, setSort] = useState<"recent" | "bpm_asc" | "bpm_desc" | "key_asc" | "key_desc">("recent");

  // 보기 방식 (카드/리스트) — localStorage 저장, 마운트 후 복원 (SSR hydration 불일치 방지)
  const [view, setView] = useState<"cards" | "list">("cards");
  useEffect(() => {
    try {
      const v = window.localStorage.getItem(LIBRARY_VIEW_KEY);
      if (v === "cards" || v === "list") setView(v);
    } catch {}
  }, []);
  const changeView = (v: "cards" | "list") => {
    setView(v);
    try {
      window.localStorage.setItem(LIBRARY_VIEW_KEY, v);
    } catch {}
  };

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
    try {
      const r = await fetch(`${BACKEND}/presets?sort=${encodeURIComponent(sort)}`);
      const j = await r.json();
      setPresets((j.items || []) as Preset[]);
    } catch {
      setPresets([]);
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
    try {
      const r = await fetch(`${BACKEND}/queue/${vid}`, { method: "DELETE" });
      if (!r.ok) { toast("제거 실패 — 실행 중 항목은 취소를 사용하세요"); return; }
    } catch {
      toast("제거 실패 — 서버 확인");
      return;
    }
    await refreshQueue();
  };

  const clearCompleted = async () => {
    try {
      await fetch(`${BACKEND}/queue/clear-completed`, { method: "POST" });
    } catch {
      toast("정리 실패 — 서버 확인");
      return;
    }
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
    try {
      const r = await fetch(`${BACKEND}/presets`, {
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
      if (!r.ok) { toast("이름 변경 실패 — 서버 확인"); return; }
    } catch {
      toast("이름 변경 실패 — 서버 확인");
      return;
    }
    await refresh();
  };

  const deletePreset = async (p: Preset) => {
    const ok = confirm(`Delete from Library?\n\n${p.name || p.title || p.video_id}`);
    if (!ok) return;
    try {
      const r = await fetch(`${BACKEND}/presets/${encodeURIComponent(p.id)}`, { method: "DELETE" });
      if (!r.ok) { toast("삭제 실패 — 서버 확인"); return; }
    } catch {
      toast("삭제 실패 — 서버 확인");
      return;
    }
    await refresh();
  };

  // ---------- 내용 뷰어 (읽기 전용 — 배지 클릭 → 가사/코드 원문 보기·복사) ----------
  const [viewer, setViewer] = useState<{ preset: Preset; kind: "lyrics" | "chords" } | null>(null);
  const [viewerText, setViewerText] = useState("");
  const [viewerLoading, setViewerLoading] = useState(false);

  const closeViewer = () => setViewer(null);

  // 연속 클릭 경합 방지 — 이전 요청의 늦은 응답이 지금 열린 뷰어를 덮쓰지 않게 함
  const viewerReqRef = useRef(0);

  const openContentViewer = async (p: Preset, kind: "lyrics" | "chords") => {
    const reqId = ++viewerReqRef.current;
    setViewer({ preset: p, kind });
    setViewerText("");
    setViewerLoading(true);
    try {
      if (!p.video_id) {
        setViewerText("(video ID 없음 — 내용을 불러올 수 없습니다)");
        return;
      }
      const r = await fetch(`${BACKEND}/${kind}/${encodeURIComponent(p.video_id)}`);
      if (viewerReqRef.current !== reqId) return; // 도중에 다른 요청이 시작됨
      if (r.ok) {
        const j = await r.json();
        if (viewerReqRef.current !== reqId) return;
        setViewerText(j.lrc || "(저장된 내용이 없습니다)");
      } else {
        setViewerText("(저장된 내용이 없습니다)");
      }
    } catch {
      if (viewerReqRef.current !== reqId) return;
      setViewerText("(불러오기 실패 — 서버 확인)");
    } finally {
      if (viewerReqRef.current === reqId) setViewerLoading(false);
    }
  };

  const copyViewerText = async () => {
    if (!viewerText || viewerText.startsWith("(")) return;
    try {
      await navigator.clipboard.writeText(viewerText);
      toast("복사됐습니다");
    } catch {
      // 비보안 컨텍스트(LAN IP 접속)에선 navigator.clipboard가 없음 → execCommand 폴백
      try {
        const ta = document.createElement("textarea");
        ta.value = viewerText;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
        toast("복사됐습니다");
      } catch {
        toast("복사 실패 — 텍스트를 직접 선택해 복사해 주세요");
      }
    }
  };

  // Esc로 닫기
  useEffect(() => {
    if (!viewer) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeViewer();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [viewer]);

  // 가사/코드 배지 (클릭 → 읽기 전용 뷰어) — 카드/리스트 뷰 공용
  const contentBadge = (p: Preset, kind: "lyrics" | "chords") => {
    const has = kind === "lyrics" ? p.has_lyrics : p.has_chords;
    if (!has) return null;
    return (
      <div
        role="button"
        tabIndex={0}
        onClick={(e) => {
          e.stopPropagation();
          void openContentViewer(p, kind);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            e.stopPropagation();
            void openContentViewer(p, kind);
          }
        }}
        title={kind === "lyrics" ? "가사 내용 보기" : "코드 내용 보기"}
        className={`text-[11px] px-2 py-0.5 rounded-full cursor-pointer hover:brightness-150 ${
          kind === "lyrics"
            ? "border border-violet-800/60 bg-violet-950/30 text-violet-300"
            : "border border-emerald-800/60 bg-emerald-950/30 text-emerald-300"
        }`}
      >
        {kind === "lyrics" ? "가사" : "코드"}
      </div>
    );
  };

  // ---------- Export Data (.pmd 공유 파일 내보내기) ----------
  const [exportMode, setExportMode] = useState(false);
  const [exportSel, setExportSel] = useState<Set<string>>(new Set());

  const enterExportMode = () => {
    setExportMode(true);
    setExportSel(new Set());
  };
  const cancelExportMode = () => {
    setExportMode(false);
    setExportSel(new Set());
  };
  const toggleExportSel = (id: string) => {
    setExportSel((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const allFilteredSelected = filtered.length > 0 && filtered.every((p) => exportSel.has(p.id));
  const toggleSelectAllExport = () => {
    setExportSel((prev) => {
      const next = new Set(prev);
      if (allFilteredSelected) filtered.forEach((p) => next.delete(p.id));
      else filtered.forEach((p) => next.add(p.id));
      return next;
    });
  };

  const buildPmd = (ps: Preset[]) => ({
    format: "practice-machine-data",
    version: 1,
    exported_at: new Date().toISOString(),
    items: ps.map((p) => ({
      video_id: p.video_id,
      url: p.source_url || (p.video_id ? `https://www.youtube.com/watch?v=${p.video_id}` : ""),
      title: p.title || p.name || p.video_id || null,
      // 로컬 경로 썸네일은 공유 파일에 담지 않고 CDN URL로 정규화
      thumbnail_url:
        p.thumbnail_url && /^https?:/.test(p.thumbnail_url)
          ? p.thumbnail_url
          : p.video_id
            ? `https://i.ytimg.com/vi/${p.video_id}/mqdefault.jpg`
            : null,
      bpm: p.bpm ?? null,
      key_tonic: p.key_tonic || null,
      key_mode: p.key_mode || null,
      lyrics_lrc: p.lyrics_lrc || null,
      chords_lrc: p.chords_lrc || null,
    })),
  });

  const doExport = () => {
    const ps = presets.filter((p) => exportSel.has(p.id));
    if (!ps.length) return;
    const blob = new Blob([JSON.stringify(buildPmd(ps))], { type: "application/json" });
    const a = document.createElement("a");
    const d = new Date();
    const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
    a.href = URL.createObjectURL(blob);
    a.download = `practice-machine-export-${stamp}.pmd`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(a.href);
    toast(`${ps.length}곡을 내보냈습니다`);
    cancelExportMode();
  };

  // ---------- Import Data (.pmd 불러오기) ----------
  const [importOpen, setImportOpen] = useState(false);
  const [importItems, setImportItems] = useState<PmdItem[] | null>(null);
  const [importSel, setImportSel] = useState<Set<number>>(new Set());
  const [importBusy, setImportBusy] = useState(false);
  const [importError, setImportError] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  const openImport = () => {
    setImportItems(null);
    setImportSel(new Set());
    setImportError("");
    setImportOpen(true);
  };
  const closeImport = () => {
    setImportOpen(false);
    setImportItems(null);
    setImportSel(new Set());
    setImportError("");
  };
  const toggleImportSel = (i: number) => {
    setImportSel((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  };
  const allImportSelected = !!importItems && importItems.length > 0 && importItems.every((_, i) => importSel.has(i));
  const toggleSelectAllImport = () => {
    setImportSel((prev) =>
      allImportSelected ? new Set() : new Set((importItems || []).map((_, i) => i))
    );
  };

  // 미리보기: 현재 라이브러리와 비교해 신규/보충/변경없음 판정
  const importStatus = (item: PmdItem): { kind: "new" | "fill" | "same"; label: string } => {
    const ex = presets.find((p) => p.video_id === item.video_id);
    if (!ex) return { kind: "new", label: "신규 추가" };
    const fill: string[] = [];
    if (ex.bpm == null && item.bpm != null) fill.push("BPM");
    if ((!ex.key_tonic || !ex.key_mode) && (item.key_tonic || item.key_mode)) fill.push("Key");
    if (!ex.has_lyrics && item.lyrics_lrc) fill.push("가사");
    if (!ex.has_chords && item.chords_lrc) fill.push("코드");
    return fill.length ? { kind: "fill", label: `보충: ${fill.join(" · ")}` } : { kind: "same", label: "변경 없음" };
  };

  const parsePmdFile = async (file: File) => {
    setImportError("");
    try {
      const obj = JSON.parse(await file.text());
      const rawItems = Array.isArray(obj) ? obj : obj?.items;
      if (!Array.isArray(rawItems)) throw new Error("items 배열이 없는 파일입니다");
      const byId = new Map<string, PmdItem>();
      const norm: PmdItem[] = [];
      for (const it of rawItems) {
        if (!it || typeof it !== "object") continue;
        const vid = String(it.video_id || "").trim();
        if (!vid) continue;
        const merged = byId.get(vid);
        if (merged) {
          // 파일 내 중복 곡 — 비어있는 필드만 보충해서 하나로 통합
          for (const k of ["url", "title", "thumbnail_url", "key_tonic", "key_mode", "lyrics_lrc", "chords_lrc"] as const) {
            if (!merged[k] && it[k]) (merged as any)[k] = String(it[k]);
          }
          if (merged.bpm == null && it.bpm != null && it.bpm !== "") {
            const n = Number(it.bpm);
            if (!Number.isNaN(n)) merged.bpm = n;
          }
          continue;
        }
        const bpmNum = it.bpm == null || it.bpm === "" ? null : Number(it.bpm);
        const item: PmdItem = {
          video_id: vid,
          url: it.url ? String(it.url) : `https://www.youtube.com/watch?v=${vid}`,
          title: it.title ? String(it.title) : it.name ? String(it.name) : null,
          thumbnail_url: it.thumbnail_url ? String(it.thumbnail_url) : null,
          bpm: bpmNum != null && !Number.isNaN(bpmNum) ? bpmNum : null,
          key_tonic: it.key_tonic ? String(it.key_tonic) : null,
          key_mode: it.key_mode ? String(it.key_mode) : null,
          lyrics_lrc: it.lyrics_lrc ? String(it.lyrics_lrc) : null,
          chords_lrc: it.chords_lrc ? String(it.chords_lrc) : null,
        };
        byId.set(vid, item);
        norm.push(item);
      }
      if (!norm.length) throw new Error("가져올 수 있는 곡이 없습니다 (video_id 누락)");
      if (norm.length > 500) throw new Error("항목이 너무 많습니다 (최대 500곡)");
      setImportItems(norm);
      setImportSel(new Set(norm.map((_, i) => i)));
    } catch (e: any) {
      setImportItems(null);
      setImportSel(new Set());
      setImportError(e?.message ? `파일을 읽지 못했습니다: ${e.message}` : "유효한 .pmd (JSON) 파일이 아닙니다");
    }
  };

  const doImport = async () => {
    if (!importItems) return;
    const sel = importItems.filter((_, i) => importSel.has(i));
    if (!sel.length) return;
    setImportBusy(true);
    try {
      const r = await fetch(`${BACKEND}/library/import`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items: sel }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => null);
        throw new Error(j?.detail || `서버 오류 (${r.status})`);
      }
      const j = await r.json();
      const s = j.summary || {};
      toast(`가져오기 완료 — 추가 ${s.created || 0} · 보충 ${s.updated || 0} · 변경없음 ${s.unchanged || 0}`);
      closeImport();
      await refresh();
    } catch (e: any) {
      setImportError(e?.message || "가져오기 실패");
    } finally {
      setImportBusy(false);
    }
  };

  // Esc로 모달 닫기 (import)
  useEffect(() => {
    if (!importOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeImport();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [importOpen]);

  // ---------- 미보유 영상(회색 카드) 다운로드 ----------
  const downloadPreset = async (p: Preset) => {
    const url = p.source_url || (p.video_id ? `https://www.youtube.com/watch?v=${p.video_id}` : "");
    if (!url) {
      toast("다운로드할 URL이 없습니다");
      return;
    }
    try {
      const r = await fetch(
        `${BACKEND}/queue?url=${encodeURIComponent(url)}&name=${encodeURIComponent(p.title || p.name || p.video_id || "")}&thumbnail_url=${encodeURIComponent(p.thumbnail_url || "")}`,
        { method: "POST" }
      );
      const j = await r.json();
      if (j.status === "queued") toast("다운로드 큐에 추가됐습니다");
      else if (j.status === "already_queued") toast("이미 큐에 있습니다");
      else if (j.status === "completed") toast("이미 준비된 곡입니다");
      else toast(`큐 추가 실패 (${j.detail || j.status || "알 수 없는 오류"})`);
      refreshQueue();
      refresh();
    } catch {
      toast("큐 추가 실패 — 서버 확인");
    }
  };

  // 카드/행 클릭 — export 모드면 선택 토글, 영상 없으면 안내, 아니면 열기
  const onCardClick = (p: Preset) => {
    if (exportMode) {
      toggleExportSel(p.id);
      return;
    }
    if (p.video_ready === false) {
      toast("영상이 아직 없습니다 — Download 버튼으로 먼저 받아주세요");
      return;
    }
    openPreset(p);
  };

  const visibleQueue = queueItems.filter((q) => q.status !== "completed");

  return (
    <main className="min-h-screen bg-black text-white pb-24">
      <div className="sticky top-0 z-10 border-b border-zinc-800 bg-zinc-950/90 backdrop-blur">
        <div className="max-w-6xl mx-auto px-4 py-4 grid grid-cols-[1fr_auto_1fr] items-center gap-2">
          {/* 좌측: Back + 타이틀 + Support (로고 바로 왼쪽에 붙음) */}
          <div className="flex items-center gap-3 min-w-0 flex-wrap">
            <button onClick={() => router.push("/")} className="px-3 py-2 rounded-lg border border-zinc-700 text-sm">
              Back
            </button>
            <div className="text-sm text-zinc-200 font-semibold">Library</div>
            <div className="ml-auto">
              <SupportButton />
            </div>
          </div>
          {/* 중앙: 브랜드 헤더 — 그리드 중앙 열이라 좌우 버튼과 절대 겹치지 않음 */}
          <div className="shrink-0">
            <BrandHeader compact />
          </div>
          {/* 우측: 보기 전환/정렬/Export-Import (좁으면 줄바꿈) */}
          <div className="flex items-center gap-2 justify-end min-w-0 flex-wrap">
            <div className="flex rounded-lg border border-zinc-700 overflow-hidden shrink-0" role="group" aria-label="보기 방식">
            <button
              onClick={() => changeView("cards")}
              aria-label="카드 보기"
              title="카드 보기"
              className={`px-2.5 py-2 ${view === "cards" ? "bg-zinc-800 text-white" : "text-zinc-500 hover:text-zinc-300"}`}
            >
              <LayoutGrid size={16} />
            </button>
            <button
              onClick={() => changeView("list")}
              aria-label="목록 보기"
              title="목록 보기"
              className={`px-2.5 py-2 border-l border-zinc-700 ${view === "list" ? "bg-zinc-800 text-white" : "text-zinc-500 hover:text-zinc-300"}`}
            >
              <List size={16} />
            </button>
          </div>

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

          <button
            onClick={exportMode ? cancelExportMode : enterExportMode}
            className={`px-3 py-2 rounded-lg border text-sm whitespace-nowrap min-w-[102px] ${exportMode ? "border-blue-700 bg-blue-950/40 text-blue-200" : "border-zinc-700"}`}
          >
            {exportMode ? "Export 취소" : "Export Data"}
          </button>
          <button
            onClick={openImport}
            className="px-3 py-2 rounded-lg border border-zinc-700 text-sm whitespace-nowrap"
          >
            Import Data
          </button>
          </div>
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

        {exportMode ? (
          <div className="flex items-center gap-3 mb-4 px-4 py-3 rounded-xl border border-blue-900/60 bg-blue-950/20">
            <button onClick={toggleSelectAllExport} className="flex items-center gap-2 text-sm text-zinc-200">
              <span className={`w-5 h-5 rounded-md border flex items-center justify-center ${allFilteredSelected ? "bg-blue-600 border-blue-500" : "border-zinc-600"}`}>
                {allFilteredSelected ? <Check size={13} /> : null}
              </span>
              전체선택
            </button>
            <span className="text-sm text-zinc-400">{exportSel.size}곡 선택됨</span>
            <div className="flex-1" />
            <button
              onClick={doExport}
              disabled={!exportSel.size}
              className="px-4 py-2 rounded-lg bg-blue-700 hover:bg-blue-600 text-white text-sm disabled:opacity-40 whitespace-nowrap"
            >
              Export (.pmd)
            </button>
          </div>
        ) : null}

        {view === "cards" ? (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
          {filtered.map((p) => (
            <div key={p.id} className="relative rounded-2xl border border-zinc-800 bg-zinc-950/60 hover:bg-zinc-900/60 overflow-hidden">
              <button onClick={() => onCardClick(p)} className="block w-full text-left">
                <div className="aspect-square bg-zinc-900 relative">
                  {p.thumbnail_url ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={p.thumbnail_url} alt="thumb" className={`w-full h-full object-cover ${p.video_ready === false ? "grayscale opacity-60" : ""}`} />
                  ) : null}
                  {queuedIds.has(p.video_id) ? (
                    <div className={`absolute top-2 text-[10px] px-2 py-0.5 rounded-full bg-blue-600/90 text-white font-semibold ${exportMode ? "left-9" : "left-2"}`}>
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
                    {contentBadge(p, "lyrics")}
                    {contentBadge(p, "chords")}
                  </div>
                </div>
              </button>

              {exportMode ? (
                <button
                  onClick={() => toggleExportSel(p.id)}
                  aria-label="내보내기 선택"
                  className={`absolute top-2 left-2 z-10 w-6 h-6 rounded-md border flex items-center justify-center ${
                    exportSel.has(p.id) ? "bg-blue-600 border-blue-500 text-white" : "bg-zinc-950/80 border-zinc-600 text-transparent"
                  }`}
                >
                  <Check size={14} />
                </button>
              ) : null}

              {p.video_ready === false && !exportMode ? (
                <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      void downloadPreset(p);
                    }}
                    className="pointer-events-auto flex items-center gap-1.5 px-4 py-2 rounded-lg bg-black/75 border border-zinc-500 text-white text-xs font-semibold hover:bg-black/95"
                  >
                    <Download size={13} />
                    Download
                  </button>
                </div>
              ) : null}

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
        ) : (
        <div className="space-y-2">
          {filtered.map((p) => (
            <div key={p.id} className="relative rounded-xl border border-zinc-800 bg-zinc-950/60 hover:bg-zinc-900/60">
              <button onClick={() => onCardClick(p)} className={`flex items-center gap-3 w-full text-left py-2 pr-[140px] ${exportMode ? "pl-12" : "p-2"}`}>
                <div className="w-12 h-12 rounded-lg overflow-hidden bg-zinc-900 shrink-0">
                  {p.thumbnail_url ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={p.thumbnail_url} alt="thumb" className={`w-12 h-12 object-cover ${p.video_ready === false ? "grayscale opacity-60" : ""}`} />
                  ) : null}
                </div>
                <div className="flex-1 min-w-0 space-y-0.5">
                  <div className="text-sm text-zinc-100 truncate">{p.title || p.name || p.video_id}</div>
                  <div className="text-[11px] text-zinc-500 truncate">{p.video_id}</div>
                  <div className="flex items-center gap-2 flex-wrap">
                    {queuedIds.has(p.video_id) ? (
                      <div className="text-[10px] px-2 py-0.5 rounded-full bg-blue-600/90 text-white font-semibold">준비 중…</div>
                    ) : null}
                    {p.bpm != null ? <div className="text-[11px] px-2 py-0.5 rounded-full border border-zinc-800 text-zinc-300">{p.bpm} BPM</div> : null}
                    {p.key_tonic && p.key_mode ? (
                      <div className="text-[11px] px-2 py-0.5 rounded-full border border-zinc-800 text-zinc-300">
                        {p.key_tonic}{p.key_mode === "minor" ? "m" : "M"}
                      </div>
                    ) : null}
                    {contentBadge(p, "lyrics")}
                    {contentBadge(p, "chords")}
                    {p.video_ready === false && !exportMode ? (
                      <div className="text-[10px] px-2 py-0.5 rounded-full border border-zinc-700 text-zinc-400">영상 없음</div>
                    ) : null}
                  </div>
                </div>
              </button>

              {exportMode ? (
                <button
                  onClick={() => toggleExportSel(p.id)}
                  aria-label="내보내기 선택"
                  className={`absolute left-3 top-1/2 -translate-y-1/2 w-6 h-6 rounded-md border flex items-center justify-center ${
                    exportSel.has(p.id) ? "bg-blue-600 border-blue-500 text-white" : "bg-zinc-950/80 border-zinc-600 text-transparent"
                  }`}
                >
                  <Check size={14} />
                </button>
              ) : null}

              {p.video_ready === false && !exportMode ? (
                <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      void downloadPreset(p);
                    }}
                    className="pointer-events-auto flex items-center gap-1.5 px-4 py-2 rounded-lg bg-black/75 border border-zinc-500 text-white text-xs font-semibold hover:bg-black/95"
                  >
                    <Download size={13} />
                    Download
                  </button>
                </div>
              ) : null}
              <div className="absolute right-2 top-1/2 -translate-y-1/2 flex gap-2">
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
        )}
      </div>

      {/* toast */}
      {toastMsg ? (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 px-4 py-2 rounded-xl bg-zinc-800 border border-zinc-700 text-sm shadow-lg">
          {toastMsg}
        </div>
      ) : null}

      {/* 내용 뷰어 (읽기 전용) — 헤더 backdrop-blur 함정 회피 위해 portal로 렌더 */}
      {viewer
        ? createPortal(
            <div
              className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 p-4"
              onMouseDown={(e) => {
                if (e.target === e.currentTarget) closeViewer();
              }}
            >
              <div className="bg-zinc-950 border border-zinc-800 rounded-2xl p-5 w-full max-w-2xl space-y-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-sm font-semibold text-zinc-100 truncate">
                      {viewer.preset.title || viewer.preset.name || viewer.preset.video_id}
                    </div>
                    <div className="text-[11px] text-zinc-500">
                      {viewer.kind === "lyrics" ? "가사 (읽기 전용)" : "코드 (읽기 전용)"}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      onClick={copyViewerText}
                      className="text-xs px-3 py-1.5 rounded-lg border border-zinc-700 hover:bg-zinc-800"
                    >
                      복사
                    </button>
                    <button
                      onClick={closeViewer}
                      className="w-7 h-7 rounded-lg text-zinc-500 hover:text-white hover:bg-zinc-800"
                      title="닫기"
                    >
                      ✕
                    </button>
                  </div>
                </div>
                <textarea
                  readOnly
                  value={viewerText}
                  className="w-full h-80 bg-zinc-900 border border-zinc-800 rounded-xl p-3 font-mono text-xs text-zinc-200 leading-relaxed resize-none focus:outline-none"
                />
                <div className="text-[11px] text-zinc-500">
                  타임스탬프 포함 원문입니다. 복사 버튼 또는 텍스트 클릭 후 Cmd+A → Cmd+C로 복사할 수 있어요.
                </div>
              </div>
            </div>,
            document.body
          )
        : null}

      {/* Import Data 모달 — 드래그&드롭 + 항목별 체크 선택 (기본 전체 체크) */}
      {importOpen
        ? createPortal(
            <div
              className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 p-4"
              onMouseDown={(e) => {
                if (e.target === e.currentTarget) closeImport();
              }}
            >
              <div className="bg-zinc-950 border border-zinc-800 rounded-2xl p-5 w-full max-w-2xl space-y-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="text-sm font-semibold text-zinc-100">Import Data (.pmd)</div>
                  <button
                    onClick={closeImport}
                    className="w-7 h-7 rounded-lg text-zinc-500 hover:text-white hover:bg-zinc-800"
                    title="닫기"
                  >
                    ✕
                  </button>
                </div>

                {!importItems ? (
                  <div
                    onClick={() => fileInputRef.current?.click()}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={(e) => {
                      e.preventDefault();
                      const f = e.dataTransfer.files?.[0];
                      if (f) void parsePmdFile(f);
                    }}
                    className="border-2 border-dashed border-zinc-700 rounded-xl p-10 text-center cursor-pointer hover:border-zinc-500 transition-colors"
                  >
                    <Upload size={28} className="mx-auto mb-3 text-zinc-500" />
                    <div className="text-sm text-zinc-300">.pmd 파일을 여기로 끌어다 놓거나 클릭해서 선택하세요</div>
                    <div className="text-[11px] text-zinc-500 mt-1">다른 사용자에게 받은 공유 데이터 파일</div>
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept=".pmd,.json,application/json"
                      className="hidden"
                      onChange={(e) => {
                        const f = e.target.files?.[0];
                        if (f) void parsePmdFile(f);
                        e.target.value = "";
                      }}
                    />
                  </div>
                ) : (
                  <>
                    <div className="max-h-[50vh] overflow-y-auto space-y-1.5 pr-1">
                      {importItems.map((item, i) => {
                        const st = importStatus(item);
                        const chips: string[] = [];
                        if (item.bpm != null) chips.push(`${item.bpm} BPM`);
                        if (item.key_tonic)
                          chips.push(`${item.key_tonic}${item.key_mode === "minor" ? "m" : item.key_mode === "major" ? "M" : ""}`);
                        if (item.lyrics_lrc) chips.push("가사");
                        if (item.chords_lrc) chips.push("코드");
                        return (
                          <label
                            key={`${item.video_id}-${i}`}
                            className="flex items-center gap-3 p-2.5 rounded-lg border border-zinc-800 bg-zinc-900/50 cursor-pointer hover:bg-zinc-900"
                          >
                            <input
                              type="checkbox"
                              checked={importSel.has(i)}
                              onChange={() => toggleImportSel(i)}
                              className="accent-blue-600 w-4 h-4 shrink-0"
                            />
                            <div className="min-w-0 flex-1">
                              <div className="text-sm text-zinc-200 truncate">{item.title || item.video_id}</div>
                              <div className="flex items-center gap-1.5 pt-1 flex-wrap">
                                {chips.length ? (
                                  chips.map((c) => (
                                    <span key={c} className="text-[10px] px-1.5 py-0.5 rounded-full border border-zinc-700 text-zinc-300">
                                      {c}
                                    </span>
                                  ))
                                ) : (
                                  <span className="text-[10px] px-1.5 py-0.5 rounded-full border border-zinc-800 text-zinc-600">
                                    메타데이터 없음
                                  </span>
                                )}
                                <span
                                  className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${
                                    st.kind === "new"
                                      ? "bg-blue-950/60 border border-blue-800 text-blue-300"
                                      : st.kind === "fill"
                                        ? "bg-emerald-950/60 border border-emerald-800 text-emerald-300"
                                        : "bg-zinc-900 border border-zinc-800 text-zinc-500"
                                  }`}
                                >
                                  {st.label}
                                </span>
                              </div>
                            </div>
                          </label>
                        );
                      })}
                    </div>

                    <div className="flex items-center gap-3">
                      <label className="flex items-center gap-2 text-sm text-zinc-300 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={allImportSelected}
                          onChange={toggleSelectAllImport}
                          className="accent-blue-600 w-4 h-4"
                        />
                        전체선택
                      </label>
                      <span className="text-sm text-zinc-400">{importSel.size}곡 선택됨</span>
                      <div className="flex-1" />
                      <button
                        onClick={() => {
                          setImportItems(null);
                          setImportSel(new Set());
                          setImportError("");
                        }}
                        className="px-3 py-2 rounded-lg border border-zinc-700 text-sm hover:bg-zinc-800"
                      >
                        다른 파일
                      </button>
                      <button
                        onClick={() => void doImport()}
                        disabled={importBusy || !importSel.size}
                        className="px-4 py-2 rounded-lg bg-blue-700 hover:bg-blue-600 text-white text-sm disabled:opacity-40 whitespace-nowrap"
                      >
                        {importBusy ? "가져오는 중…" : `가져오기 (${importSel.size})`}
                      </button>
                    </div>
                  </>
                )}

                {importError ? <div className="text-xs text-red-300">{importError}</div> : null}
              </div>
            </div>,
            document.body
          )
        : null}
    </main>
  );
}
