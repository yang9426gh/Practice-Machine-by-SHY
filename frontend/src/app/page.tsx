"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Play, Pause, ChevronUp, ChevronDown, Maximize, Minimize } from "lucide-react";
import { BrandHeader, SupportButton } from "../components/Brand";

const BACKEND = process.env.NEXT_PUBLIC_BACKEND_URL || (typeof window !== "undefined" ? window.location.origin : "http://localhost:8011");

type Status = "idle" | "processing" | "completed";

type StemsMap = Record<string, string>; // stemName -> absolute URL
type LyricLine = { time: number; text: string };
type LyricsState = {
  lines: LyricLine[];
  offsetMs: number;
  lrc: string;
  source?: string;
} | null;

type ChordEv = { time: number; text: string };
type ChordLine = { time: number; chords: ChordEv[] };
type ChordsState = {
  lines: ChordLine[];      // 줄 단위 그룹핑 — 같은 줄의 코드들은 한 줄로 표시
  offsetMs: number;
  lrc: string;
  source?: string;
} | null;

// Jobs UI removed

// ---- 코드 트랜스포즈 표시 ----
// 알파벳 루트(A~G, 선택적 #/b)만 세미톤 이동. m/M/dim/aug/7/9 등 품질 표기는 그대로 유지.
const CHROMATIC_SHARP = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const CHROMATIC_FLAT = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"];
const transposeChordText = (text: string, delta: number): string => {
  if (!delta) return text;
  // 슬래시 코드: "Am7/C" → 루트 "Am7" + 베이스 "C" 각각 처리
  return text
    .split("/")
    .map((part) => {
      const m = part.match(/^([A-G])([#b♯♭]?)(.*)$/s);
      if (!m) return part;
      const [, root, acc, rest] = m;
      let idx = CHROMATIC_SHARP.indexOf(root.toUpperCase());
      if (acc === "#" || acc === "♯") idx += 1;
      else if (acc === "b" || acc === "♭") idx -= 1;
      if (idx < 0) return part;
      const shifted = (((idx + delta) % 12) + 12) % 12;
      // 원래 플랫 선호(예: Eb, Bb, Db)면 플랫 표기 유지, 아니면 샤프 표기
      const preferFlat = acc === "b" || acc === "♭";
      const name = preferFlat ? CHROMATIC_FLAT[shifted] : CHROMATIC_SHARP[shifted];
      return `${name}${rest}`;
    })
    .join("/");
};

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
  task_id?: string | null;
  video_ready?: boolean;
};

type StemLoadState =
  | { status: "idle" }
  | { status: "loading"; loaded: number; total?: number }
  | { status: "decoding" }
  | { status: "ready"; duration: number }
  | { status: "error"; error: string };

const decodedStemCache = new Map<string, Record<string, AudioBuffer>>();

function stemIcon(stem: string) {
  const s = (stem || "").toLowerCase();
  if (s === "vocals" || s === "vocal") return "🎤";
  if (s === "drums" || s === "drum") return "🥁";
  if (s === "bass") return "🎸";
  if (s === "guitar") return "🎸";
  if (s === "piano") return "🎹";
  if (s === "other" || s === "instruments" || s === "instrumental") return "🎶";
  if (s === "master") return "🎛️";
  if (s === "click" || s === "metronome") return "🔔";
  return "🎵";
}

function VerticalFader({
  value,
  onChange,
  disabled,
  height = 220,
}: {
  value: number;
  onChange: (v: number) => void;
  disabled?: boolean;
  height?: number;
}) {
  const trackRef = React.useRef<HTMLDivElement | null>(null);

  const clamp = (v: number) => Math.max(0, Math.min(100, v));

  const setFromClientY = (clientY: number) => {
    const el = trackRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const y = Math.max(r.top, Math.min(r.bottom, clientY));
    const t = (y - r.top) / Math.max(1, r.height); // 0..1 top->bottom
    const v = clamp((1 - t) * 100);
    onChange(v);
  };

  const pct = clamp(Number(value || 0));
  const knobY = (1 - pct / 100) * height;

  return (
    <div className="flex flex-col items-center select-none">
      <div
        ref={trackRef}
        className={`relative w-8 rounded-full border ${disabled ? "border-zinc-900 bg-zinc-950" : "border-zinc-700 bg-zinc-900"}`}
        style={{ height }}
        onPointerDown={(e) => {
          if (disabled) return;
          (e.currentTarget as any).setPointerCapture?.(e.pointerId);
          setFromClientY(e.clientY);
        }}
        onPointerMove={(e) => {
          if (disabled) return;
          if ((e.buttons & 1) === 0) return;
          setFromClientY(e.clientY);
        }}
      >
        <div className="absolute inset-x-0 bottom-0 rounded-full bg-blue-600/30" style={{ height: `${pct}%` }} />
        <div
          className={`absolute left-1/2 -translate-x-1/2 w-10 h-6 rounded-full border shadow ${disabled ? "border-zinc-800 bg-zinc-900" : "border-zinc-600 bg-zinc-200"}`}
          style={{ top: Math.max(0, Math.min(height - 24, knobY - 12)) }}
        />
      </div>
      <div className="mt-2 text-xs font-mono text-zinc-300">{Math.round(pct)}%</div>
    </div>
  );
}

function extractYouTubeId(input: string): string {
  try {
    const u = new URL(input);
    if (u.hostname.includes("youtu.be")) return u.pathname.replace("/", "");
    return u.searchParams.get("v") || "";
  } catch {
    const m = input.match(/v=([^&]+)/);
    if (m?.[1]) return m[1];
    const parts = input.split("/");
    return (parts[parts.length - 1] || "").split("?")[0];
  }
}

function clampTime(t: number, duration?: number) {
  const d = Number(duration);
  if (!isFinite(d) || d <= 0) return Math.max(0, t);
  return Math.max(0, Math.min(t, d - 0.01));
}

async function fetchArrayBufferWithProgress(
  url: string,
  onProgress: (loaded: number, total?: number) => void,
  signal?: AbortSignal
): Promise<ArrayBuffer> {
  const resp = await fetch(url, { signal });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

  const total = Number(resp.headers.get("content-length") || "");
  if (!resp.body) {
    const ab = await resp.arrayBuffer();
    onProgress(ab.byteLength, isFinite(total) ? total : undefined);
    return ab;
  }

  const reader = resp.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      loaded += value.byteLength;
      onProgress(loaded, isFinite(total) ? total : undefined);
    }
  }

  const out = new Uint8Array(loaded);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out.buffer;
}

export default function KaraokePage() {
  const router = useRouter();
  const handledQueryRef = useRef(false);

  const [url, setUrl] = useState("");
  const [videoId, setVideoId] = useState("");

  const [status, setStatus] = useState<Status>("idle");
  const [stage, setStage] = useState<string>("idle");
  const [progress, setProgress] = useState<number>(0);

  const [nowTitle, setNowTitle] = useState<string>("");
  const [nowThumb, setNowThumb] = useState<string>("");

  const [taskId, setTaskId] = useState<string>("");
  const [videoUrl, setVideoUrl] = useState<string>("");

  const [bpm, setBpm] = useState<string>("");
  const [bpmDetecting, setBpmDetecting] = useState(false);
  const [bpmDetectedAt, setBpmDetectedAt] = useState<number | null>(null);
  const [bpmStartOffset, setBpmStartOffset] = useState<number>(0);

  const NOTE_OPTIONS = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"] as const;
  const [keyTonic, setKeyTonic] = useState<string>("C");
  const [keyMode, setKeyMode] = useState<"major" | "minor">("major");
  const [keyDetecting, setKeyDetecting] = useState(false);

  const [stems, setStems] = useState<StemsMap>({});
  const [stemOrder, setStemOrder] = useState<string[]>([]);

  const [stemVolumes, setStemVolumes] = useState<Record<string, number>>({});
  const [masterVolume, setMasterVolume] = useState(100);
  // instrumental master slider removed

  type MixMode =
    | { kind: "select" }
    | { kind: "master" }
    | { kind: "vocal" }
    | { kind: "instrument"; instrument: string };

  const [mixMode, setMixMode] = useState<MixMode>({ kind: "select" });

  // Simple mode sliders (used in vocal/instrument modes)
  const [focusVol, setFocusVol] = useState(100);
  const [otherInstVol, setOtherInstVol] = useState(100);
  const [vocalsVol, setVocalsVol] = useState(100);
  const [instrumentsVol, setInstrumentsVol] = useState(100);

  const [isPlaying, setIsPlaying] = useState(false);
  const isPlayingRef = useRef(false);

  const [uiPos, setUiPos] = useState(0);
  const [isScrubbing, setIsScrubbing] = useState(false);
  const [scrubPos, setScrubPos] = useState(0);

  // Jobs UI removed


  const [toastMsg, setToastMsg] = useState<string>("");
  const toastTimerRef = useRef<any>(null);

  const [stemLoad, setStemLoad] = useState<Record<string, StemLoadState>>({});
  const [audioReady, setAudioReady] = useState(false);
  const [audioDuration, setAudioDuration] = useState<number>(0);

  // ---- Lyrics (LRC) ----
  const [lyrics, setLyrics] = useState<LyricsState>(null);
  const [lyricsOpen, setLyricsOpen] = useState(false);        // 모달: 가져오기/편집
  const [lyricsMode, setLyricsMode] = useState<"menu" | "lrclib" | "paste" | "edit">("menu");
  const [lyricsSearchTitle, setLyricsSearchTitle] = useState("");
  const [lyricsSearchArtist, setLyricsSearchArtist] = useState("");
  const [lyricsCandidates, setLyricsCandidates] = useState<any[]>([]);
  const [lyricsSearchBusy, setLyricsSearchBusy] = useState(false);
  const [lyricsPasteText, setLyricsPasteText] = useState("");
  const [lyricsEditText, setLyricsEditText] = useState("");
  const [lyricsShow, setLyricsShow] = useState(true);          // 오버레이 on/off
  // ---- Lyrics 스트립 높이 (가사 3줄 분량으로 타이트 고정, px) ----
  const [lyricsBandH, setLyricsBandH] = useState(112);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem("karaoke_ui_settings_v1");
      const s = raw ? JSON.parse(raw) : {};
      if (typeof s.lyricsBandH === "number" && s.lyricsBandH >= 64 && s.lyricsBandH <= 320)
        setLyricsBandH(s.lyricsBandH);
    } catch {}
  }, []);

  const setLyricsBand = (h: number) => {
    const v = Math.min(320, Math.max(64, Math.round(h)));
    setLyricsBandH(v);
    try {
      const raw = window.localStorage.getItem("karaoke_ui_settings_v1");
      const s = raw ? JSON.parse(raw) : {};
      s.lyricsBandH = v;
      window.localStorage.setItem("karaoke_ui_settings_v1", JSON.stringify(s));
    } catch {}
  };


  // ---- Chords (코드악보) — 직접 입력 전용, 가사와 동일한 LRC식 타임스탬프 ----
  const [chords, setChords] = useState<ChordsState>(null);
  const [chordsShow, setChordsShow] = useState(true);          // 코드 스트립 on/off
  const [chordsOpen, setChordsOpen] = useState(false);         // 모달: 만들기/편집
  const [chordsMode, setChordsMode] = useState<"create" | "edit">("create");
  const [chordsText, setChordsText] = useState("");
  const [chordsSaving, setChordsSaving] = useState(false);

  // ---- Chords 스트립 높이 (영상 위 밴드, px) ----
  const [chordsBandH, setChordsBandH] = useState(88);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem("karaoke_ui_settings_v1");
      const s = raw ? JSON.parse(raw) : {};
      if (typeof s.chordsBandH === "number" && s.chordsBandH >= 56 && s.chordsBandH <= 240)
        setChordsBandH(s.chordsBandH);
    } catch {}
  }, []);

  const setChordsBand = (h: number) => {
    const v = Math.min(240, Math.max(56, Math.round(h)));
    setChordsBandH(v);
    try {
      const raw = window.localStorage.getItem("karaoke_ui_settings_v1");
      const s = raw ? JSON.parse(raw) : {};
      s.chordsBandH = v;
      window.localStorage.setItem("karaoke_ui_settings_v1", JSON.stringify(s));
    } catch {}
  };

  // 현재 줄 (가사와 동일 로직 — offset 적용)
  const chordActiveIdx = React.useMemo(() => {
    if (!chordsShow || !chords || chords.lines.length === 0) return -1;
    const t = (isScrubbing ? scrubPos : uiPos) - (chords.offsetMs || 0) / 1000;
    let idx = -1;
    for (let i = 0; i < chords.lines.length; i++) {
      if (chords.lines[i].time <= t + 0.02) idx = i;
      else break;
    }
    return idx;
  }, [chords, chordsShow, uiPos, isScrubbing, scrubPos]);

  // 현재 줄 안에서 하이라이트할 코드 인덱스
  const chordInLineIdx = React.useMemo(() => {
    if (chordActiveIdx < 0 || !chords) return -1;
    const t = (isScrubbing ? scrubPos : uiPos) - (chords.offsetMs || 0) / 1000;
    const arr = chords.lines[chordActiveIdx].chords;
    let idx = -1;
    for (let i = 0; i < arr.length; i++) {
      if (arr[i].time <= t + 0.02) idx = i;
      else break;
    }
    return idx;
  }, [chords, chordActiveIdx, uiPos, isScrubbing, scrubPos]);

  const openChordsEditor = async (mode: "create" | "edit") => {
    if (mode === "edit" && videoId) {
      // 최신 원문을 서버에서 다시 읽어 편집기에 반영
      try {
        const r = await fetch(`${BACKEND}/chords/${videoId}`);
        if (r.ok) setChordsText((await r.json()).lrc || "");
        else setChordsText(chords?.lrc || "");
      } catch {
        setChordsText(chords?.lrc || "");
      }
    } else {
      setChordsText("");
    }
    setChordsMode(mode);
    setChordsOpen(true);
  };

  const chordsSave = async () => {
    const text = chordsText.trim();
    if (!text) return;
    if (!/\[\d{1,3}:\d{1,2}/.test(text)) {
      toast("타임스탬프가 없습니다 — [mm:ss.xx] 코드 형식 필요");
      return;
    }
    setChordsSaving(true);
    try {
      const r = await fetch(`${BACKEND}/chords/${videoId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lrc: text }),
      });
      const j = await r.json();
      if (r.ok && j.lines?.length) {
        setChords({ lines: j.lines, offsetMs: j.offset_ms || 0, lrc: text, source: chords?.source || "직접 입력" });
        setChordsShow(true);
        setChordsOpen(false);
        toast(`코드 저장 완료 (${j.lines.length}줄)`);
      } else {
        toast(`저장 실패: ${j.detail || "?"}`);
      }
    } catch (e: any) {
      toast(`저장 실패: ${String(e?.message || e)}`);
    } finally {
      setChordsSaving(false);
    }
  };

  // 코드용 스탬프: 커서 위치에 [시각] 삽입 — 줄바꿈 없이 인라인.
  // 빈 스탬프 연타 허용: 바로 앞이 "빈 스탬프+공백"이어도 교체하지 않고 새 스탬프를 추가한다
  // (시간 먼저 여러 개 찍어두고 나중에 코드 채우기 워크플로).
  const stampChordAtCursor = () => {
    const el = document.getElementById("chords-edit-area") as HTMLTextAreaElement | null;
    const t = Math.max(0, currentPositionLive());
    const mm = Math.floor(t / 60);
    const ss = t - mm * 60;
    const stamp = `[${String(mm).padStart(2, "0")}:${ss.toFixed(2).padStart(5, "0")}]`;
    if (!el) {
      setChordsText((prev) => (prev ? `${prev.replace(/\s*$/, "")} ${stamp} ` : `${stamp} `));
      return;
    }
    const start = el.selectionStart ?? chordsText.length;
    const end = el.selectionEnd ?? start;
    const text = chordsText;
    const before = text.slice(0, start);
    const after = text.slice(end);
    // 바로 앞이 "코드가 붙은 스탬프"면 재찍기(교체) — 잘못 찍은 스탬프 정리용.
    // 빈 스탬프(뒤에 코드 없이 공백/줄끝)면 그대로 두고 새 스탬프 추가.
    const m = before.match(/\[\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?\][^\s\[]*$/);
    let newText: string;
    let caret: number;
    if (m) {
      const s0 = start - m[0].length;
      newText = text.slice(0, s0) + stamp + " " + after;
      caret = s0 + stamp.length + 1;
    } else {
      const prevCh = start > 0 ? text[start - 1] : "\n";
      const pad = start === 0 || /\s/.test(prevCh) ? "" : " ";
      newText = before + pad + stamp + " " + after;
      caret = start + pad.length + stamp.length + 1;
    }
    setChordsText(newText);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(caret, caret);
    });
  };

  // 코드 편집창 줄바꿈 버튼 — 커서 위치에서 엔터와 동일
  const newlineInChordsEditor = () => {
    const el = document.getElementById("chords-edit-area") as HTMLTextAreaElement | null;
    if (!el) return;
    const start = el.selectionStart ?? chordsText.length;
    const end = el.selectionEnd ?? start;
    const before = chordsText.slice(0, start);
    const after = chordsText.slice(end);
    const newText = `${before}\n${after}`;
    const caret = start + 1;
    setChordsText(newText);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(caret, caret);
    });
  };

  const videoWrapRef = useRef<HTMLDivElement | null>(null);
  const [videoH, setVideoH] = useState<number | null>(null);
  const [videoResizing, setVideoResizing] = useState(false);
  const videoResizeRef = useRef<{ startY: number; startH: number; dir: "top" | "bottom" } | null>(null);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem("karaoke_ui_settings_v1");
      const s = raw ? JSON.parse(raw) : {};
      if (typeof s.videoH === "number" && s.videoH >= 120) setVideoH(s.videoH);
    } catch {}
  }, []);

  useEffect(() => {
    const onWinResize = () =>
      setVideoH((h) => (h == null ? null : Math.min(h, Math.max(140, window.innerHeight - 220))));
    window.addEventListener("resize", onWinResize);
    return () => window.removeEventListener("resize", onWinResize);
  }, []);

  const persistVideoH = (h: number | null) => {
    try {
      const raw = window.localStorage.getItem("karaoke_ui_settings_v1");
      const s = raw ? JSON.parse(raw) : {};
      if (h == null) delete s.videoH;
      else s.videoH = h;
      window.localStorage.setItem("karaoke_ui_settings_v1", JSON.stringify(s));
    } catch {}
  };

  const onVideoResizeDown = (dir: "top" | "bottom") => (e: React.PointerEvent<HTMLDivElement>) => {
    const el = videoWrapRef.current;
    if (!el) return;
    videoResizeRef.current = { startY: e.clientY, startH: el.getBoundingClientRect().height, dir };
    e.currentTarget.setPointerCapture(e.pointerId);
    setVideoResizing(true);
  };

  const onVideoResizeMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = videoResizeRef.current;
    if (!d) return;
    const delta = e.clientY - d.startY;
    const max = Math.max(140, window.innerHeight - 220);
    const next = d.dir === "top" ? d.startH - delta : d.startH + delta;
    setVideoH(Math.min(max, Math.max(120, next)));
  };

  const onVideoResizeUp = () => {
    if (!videoResizeRef.current) return;
    videoResizeRef.current = null;
    setVideoResizing(false);
    setVideoH((h) => {
      if (h != null) persistVideoH(h);
      return h;
    });
  };

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const videoProgrammaticSeekAtRef = useRef<number>(0);

  // 현재 시각에 맞는 가사 줄 인덱스 (offset_ms: +면 가사를 늦게 표시)
  // 빈 스탬프(텍스트 없는 줄)는 표시 대상에서 제외 — 시간 정보만 있음
  const lyricLines = React.useMemo(
    () => (lyrics ? lyrics.lines.filter((l) => (l.text || "").trim()) : []),
    [lyrics]
  );
  const lyricActiveIdx = React.useMemo(() => {
    if (!lyricsShow || lyricLines.length === 0) return -1;
    const t = (isScrubbing ? scrubPos : uiPos) - (lyrics?.offsetMs || 0) / 1000;
    let idx = -1;
    for (let i = 0; i < lyricLines.length; i++) {
      if (lyricLines[i].time <= t + 0.02) idx = i;
      else break;
    }
    return idx;
  }, [lyricLines, lyrics?.offsetMs, uiPos, isScrubbing, scrubPos, lyricsShow]);

  // WebAudio engine refs
  const audioCtxRef = useRef<AudioContext | null>(null);
  const masterGainRef = useRef<GainNode | null>(null);
  const instGainRef = useRef<GainNode | null>(null);
  const vocalsBusGainRef = useRef<GainNode | null>(null);
  const focusBusGainRef = useRef<GainNode | null>(null);
  const otherBusGainRef = useRef<GainNode | null>(null);
  const stemGainsRef = useRef<Record<string, GainNode>>({});
  const sourcesRef = useRef<Record<string, AudioBufferSourceNode>>({});
  const buffersRef = useRef<Record<string, AudioBuffer>>({});

  const startedAtRef = useRef<number>(0); // audioCtx.currentTime when last started
  const offsetRef = useRef<number>(0); // seconds into track when last started

  const loadAbortRef = useRef<AbortController | null>(null);

  // ---- Lyrics handlers ----
  const lyricsFetchSaved = React.useCallback(async (vid: string) => {
    if (!vid) return;
    try {
      const r = await fetch(`${BACKEND}/lyrics/${vid}`);
      if (r.ok) {
        const j = await r.json();
        if (j.lines?.length) {
          setLyrics({ lines: j.lines, offsetMs: j.offset_ms || 0, lrc: j.lrc, source: "saved" });
          return;
        }
      }
      setLyrics(null);
    } catch {
      /* ignore */
    }
  }, []);

  const openLyricsMenu = () => {
    setLyricsOpen(true);
    setLyricsMode("menu");
    setLyricsCandidates([]);
    setLyricsPasteText("");
    // 검색 기본값: 현재 곡 제목에서 paren/feat 제거 후 사용
    const t = (nowTitle || "").replace(/\(.*?\)|\[.*?\]|feat\..*$/gi, "").trim();
    setLyricsSearchTitle(t);
    setLyricsSearchArtist("");
  };

  const lrclibSearch = async () => {
    setLyricsSearchBusy(true);
    setLyricsCandidates([]);
    try {
      const body: any = {};
      if (lyricsSearchTitle) body.title = lyricsSearchTitle;
      if (lyricsSearchArtist) body.artist = lyricsSearchArtist;
      if (!body.title && !body.artist) {
        const t = (nowTitle || "").trim();
        if (t) body.q = t;
      }
      const r = await fetch(`${BACKEND}/lyrics/${videoId}/import`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...body, duration: audioDuration || undefined }),
      });
      const j = await r.json();
      if (j.saved) {
        setLyrics({ lines: j.lines, offsetMs: j.offset_ms || 0, lrc: "", source: j.source ? `${j.source.artist} - ${j.source.title} (LRCLIB)` : "LRCLIB" });
        setLyricsOpen(false);
        toast(`가사 가져옴: ${j.source?.title || "LRCLIB"}`);
      } else if (j.candidates?.length) {
        setLyricsCandidates(j.candidates);
        toast(`${j.candidates.length}개 후보 — 선택하세요`);
      } else {
        toast("LRCLIB에서 찾지 못했습니다 — 직접 업로드를 이용하세요");
      }
    } catch (e: any) {
      toast(`LRCLIB 검색 실패: ${String(e?.message || e)}`);
    } finally {
      setLyricsSearchBusy(false);
    }
  };

  const lrclibPick = async (c: any) => {
    setLyricsSearchBusy(true);
    try {
      const body: any = { candidate_id: String(c.id) };
      if (lyricsSearchTitle) body.title = lyricsSearchTitle;
      if (lyricsSearchArtist) body.artist = lyricsSearchArtist;
      const r = await fetch(`${BACKEND}/lyrics/${videoId}/import`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const j = await r.json();
      if (j.saved) {
        setLyrics({ lines: j.lines, offsetMs: j.offset_ms || 0, lrc: "", source: `${c.artist} - ${c.title} (LRCLIB)` });
        setLyricsOpen(false);
        toast(`가사 가져옴: ${c.title}`);
      } else {
        toast("저장 실패 — 동기화 가사가 없는 후보일 수 있음");
      }
    } catch (e: any) {
      toast(`가져오기 실패: ${String(e?.message || e)}`);
    } finally {
      setLyricsSearchBusy(false);
    }
  };

  const lyricsSavePaste = async () => {
    const text = lyricsPasteText.trim();
    if (!text) return;
    if (!/\[\d{1,3}:\d{1,2}/.test(text)) {
      toast("타임스탬프가 없는 LRC입니다 — [mm:ss.xx] 형식 필요");
      return;
    }
    try {
      const r = await fetch(`${BACKEND}/lyrics/${videoId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lrc: text }),
      });
      const j = await r.json();
      if (r.ok && j.lines?.length) {
        setLyrics({ lines: j.lines, offsetMs: j.offset_ms || 0, lrc: text, source: "직접 업로드" });
        setLyricsOpen(false);
        toast(`가사 저장 완료 (${j.lines.length}줄)`);
      } else {
        toast(`저장 실패: ${j.detail || "?"}`);
      }
    } catch (e: any) {
      toast(`저장 실패: ${String(e?.message || e)}`);
    }
  };

  const lyricsSaveEdit = async () => {
    try {
      const r = await fetch(`${BACKEND}/lyrics/${videoId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lrc: lyricsEditText }),
      });
      const j = await r.json();
      if (r.ok && j.lines?.length) {
        setLyrics({ lines: j.lines, offsetMs: j.offset_ms || 0, lrc: lyricsEditText, source: lyrics?.source || "편집됨" });
        setLyricsOpen(false);
        toast("가사 편집 저장 완료");
      } else {
        toast(`저장 실패: ${j.detail || "?"}`);
      }
    } catch (e: any) {
      toast(`저장 실패: ${String(e?.message || e)}`);
    }
  };

  const lyricsSaveOffset = async (ms: number) => {
    setLyrics((prev) => (prev ? { ...prev, offsetMs: ms } : prev));
    // LRC 헤더의 [offset:ms] 태그로 영구 저장
    try {
      const r = await fetch(`${BACKEND}/lyrics/${videoId}`);
      if (r.ok) {
        const j = await r.json();
        let lrc: string = j.lrc || "";
        lrc = lrc.replace(/^\[offset:[^\]]*\]\n?/mi, "").replace(/\n\[offset:[^\]]*\]/mi, "");
        const tag = ms === 0 ? "" : `[offset:${ms > 0 ? "+" : ""}${ms}]`;
        const linesArr = lrc.split("\n");
        const insertAt = linesArr.findIndex((l) => !/^\[(ti|ar|al|length):/i.test(l));
        if (tag) linesArr.splice(insertAt < 0 ? 0 : insertAt, 0, tag);
        await fetch(`${BACKEND}/lyrics/${videoId}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ lrc: linesArr.join("\n") }),
        });
      }
    } catch {}
  };

  // 실시간 재생 위치 (uiPos 틱과 무관하게 즉시값 — 버튼 표시/스탬프용)
  const currentPositionLive = () => {
    const ctx = audioCtxRef.current;
    if (!ctx || !isPlayingRef.current) return offsetRef.current;
    return offsetRef.current + Math.max(0, ctx.currentTime - startedAtRef.current);
  };

  // 편집기 텍스트커서 위치에 현재 재생 시간 스탬프 삽입 후 커서를 다음 줄 맨 앞으로 (연타 워크플로)
  const stampAtCursor = () => {
    const el = document.getElementById("lyrics-edit-area") as HTMLTextAreaElement | null;
    const t = Math.max(0, currentPositionLive());
    const mm = Math.floor(t / 60);
    const ss = t - mm * 60;
    const stamp = `[${String(mm).padStart(2, "0")}:${ss.toFixed(2).padStart(5, "0")}]`;
    if (!el) {
      // 폴백: 커서 정보 없으면 텍스트 끝에 추가
      setLyricsEditText((prev) => (prev ? `${prev.replace(/\s*$/, "")}\n${stamp} ` : `${stamp} `));
      return;
    }
    // 삽입 전 textarea/모달 스크롤 위치 저장 (focus가 스크롤을 강제 이동시키는 것 방지)
    const prevScrollTop = el.scrollTop;
    const scroller = el.closest("[data-lyrics-scroll]") as HTMLElement | null;
    const prevScrollerTop = scroller ? scroller.scrollTop : null;
    const start = el.selectionStart ?? lyricsEditText.length;
    const end = el.selectionEnd ?? start;
    const text = lyricsEditText;
    const before = text.slice(0, start);
    const after = text.slice(end);
    // 커서가 있는 줄이 스탬프만 있는 줄이면 기존 스탬프 교체(덮어쓰기)
    const lineStart = before.lastIndexOf("\n") + 1;
    const nlAfter = after.indexOf("\n");
    const curLine = before.slice(lineStart) + (nlAfter < 0 ? after : after.slice(0, nlAfter));
    const existing = curLine.match(/^\s*\[\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?\]\s*$/);
    const insertText = `${stamp} `;
    let newText: string;
    let insertPos: number;
    if (existing && start > lineStart) {
      newText = text.slice(0, lineStart) + insertText + text.slice(lineStart + curLine.length);
      insertPos = lineStart;
    } else {
      // 줄 중간에 삽입 시 앞 글자가 비공백이면 공백 하나 두고 붙임
      const prevCh = start > 0 ? text[start - 1] : "\n";
      const pad = start === 0 || /\s/.test(prevCh) ? "" : " ";
      newText = before + pad + insertText + after;
      insertPos = start + pad.length;
    }
    // 커서 → 다음 줄 맨 앞 (마지막 줄이면 새 줄 추가)
    let caret: number;
    const nlIdx = newText.indexOf("\n", insertPos);
    if (nlIdx < 0) {
      newText += "\n";
      caret = newText.length;
    } else {
      caret = nlIdx + 1;
    }
    setLyricsEditText(newText);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(caret, caret);
      // 기본 스크롤 점프 억제: 원래 위치 복원, 단 커서 줄이 완전히 안 보이면 최소한만 이동
      const lh = parseFloat(getComputedStyle(el).lineHeight) || 20;
      const lineIdx = newText.slice(0, caret).split("\n").length - 1;
      const caretTop = lineIdx * lh;
      let st = prevScrollTop;
      if (caretTop < st) st = caretTop;
      else if (caretTop + lh > st + el.clientHeight) st = caretTop + lh - el.clientHeight;
      el.scrollTop = st;
      if (scroller && prevScrollerTop != null) scroller.scrollTop = prevScrollerTop;
    });
  };

  // 편집창에서 기록된 스탬프 클릭 → 해당 시각으로 시크 (가사/코드 편집창 공용)
  const handleStampClickIn = (elId: string, text: string) => {
    const el = document.getElementById(elId) as HTMLTextAreaElement | null;
    if (!el) return;
    const pos = el.selectionStart;
    if (el.selectionStart !== el.selectionEnd) return; // 드래그 선택은 무시
    const lineStart = text.lastIndexOf("\n", pos - 1) + 1;
    let lineEnd = text.indexOf("\n", pos);
    if (lineEnd < 0) lineEnd = text.length;
    const line = text.slice(lineStart, lineEnd);
    const off = pos - lineStart;
    const re = /\[(\d{1,3}):(\d{1,2}(?:[.:]\d{1,3})?)\]/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(line)) !== null) {
      // 클릭 지점이 스탬프 토큰 내부(선행 [ 제외, 마지막 글자 포함)인지
      if (off >= m.index + 1 && off <= m.index + m[0].length) {
        const t = parseInt(m[1], 10) * 60 + parseFloat(m[2].replace(":", "."));
        if (isFinite(t)) void seekTo(Math.max(0, t));
        break;
      }
    }
  };

  const handleEditClick = () => handleStampClickIn("lyrics-edit-area", lyricsEditText);
  const handleChordsEditClick = () => handleStampClickIn("chords-edit-area", chordsText);

  // 가사 생성 — 빈 편집창 바로 시작 (수동 싱크 워크플로)
  const lyricsCreateNew = () => {
    setLyricsEditText("");
    setLyricsOpen(true);
    setLyricsMode("edit");
  };

  const toast = (msg: string, ms: number = 2200) => {
    setToastMsg(msg);
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => setToastMsg(""), ms);
  };

  const getAudioCtx = () => {
    if (!audioCtxRef.current) audioCtxRef.current = new AudioContext();
    const ctx = audioCtxRef.current;

    if (!masterGainRef.current) {
      masterGainRef.current = ctx.createGain();
      masterGainRef.current.connect(ctx.destination);
    }

    // Master-mode buses
    if (!instGainRef.current) {
      instGainRef.current = ctx.createGain();
      instGainRef.current.connect(masterGainRef.current);
    }

    // Focus-mode buses
    if (!vocalsBusGainRef.current) {
      vocalsBusGainRef.current = ctx.createGain();
      vocalsBusGainRef.current.connect(masterGainRef.current);
    }
    if (!focusBusGainRef.current) {
      focusBusGainRef.current = ctx.createGain();
      focusBusGainRef.current.connect(masterGainRef.current);
    }
    if (!otherBusGainRef.current) {
      otherBusGainRef.current = ctx.createGain();
      otherBusGainRef.current.connect(masterGainRef.current);
    }

    return ctx;
  };

  const currentPosition = () => {
    const ctx = audioCtxRef.current;
    if (!ctx) return offsetRef.current;
    if (!isPlaying) return offsetRef.current;
    return offsetRef.current + Math.max(0, ctx.currentTime - startedAtRef.current);
  };

  const stopSources = () => {
    try {
      for (const s of Object.values(sourcesRef.current)) {
        try {
          s.stop();
        } catch {}
        try {
          s.disconnect();
        } catch {}
      }
    } catch {}
    sourcesRef.current = {};
  };

  const pauseAudio = () => {
    const pos = currentPosition();
    stopSources();
    offsetRef.current = clampTime(pos, audioDuration);
    isPlayingRef.current = false;
    setIsPlaying(false);

    try {
      videoRef.current?.pause();
    } catch {}
  };

  const unloadAudio = async () => {
    try {
      pauseAudio();
    } catch {}

    try {
      loadAbortRef.current?.abort();
    } catch {}
    loadAbortRef.current = null;

    try {
      stopSources();
    } catch {}

    // Fully close AudioContext so audio cannot continue after navigation.
    try {
      const ctx = audioCtxRef.current;
      audioCtxRef.current = null;
      if (ctx) await ctx.close();
    } catch {}

    try {
      // best-effort disconnect buses
      masterGainRef.current?.disconnect();
    } catch {}
    masterGainRef.current = null;
    instGainRef.current = null;
    vocalsBusGainRef.current = null;
    focusBusGainRef.current = null;
    otherBusGainRef.current = null;

    sourcesRef.current = {};
    buffersRef.current = {};
    stemGainsRef.current = {};

    offsetRef.current = 0;
    startedAtRef.current = 0;
    setAudioReady(false);
    setAudioDuration(0);
    setStemLoad({});
  };

  const playAudio = async () => {
    if (!audioReady) return;

    const ctx = getAudioCtx();
    try {
      if (ctx.state !== "running") await ctx.resume();
    } catch {
      // will fail until user gesture
    }

    const startOffset = clampTime(offsetRef.current, audioDuration);
    stopSources();

    // Ensure gain nodes exist / connected for current stem set.
    for (const stem of stemOrder) {
      if (!stemGainsRef.current[stem]) {
        const g = ctx.createGain();
        stemGainsRef.current[stem] = g;
      }
      // Reconnect each time based on current mode (safe: disconnect best-effort)
      try {
        stemGainsRef.current[stem].disconnect();
      } catch {}

      // click track removed

      if (mixMode.kind === "master") {
        // vocals direct -> master, others -> instrumental bus
        if (stem === "vocals") stemGainsRef.current[stem].connect(masterGainRef.current!);
        else stemGainsRef.current[stem].connect(instGainRef.current!);
      } else if (mixMode.kind === "vocal") {
        if (stem === "vocals") stemGainsRef.current[stem].connect(focusBusGainRef.current!);
        else stemGainsRef.current[stem].connect(otherBusGainRef.current!);
      } else if (mixMode.kind === "instrument") {
        if (stem === "vocals") stemGainsRef.current[stem].connect(vocalsBusGainRef.current!);
        else if (stem === mixMode.instrument) stemGainsRef.current[stem].connect(focusBusGainRef.current!);
        else stemGainsRef.current[stem].connect(otherBusGainRef.current!);
      } else {
        // select screen: default to master routing
        if (stem === "vocals") stemGainsRef.current[stem].connect(masterGainRef.current!);
        else stemGainsRef.current[stem].connect(instGainRef.current!);
      }
    }

    // Create fresh sources per stem (BufferSource is one-shot)
    const sources: Record<string, AudioBufferSourceNode> = {};
    for (const stem of stemOrder) {
      const buf = buffersRef.current[stem];
      if (!buf) continue;
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(stemGainsRef.current[stem]);
      sources[stem] = src;
    }

    sourcesRef.current = sources;
    startedAtRef.current = ctx.currentTime;
    offsetRef.current = startOffset;

    try {
      for (const src of Object.values(sources)) {
        // start immediately with an offset
        src.start(0, startOffset);
      }
    } catch (e: any) {
      toast(`Audio start failed: ${String(e?.message || e)}`);
      stopSources();
      return;
    }

    isPlayingRef.current = true;
    setIsPlaying(true);

    // Best-effort video follow
    try {
      if (videoRef.current) {
        videoRef.current.muted = true;
        videoRef.current.volume = 0;
        videoProgrammaticSeekAtRef.current = Date.now();
        videoRef.current.currentTime = startOffset;
        await videoRef.current.play();
      }
    } catch {
      // ignore
    }
  };

  const togglePlay = async () => {
    if (!audioReady) return;
    if (isPlaying) pauseAudio();
    else await playAudio();
  };

  // Switching mix modes while playing can feel jarring (routing changes / bus gains),
  // so we auto-pause on mode change.
  const modeKey = mixMode.kind === "instrument" ? `${mixMode.kind}:${mixMode.instrument}` : mixMode.kind;
  const lastModeKeyRef = useRef<string>(modeKey);
  useEffect(() => {
    const prev = lastModeKeyRef.current;
    if (prev !== modeKey) {
      lastModeKeyRef.current = modeKey;
      if (isPlayingRef.current) pauseAudio();
    }
  }, [modeKey]);

  const seekTo = async (t: number) => {
    const tt = clampTime(t, audioDuration);
    offsetRef.current = tt;

    try {
      if (videoRef.current) {
        videoProgrammaticSeekAtRef.current = Date.now();
        videoRef.current.currentTime = tt;
      }
    } catch {}

    if (isPlaying) {
      await playAudio();
    }
  };

  const jumpSeconds = async (delta: number) => {
    await seekTo(currentPosition() + delta);
  };

  const fmtTime = (t: number) => {
    if (!isFinite(t) || t < 0) t = 0;
    const m = Math.floor(t / 60);
    const s = Math.floor(t % 60);
    return `${m}:${String(s).padStart(2, "0")}`;
  };

  const [semitones, setSemitones] = useState(0); // applied
  // 표시 전용 코드 키 조절 (오디오 무관 — 화면의 코드만 이동). -11..+11, 저장 안 함.
  // 리셋 조건: 곡 로드(loadFromUrl) / transpose 적용(우선권) / 앱 종료(자연 소멸)
  const [keyAdj, setKeyAdj] = useState(0);
  const keyAdjLabel =
    keyAdj === 0 ? "0" : keyAdj > 0 ? `+${keyAdj}/-${12 - keyAdj}` : `${keyAdj}/+${12 + keyAdj}`;
  const capoValue = ((-keyAdj % 12) + 12) % 12; // keyAdj -1→Capo 1, +1→Capo 11, 0→Capo 0
  const [semitonesPending, setSemitonesPending] = useState(0);
  const [transposing, setTransposing] = useState(false);
  const [transposePct, setTransposePct] = useState<number>(0);
  // 트랜스포즈 후 이어듣기용 — 마지막 위치/재생 상태 (로드 완료 시 소비 후 초기화)
  const transposeResumeRef = useRef<{ pos: number; wasPlaying: boolean } | null>(null);

  const cacheKey = useMemo(() => {
    if (!videoId) return "";
    return `${videoId}|${semitones}`;
  }, [videoId, semitones]);

  const NOTE_OPTIONS_ORDER = useMemo(() => {
    const m: Record<string, number> = {};
    NOTE_OPTIONS.forEach((n, i) => (m[n] = i));
    return m;
  }, []);

  const shiftTonic = (tonic: string, delta: number) => {
    const i = NOTE_OPTIONS_ORDER[tonic];
    if (i == null) return tonic;
    const j = (i + delta + 1200) % 12;
    return NOTE_OPTIONS[j];
  };

  const displayedKeyTonic = useMemo(() => {
    return shiftTonic(keyTonic, semitones);
  }, [keyTonic, semitones]);

  const displayedKeyTonicPending = useMemo(() => {
    return shiftTonic(keyTonic, semitonesPending);
  }, [keyTonic, semitonesPending]);

  const applyTranspose = async (next: number) => {
    if (!taskId) return;
    if (status !== "completed") return;

    // 트랜스포즈 후 현재 위치에서 이어듣기 — 위치/재생 상태를 먼저 저장
    const resumePos = currentPosition();
    const resumeWasPlaying = isPlayingRef.current;
    transposeResumeRef.current = { pos: resumePos, wasPlaying: resumeWasPlaying };

    setTransposing(true);
    setTransposePct(0);

    // Poll backend progress while transpose is running
    const poll = setInterval(async () => {
      try {
        const sr = await fetch(`${BACKEND}/status/${taskId}`);
        const sj = await sr.json();
        if (sj.stage === "transposing" && typeof sj.progress === "number") {
          setTransposePct(Math.max(0, Math.min(99, Math.round(sj.progress))));
        }
      } catch {}
    }, 400);

    try {
      const tr = await fetch(`${BACKEND}/transpose/${taskId}?semitones=${next}`, { method: "POST" });
      const tj = await tr.json();
      if (!tr.ok) throw new Error(tj?.detail || "transpose failed");

      if (tj?.stems) {
        const stemsRel = tj.stems as Record<string, string>;
        const full: StemsMap = {};
        for (const [k, v] of Object.entries(stemsRel)) full[k] = `${BACKEND}${v}`;

        const names = Object.keys(full);
        names.sort((a, b) => {
          if (a === "vocals") return -1;
          if (b === "vocals") return 1;
          return a.localeCompare(b);
        });

        setStems(full);
        setStemOrder(names);
        resetPlayer();
      }

      setSemitones(next);
      setKeyAdj(0); // transpose 우선권 — 표시 키 조절은 0/Capo 0으로 리셋 (표시 코드 = transpose만 적용된 상태)
      setTransposePct(100);
    } catch (e: any) {
      toast(`Transpose failed: ${String(e?.message || e)}`);
      setSemitonesPending(semitones);
    } finally {
      clearInterval(poll);
      setTransposing(false);
    }
  };

  const canPlay = useMemo(() => {
    return audioReady && stemOrder.length > 0;
  }, [audioReady, stemOrder.length]);

  // UI clock for timeline
  useEffect(() => {
    if (!audioReady) {
      setUiPos(0);
      setScrubPos(0);
      setIsScrubbing(false);
      return;
    }

    const tick = () => {
      if (isScrubbing) return;
      setUiPos(currentPosition());
      setScrubPos(currentPosition());
    };

    tick();
    const t = setInterval(tick, 250);
    return () => clearInterval(t);
  }, [audioReady, isScrubbing, isPlaying, videoUrl, audioDuration]);

  // Overall load/decode percent for the Play button while stems are being fetched/decoded.
  const audioLoadPercent = useMemo(() => {
    if (!stemOrder.length) return null;
    let totalWeight = 0;
    let done = 0;

    for (const stem of stemOrder) {
      const st = stemLoad[stem];
      // Weight each stem equally.
      totalWeight += 1;

      if (!st || st.status === "idle") {
        done += 0;
      } else if (st.status === "ready") {
        done += 1;
      } else if (st.status === "error") {
        done += 0;
      } else if (st.status === "decoding") {
        // no % available; count as mostly done
        done += 0.9;
      } else if (st.status === "loading") {
        if (st.total && st.total > 0) {
          done += Math.max(0, Math.min(0.9, st.loaded / st.total * 0.9));
        } else {
          done += 0.1;
        }
      }
    }

    if (totalWeight <= 0) return null;
    const pct = Math.round((done / totalWeight) * 100);
    return Math.max(0, Math.min(99, pct));
  }, [stemOrder.join("|"), stemLoad]);

  // Apply gains
  useEffect(() => {
    const master = Math.max(0, Math.min(1, masterVolume / 100));
    if (masterGainRef.current) masterGainRef.current.gain.value = master;

    // reset buses to unity
    if (instGainRef.current) instGainRef.current.gain.value = 1;
    if (vocalsBusGainRef.current) vocalsBusGainRef.current.gain.value = 1;
    if (focusBusGainRef.current) focusBusGainRef.current.gain.value = 1;
    if (otherBusGainRef.current) otherBusGainRef.current.gain.value = 1;

    if (mixMode.kind === "master") {
      // Instrumental bus gain is fixed at unity (instrumental slider removed).
      if (instGainRef.current) instGainRef.current.gain.value = 1.0;

      for (const stem of stemOrder) {
        const g = stemGainsRef.current[stem];
        if (!g) continue;
        const sv = Math.max(0, Math.min(1, Number(stemVolumes[stem] ?? 100) / 100));
        g.gain.value = sv;
      }
      return;
    }

    // non-master modes: use simple buses; keep per-stem at unity
    for (const stem of stemOrder) {
      const g = stemGainsRef.current[stem];
      if (g) g.gain.value = 1.0;
    }

    if (mixMode.kind === "vocal") {
      if (focusBusGainRef.current) focusBusGainRef.current.gain.value = Math.max(0, Math.min(1, vocalsVol / 100));
      if (otherBusGainRef.current) otherBusGainRef.current.gain.value = Math.max(0, Math.min(1, instrumentsVol / 100));
      return;
    }

    if (mixMode.kind === "instrument") {
      if (focusBusGainRef.current) focusBusGainRef.current.gain.value = Math.max(0, Math.min(1, focusVol / 100));
      if (otherBusGainRef.current) otherBusGainRef.current.gain.value = Math.max(0, Math.min(1, otherInstVol / 100));
      if (vocalsBusGainRef.current) vocalsBusGainRef.current.gain.value = Math.max(0, Math.min(1, vocalsVol / 100));
      return;
    }
  }, [masterVolume, stemVolumes, stemOrder, mixMode, focusVol, otherInstVol, vocalsVol, instrumentsVol]);

  // Keep video muted always
  useEffect(() => {
    try {
      if (videoRef.current) {
        videoRef.current.muted = true;
        videoRef.current.volume = 0;
      }
    } catch {}
  }, [videoUrl, status, isPlaying]);

  // Keyboard shortcuts
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const tag = (target?.tagName || "").toLowerCase();
      if (tag === "input" || tag === "textarea" || (target as any)?.isContentEditable) return;

      if (e.code === "Space") {
        e.preventDefault();
        togglePlay();
      } else if (e.code === "ArrowLeft") {
        e.preventDefault();
        jumpSeconds(-5);
      } else if (e.code === "ArrowRight") {
        e.preventDefault();
        jumpSeconds(5);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPlaying, canPlay, videoUrl, audioDuration]);

  // Video -> Audio seeking / pausing (if user uses video controls)
  useEffect(() => {
    const p = videoRef.current;
    if (!p) return;

    const onSeeked = () => {
      // Ignore seeked events caused by our own programmatic nudges.
      if (Date.now() - videoProgrammaticSeekAtRef.current < 500) return;
      // If the user scrubs the video, treat that as the seek source-of-truth.
      seekTo(Number(p.currentTime || 0));
    };

    const onPause = () => {
      if (isPlayingRef.current) pauseAudio();
    };

    const onPlay = () => {
      if (!isPlayingRef.current && audioReady) playAudio();
    };

    p.addEventListener("seeked", onSeeked);
    p.addEventListener("pause", onPause);
    p.addEventListener("play", onPlay);

    return () => {
      p.removeEventListener("seeked", onSeeked);
      p.removeEventListener("pause", onPause);
      p.removeEventListener("play", onPlay);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoUrl, isPlaying, audioReady, audioDuration]);

  // Audio -> Video follow (audio is master clock)
  // We avoid constant hard seeking, but we *do*:
  // - nudge playbackRate slightly to correct drift
  // - occasionally snap if drift grows too large
  useEffect(() => {
    const p = videoRef.current;
    if (!p) return;

    // Reset rate when not playing
    if (!isPlaying) {
      try {
        p.playbackRate = 1.0;
      } catch {}
      return;
    }

    const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

    const t = setInterval(() => {
      try {
        if (!isPlayingRef.current) return;
        if ((p.readyState || 0) < 2) return;

        // Keep video playing (muted)
        if (p.paused) {
          p.play().catch(() => {});
        }

        const a = currentPosition();
        const v = Number(p.currentTime || 0);
        const drift = v - a; // + => video ahead, - => video behind

        // If drift is large, do a rare snap
        if (Math.abs(drift) > 0.35) {
          try {
            videoProgrammaticSeekAtRef.current = Date.now();
            p.currentTime = a;
            p.playbackRate = 1.0;
          } catch {}
          return;
        }

        // Small drift: correct via playbackRate
        // If video is behind (drift negative), speed up a bit.
        // If video is ahead, slow down a bit.
        const rate = clamp(1.0 - drift * 0.75, 0.94, 1.06);
        try {
          p.playbackRate = rate;
        } catch {}
      } catch {}
    }, 250);

    return () => {
      clearInterval(t);
      try {
        p.playbackRate = 1.0;
      } catch {}
    };
  }, [isPlaying, videoUrl, audioDuration]);

  const resetPlayer = () => {
    pauseAudio();
    offsetRef.current = 0;
    setAudioReady(false);
    setAudioDuration(0);
    buffersRef.current = {};
    setStemLoad({});

    // Cancel in-flight fetches
    try {
      loadAbortRef.current?.abort();
    } catch {}
    loadAbortRef.current = null;
  };

  // Cleanup: stop audio if user navigates away from this page.
  useEffect(() => {
    return () => {
      // best-effort (can't await in cleanup)
      unloadAudio();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Load & decode stems when job completes (or preset loads)
  useEffect(() => {
    if (!cacheKey) return;
    if (!stemOrder.length) return;

    const load = async () => {
      resetPlayer();

      // 트랜스포즈 재적용에 의한 리로드면 이전 위치 복원 (새 곡 로드와 구분)
      const resume = transposeResumeRef.current;
      if (resume && isFinite(resume.pos) && resume.pos > 0) offsetRef.current = resume.pos;

      const cached = decodedStemCache.get(cacheKey);
      if (cached) {
        buffersRef.current = cached;
        let dur = 0;
        for (const b of Object.values(cached)) dur = Math.max(dur, b.duration || 0);
        setAudioDuration(dur);
        setAudioReady(true);
        setStemLoad(() => {
          const m: Record<string, StemLoadState> = {};
          for (const stem of stemOrder) {
            const b = cached[stem];
            if (b) m[stem] = { status: "ready", duration: b.duration || 0 };
            else m[stem] = { status: "error", error: "missing buffer" };
          }
          return m;
        });
        if (resume?.wasPlaying) {
          transposeResumeRef.current = null;
          void playAudio();
        }
        return;
      }

      const ac = getAudioCtx();
      const abort = new AbortController();
      loadAbortRef.current = abort;

      const out: Record<string, AudioBuffer> = {};
      let dur = 0;

      for (const stem of stemOrder) {
        const stemUrl = stems[stem];
        if (!stemUrl) continue;

        setStemLoad((prev) => ({ ...prev, [stem]: { status: "loading", loaded: 0 } }));

        try {
          const ab = await fetchArrayBufferWithProgress(
            stemUrl,
            (loaded, total) => {
              setStemLoad((prev) => ({
                ...prev,
                [stem]: { status: "loading", loaded, total },
              }));
            },
            abort.signal
          );

          setStemLoad((prev) => ({ ...prev, [stem]: { status: "decoding" } }));

          const buf = await ac.decodeAudioData(ab.slice(0));
          out[stem] = buf;
          dur = Math.max(dur, buf.duration || 0);
          setStemLoad((prev) => ({ ...prev, [stem]: { status: "ready", duration: buf.duration || 0 } }));
        } catch (e: any) {
          const msg = String(e?.message || e);
          setStemLoad((prev) => ({ ...prev, [stem]: { status: "error", error: msg } }));
        }
      }

      buffersRef.current = out;
      decodedStemCache.set(cacheKey, out);
      setAudioDuration(dur);

      const loadedCount = Object.keys(out).length;
      setAudioReady(loadedCount > 0);

      // 트랜스포즈에 의한 리로드였으면 저장 위치에서 재개
      if (resume) {
        transposeResumeRef.current = null;
        if (resume.wasPlaying && loadedCount > 0) void playAudio();
      } else if (loadedCount === stemOrder.length) {
        toast("Audio decoded — ready");
      } else if (loadedCount > 0) {
        toast("Some stems failed to load (playing what we have)");
      } else {
        toast("No stems could be decoded");
      }
    };

    load();

    return () => {
      try {
        loadAbortRef.current?.abort();
      } catch {}
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cacheKey, stemOrder.join("|"), JSON.stringify(stems)]);

  // refreshJobs removed


  // Jobs polling removed

  // If navigated from /library, auto-load url from query string.
  useEffect(() => {
    if (handledQueryRef.current) return;
    if (typeof window === "undefined") return;
    const sp = new URLSearchParams(window.location.search);
    const qUrl = sp.get("url") || "";
    if (!qUrl) return;
    handledQueryRef.current = true;
    const qBpm = sp.get("bpm") || "";
    if (qBpm) setBpm(qBpm);
    loadFromUrl(qUrl);
  }, []);

  const loadFromUrl = async (inputUrl: string) => {
    const id = extractYouTubeId(inputUrl);
    if (!/^[A-Za-z0-9_-]{11}$/.test(id)) {
      toast("Invalid YouTube URL");
      return;
    }

    // Reset transpose per requirement (library stores defaults)
    setSemitones(0);
    setSemitonesPending(0);
    setKeyAdj(0); // 표시 키 조절도 리셋 — 같은 영상을 다시 불러와도 오리지널 키

    // Load saved meta (bpm/key) from Library if present — 새 곡 로드 시 이전 곡 값은 먼저 리셋
    setBpm("");
    setBpmDetectedAt(null);
    setBpmStartOffset(0);
    setKeyTonic("C");
    setKeyMode("major");
    try {
      const rr = await fetch(`${BACKEND}/presets/${encodeURIComponent(id)}`);
      const jj = await rr.json();
      if (rr.ok && jj?.item) {
        if (jj.item.bpm != null) setBpm(String(jj.item.bpm));
        if (jj.item.key_tonic) setKeyTonic(String(jj.item.key_tonic));
        if (jj.item.key_mode) setKeyMode(String(jj.item.key_mode) === "minor" ? "minor" : "major");
      }
    } catch {}

    setUrl(inputUrl);
    setVideoId(id);
    setStems({});
    setStemOrder([]);
    setStemVolumes({});
    setVideoUrl("");
    setNowTitle("");
    setNowThumb("");
    setTaskId("");
    // bpm/key는 위에서 프리셋 메타 복원 전에 리셋됨 (이전 곡 값 잔존 방지)

    resetPlayer();

    setProgress(0);
    setStage("queued");
    setStatus("processing");

    const canonical = `https://www.youtube.com/watch?v=${id}`;

    // oEmbed early
    try {
      const oe = await fetch(`https://www.youtube.com/oembed?url=${encodeURIComponent(canonical)}&format=json`);
      if (oe.ok) {
        const j = await oe.json();
        setNowTitle(j.title || "");
        setNowThumb(j.thumbnail_url || "");
      }
    } catch {}

    const resp = await fetch(`${BACKEND}/process?url=${encodeURIComponent(canonical)}&queued=true`, { method: "POST" });
    const jj = await resp.json();
    const tid = String(jj.task_id || "");
    setTaskId(tid);

    const applyCompletedStatus = async (sj: any) => {
      setStatus("completed");
      setStage("completed");
      setProgress(100);

      const stemsRel = (sj.stems || {}) as Record<string, string>;
      const full: StemsMap = {};
      for (const [k, v] of Object.entries(stemsRel)) {
        full[k] = `${BACKEND}${v}`;
      }

      // If transposed, swap stems to transposed variants.
      if (semitones !== 0 && tid) {
        try {
          const tr = await fetch(`${BACKEND}/transpose/${tid}?semitones=${semitones}`, { method: "POST" });
          const tj = await tr.json();
          if (tr.ok && tj?.stems) {
            for (const [k, v] of Object.entries(tj.stems as Record<string, string>)) {
              full[k] = `${BACKEND}${v}`;
            }
          }
        } catch {}
      }

      const names = Object.keys(full);
      names.sort((a, b) => {
        if (a === "vocals") return -1;
        if (b === "vocals") return 1;
        return a.localeCompare(b);
      });

      setStems(full);
      setStemOrder(names);

      setStemVolumes((prev) => {
        const out = { ...prev };
        for (const nm of names) if (out[nm] == null) out[nm] = 100;
        return out;
      });

      setVideoUrl(sj.video ? `${BACKEND}${sj.video}` : "");

      // Auto-save to Library (preset) using title/thumbnail when available.
      try {
        await fetch(`${BACKEND}/presets`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            id,
            name: nowTitle || id,
            source_url: canonical,
            video_id: id,
            title: nowTitle || null,
            thumbnail_url: nowThumb || null,
            // Do NOT overwrite saved BPM/Key on autosave; those are set via Detect/manual edits.
            bpm: null,
            key_tonic: null,
            key_mode: null,
            semitones: 0,
            master_volume: masterVolume / 100,
            vocal_volume: 1.0,
          }),
        });
      } catch {}

      // If user is still on the select screen, default to Master mode after first load.
      setMixMode((m) => (m.kind === "select" ? { kind: "master" } : m));
      toast("Stems ready — decoding audio…");

      // 저장된 가사 있으면 자동 로드 (자동 가져오기는 하지 않음 — 버튼으로)
      fetch(`${BACKEND}/lyrics/${id}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((j) => {
          if (j && j.lines?.length) {
            setLyrics({ lines: j.lines, offsetMs: j.offset_ms || 0, lrc: j.lrc, source: "saved" });
          } else {
            setLyrics(null);
          }
        })
        .catch(() => {});

      // 저장된 코드 있으면 자동 로드
      fetch(`${BACKEND}/chords/${id}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((j) => {
          if (j && j.lines?.length) {
            setChords({ lines: j.lines, offsetMs: j.offset_ms || 0, lrc: j.lrc, source: "saved" });
          } else {
            setChords(null);
          }
        })
        .catch(() => {});
    };

    // If backend already has cached output, it may return completed immediately.
    if (jj.status === "completed") {
      try {
        const sr = await fetch(`${BACKEND}/status/${tid}`);
        const sj = await sr.json();
        if (sj.status === "completed") {
          await applyCompletedStatus(sj);
          return;
        }
      } catch {}
    }

    const poll = setInterval(async () => {
      try {
        const sr = await fetch(`${BACKEND}/status/${tid}`);
        const sj = await sr.json();
        if (sj.stage) setStage(String(sj.stage));
        if (typeof sj.progress === "number") setProgress(sj.progress);

        if (sj.status === "completed") {
          clearInterval(poll);
          await applyCompletedStatus(sj);
        }

        if (sj.status === "error") {
          clearInterval(poll);
          setStatus("idle");
          toast("Job failed");
        }
      } catch {
        // ignore
      }
    }, 1000);
  };

  const saveMetaToLibrary = async (patch: any) => {
    if (!videoId) return;
    try {
      await fetch(`${BACKEND}/presets/${encodeURIComponent(videoId)}/meta`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: nowTitle || null,
          thumbnail_url: nowThumb || null,
          // IMPORTANT: store default/original key regardless of transpose.
          ...patch,
        }),
      });
    } catch {
      // ignore
    }
  };

  const detectBpm = async () => {
    if (!taskId) return;
    setBpmDetecting(true);
    try {
      const resp = await fetch(`${BACKEND}/bpm/${taskId}/detect`, { method: "POST" });
      const j = await resp.json();
      if (!resp.ok) throw new Error(j?.detail || "detect failed");
      setBpm(String(j.bpm ?? ""));
      setBpmDetectedAt(Date.now());
      setBpmStartOffset(Number(j.start_offset ?? 0) || 0);
      await saveMetaToLibrary({ bpm: j.bpm ?? null });
      toast(`BPM detected (${j.source || "?"}): ${j.bpm}${j.start_offset ? ` (start ${Number(j.start_offset).toFixed(2)}s)` : ""}`);
    } catch (e: any) {
      toast(`BPM detect failed: ${String(e?.message || e)}`);
    } finally {
      setBpmDetecting(false);
    }
  };

  const detectKey = async () => {
    if (!taskId) return;
    setKeyDetecting(true);
    try {
      const resp = await fetch(`${BACKEND}/key/${taskId}/detect`, { method: "POST" });
      const j = await resp.json();
      if (!resp.ok) throw new Error(j?.detail || "detect failed");
      const t = j.tonic ? String(j.tonic) : "";
      const m = j.mode === "minor" ? "minor" : "major";
      if (t) setKeyTonic(t);
      setKeyMode(m);
      await saveMetaToLibrary({ key_tonic: t || null, key_mode: m });
      toast(`Key detected (${j.source || "?"}): ${t}${m === "minor" ? "m" : "M"}`);
    } catch (e: any) {
      toast(`Key detect failed: ${String(e?.message || e)}`);
    } finally {
      setKeyDetecting(false);
    }
  };

  const exportMp3 = async () => {
    if (!taskId) return;
    try {
      const resp = await fetch(`${BACKEND}/export/${taskId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: mixMode,
          masterVolume,
          // instrumentalMaster removed
          stemVolumes,
          focusVol,
          otherInstVol,
          vocalsVol,
          instrumentsVol,
        }),
      });
      const j = await resp.json();
      if (!resp.ok) throw new Error(j?.detail || "export failed");

      const url = `${BACKEND}${j.mp3}`;
      const fname = `mix_${videoId || taskId}.mp3`;

      // If running inside Electron (mac app), use native Save As dialog.
      // @ts-ignore
      const holy = (globalThis as any).holy;
      if (holy?.saveFile) {
        await holy.saveFile(url, fname);
        toast("Exported MP3");
      } else {
        const a = document.createElement("a");
        a.href = url;
        a.download = fname;
        document.body.appendChild(a);
        a.click();
        a.remove();
        toast("Exported MP3 (check Downloads)");
      }
    } catch (e: any) {
      toast(`Export failed: ${String(e?.message || e)}`);
    }
  };

  // ---------- Export Video (영상 + 믹스 오디오 + 코드/가사 자막 번인) ----------
  const [videoExportPct, setVideoExportPct] = useState<number | null>(null); // null = idle

  const exportVideo = async () => {
    if (!taskId || videoExportPct != null) return;
    try {
      const resp = await fetch(`${BACKEND}/export/video/${taskId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: mixMode,
          masterVolume,
          stemVolumes,
          focusVol,
          otherInstVol,
          vocalsVol,
          instrumentsVol,
          semitones,
          key_adj: keyAdj,
        }),
      });
      const j = await resp.json();
      if (!resp.ok) throw new Error(j?.detail || "export failed");

      setVideoExportPct(0);
      for (;;) {
        await new Promise((r) => setTimeout(r, 700));
        const sr = await fetch(`${BACKEND}/export/video/${taskId}/status`);
        const sj = await sr.json();
        if (!sr.ok) throw new Error(sj?.detail || "status failed");
        if (sj.stage === "error") throw new Error(sj.error || "export failed");
        if (sj.stage === "cancelled") {
          toast("Export video 취소됨");
          return;
        }
        setVideoExportPct(Math.max(1, Number(sj.pct) || 0));
        if (sj.stage === "done") {
          const url = `${BACKEND}${sj.out}`;
          const fname = `video_${videoId || taskId}.mp4`;
          // @ts-ignore
          const holy = (globalThis as any).holy;
          if (holy?.saveFile) {
            await holy.saveFile(url, fname);
          } else {
            const a = document.createElement("a");
            a.href = url;
            a.download = fname;
            document.body.appendChild(a);
            a.click();
            a.remove();
          }
          toast("Exported video (check Downloads)");
          return;
        }
      }
    } catch (e: any) {
      toast(`Export video failed: ${String(e?.message || e)}`);
    } finally {
      setVideoExportPct(null);
    }
  };

  // 인코딩 중 취소 — ffmpeg 종료 + 부분 파일 삭제
  const cancelVideoExport = async () => {
    if (!taskId || videoExportPct == null) return;
    try {
      await fetch(`${BACKEND}/export/video/${taskId}/cancel`, { method: "POST" });
    } catch {}
  };

  // ---------- Fullscreen mode (영상 영역 전체화면 + 코드/가사 오버레이) ----------
  const [fsMode, setFsMode] = useState(false);

  const enterFs = async () => {
    const el = videoWrapRef.current;
    if (!el) return;
    try {
      if (el.requestFullscreen) {
        await el.requestFullscreen();
      } else if ((el as any).webkitRequestFullscreen) {
        await (el as any).webkitRequestFullscreen();
      }
    } catch {}
    setFsMode(true);
  };

  const exitFs = async () => {
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
      } else if ((document as any).webkitFullscreenElement && (document as any).webkitExitFullscreen) {
        await (document as any).webkitExitFullscreen();
      }
    } catch {}
    setFsMode(false);
  };

  // Esc/전체화면 해제 감지 (사용자가 Esc로 나가면 상태 동기화)
  useEffect(() => {
    const onChange = () => {
      const active = !!document.fullscreenElement || !!(document as any).webkitFullscreenElement;
      setFsMode(active);
    };
    document.addEventListener("fullscreenchange", onChange);
    document.addEventListener("webkitfullscreenchange", onChange);
    return () => {
      document.removeEventListener("fullscreenchange", onChange);
      document.removeEventListener("webkitfullscreenchange", onChange);
    };
  }, []);

  // ---------- Queue 인디케이터 (메인 화면용 — 백그라운드 폴링, 재생과 독립) ----------
  // 전체 큐 진행률: (완료곡수 + 실행중곡 진행%) / 전체 대상곡수
  const [queueActive, setQueueActive] = useState<{ count: number; label: string; pct: number }>({ count: 0, label: "", pct: 0 });
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const r = await fetch(`${BACKEND}/queue`);
        if (!r.ok || !alive) return;
        const j = await r.json();
        const items = (j.items || []) as Array<{ status: string; name: string | null; video_id: string; progress: number }>;
        const active = items.filter((q) => !["completed", "error"].includes(q.status));
        const running = active.find((q) => q.status !== "queued");
        // 전체 진행률 = (완료된 곡 수 + 현재 곡 진행률) / (전체 활성 곡 수)
        const total = active.length;
        const allItems = items as Array<{ status: string; progress: number }>;
        const doneTotal = allItems.filter((q) => q.status === "completed").length;
        const currentProg = running ? (running.progress || 0) / 100 : 0;
        const denom = total + doneTotal;
        const pct = denom > 0 ? Math.round(((doneTotal + currentProg) / denom) * 100) : 0;
        setQueueActive({
          count: total,
          pct,
          label: running
            ? `${running.name || running.video_id} ${running.status === "separating" ? "분리" : "다운로드"} ${running.progress}%${total > 1 ? ` +${total - 1}` : ""}`
            : total > 0
            ? `대기 ${total}곡`
            : "",
        });
      } catch {}
    };
    tick();
    const iv = setInterval(tick, 3000);
    return () => {
      alive = false;
      clearInterval(iv);
    };
  }, []);

  return (
    <main className="relative flex flex-col h-screen bg-black text-white overflow-hidden">
      <div className="p-4 border-b border-zinc-800 bg-zinc-950">
        <div className="flex gap-2 items-center relative">
          {/* Support 버튼 — 로고 왼쪽 */}
          <SupportButton />
          {/* 브랜드 헤더 — 상단 중앙 */}
          <div className="absolute left-1/2 -translate-x-1/2">
            <BrandHeader />
          </div>
          {/* URL 로드는 라이브러리 메뉴에서 큐로 이동 — 재생 컨트롤만 상단에 */}

          {/* 큐 인디케이터 — 백그라운드 작업 중일 때만 표시, 하단 프로그레스 바가 전체 진행률을 채움 */}
          {queueActive.count > 0 ? (
            <button
              onClick={async () => {
                await unloadAudio();
                router.push("/library");
              }}
              className="relative flex items-center gap-2 px-3 py-2 rounded-lg border border-blue-800/60 bg-blue-950/30 text-blue-200 text-xs overflow-hidden"
              title={`전체 진행률 ${queueActive.pct}% — 클릭해서 라이브러리 열기`}
            >
              {/* 배경 프로그레스 채움 */}
              <span
                className="absolute inset-y-0 left-0 bg-blue-600/25 transition-all duration-700 ease-out"
                style={{ width: `${queueActive.pct}%` }}
              />
              <span className="relative flex h-2 w-2 shrink-0">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75"></span>
                <span className="relative inline-flex rounded-full h-2 w-2 bg-blue-500"></span>
              </span>
              <span className="relative truncate max-w-[220px]">{queueActive.label}</span>
              <span className="relative tabular-nums text-blue-300/80">{queueActive.pct}%</span>
            </button>
          ) : null}

          <button
            onClick={async () => {
              await unloadAudio();
              router.push("/library");
            }}
            className="px-3 py-2 rounded-lg border border-zinc-700 text-sm"
          >
            Library
          </button>

          <div className="flex-1" />

          <button
            onClick={exportMp3}
            disabled={status !== "completed"}
            className={`px-3 py-2 rounded-lg border text-sm ${status === "completed" ? "border-zinc-700 hover:bg-zinc-900" : "border-zinc-800 text-zinc-600 cursor-not-allowed"}`}
          >
            Export MP3
          </button>
          <button
            onClick={exportVideo}
            disabled={status !== "completed" || !videoUrl || videoExportPct != null}
            className={`px-3 py-2 rounded-lg border text-sm ${status === "completed" && videoUrl && videoExportPct == null ? "border-zinc-700 hover:bg-zinc-900" : "border-zinc-800 text-zinc-600 cursor-not-allowed"}`}
            title="영상 + 믹스 오디오 + 코드/가사 자막 번인 mp4"
          >
            {videoExportPct != null ? `Encoding ${videoExportPct}%` : "Export Video"}
          </button>
          {videoExportPct != null ? (
            <button
              onClick={cancelVideoExport}
              className="px-2.5 py-2 rounded-lg border border-red-900/60 text-red-300 hover:bg-red-950/30 text-sm"
              title="Export Video 취소"
            >
              ✕
            </button>
          ) : null}
        </div>
      </div>

      {/* Chords strip — 영상 위 별도 영역 (코드 3줄: 이전/현재/다음, 현재줄은 시간에 맞춰 개별 코드 하이라이트) */}
      {chords && chordsShow ? (
        <div
          className="flex-none relative flex items-center justify-center px-6 bg-black border-b border-zinc-900 overflow-hidden"
          style={{ height: chordsBandH }}
        >
          {/* 표시 코드 키 조절 — 영역 상단 우측 (▼ -1 / 숫자+Capo / ▲ +1, -11..+11) */}
          <div className="absolute top-1.5 right-2 z-10 flex items-stretch gap-1 select-none">
            <button
              onClick={() => setKeyAdj((v) => Math.max(-11, v - 1))}
              disabled={keyAdj <= -11}
              className={`w-7 flex items-center justify-center rounded-md border ${keyAdj > -11 ? "border-zinc-700 text-zinc-300 hover:bg-zinc-900" : "border-zinc-800 text-zinc-600 cursor-not-allowed"}`}
              title="표시 코드 -1 key"
            >
              <ChevronDown size={15} />
            </button>
            <button
              onClick={() => setKeyAdj(0)}
              className="min-w-[56px] px-1.5 py-0.5 rounded-md border border-zinc-800 hover:bg-zinc-900 flex flex-col items-center justify-center leading-none"
              title="클릭하면 표시 키 리셋 (0 / Capo 0)"
            >
              <span className="text-[11px] font-mono text-zinc-200">{keyAdjLabel}</span>
              <span className="text-[9px] text-zinc-500 mt-0.5">Capo {capoValue}</span>
            </button>
            <button
              onClick={() => setKeyAdj((v) => Math.min(11, v + 1))}
              disabled={keyAdj >= 11}
              className={`w-7 flex items-center justify-center rounded-md border ${keyAdj < 11 ? "border-zinc-700 text-zinc-300 hover:bg-zinc-900" : "border-zinc-800 text-zinc-600 cursor-not-allowed"}`}
              title="표시 코드 +1 key"
            >
              <ChevronUp size={15} />
            </button>
          </div>
          {chordActiveIdx >= 0 ? (
            <div className="max-w-[95%] space-y-1 text-center">
              {chordActiveIdx > 0 ? (
                <div className="text-sm sm:text-base text-zinc-500 truncate">
                  {chords.lines[chordActiveIdx - 1].chords.map((c, ci) => (
                    <span key={ci}>{transposeChordText(c.text, semitones + keyAdj)}{"  "}</span>
                  ))}
                </div>
              ) : null}
              <div className="flex flex-wrap justify-center items-baseline gap-x-6 gap-y-0.5 text-xl sm:text-3xl font-bold break-keep">
                {chords.lines[chordActiveIdx].chords.map((c, ci) => (
                  <span
                    key={`${ci}-${c.time}`}
                    className={
                      ci === chordInLineIdx
                        ? "text-white border-b-2 border-emerald-400"
                        : ci < chordInLineIdx
                          ? "text-zinc-200/90"
                          : "text-zinc-500/80"
                    }
                  >
                    {transposeChordText(c.text, semitones + keyAdj)}
                  </span>
                ))}
              </div>
              {chordActiveIdx + 1 < chords.lines.length ? (
                <div className="text-sm sm:text-base text-zinc-500 truncate">
                  {chords.lines[chordActiveIdx + 1].chords.map((c, ci) => (
                    <span key={ci}>{transposeChordText(c.text, semitones + keyAdj)}{"  "}</span>
                  ))}
                </div>
              ) : null}
            </div>
          ) : (
            <div className="text-zinc-700 text-lg">♪</div>
          )}
        </div>
      ) : null}

      {/* Video / status area (높이: 위/아래 핸들 드래그로 조절 가능) */}
      <div
        ref={videoWrapRef}
        className={`relative ${videoH == null ? "flex-1" : ""} ${fsMode ? "bg-black" : ""}`}
        style={videoH != null ? { height: videoH, flex: "0 0 auto" } : undefined}
      >
        {videoUrl ? (
          <div className="absolute inset-0 bg-black">
            <video ref={videoRef} src={videoUrl} className="absolute inset-0 w-full h-full object-contain bg-black" playsInline muted />
            {!fsMode ? (
              <div className="absolute top-3 left-3 max-w-[75%] rounded-xl border border-zinc-800 bg-black/60 backdrop-blur px-3 py-2 text-white text-sm sm:text-base font-semibold shadow">
                {nowTitle || videoId}
              </div>
            ) : null}
          </div>
        ) : videoId ? (
          <div className="h-full w-full flex items-center justify-center bg-black">
            <div className="text-center space-y-3 max-w-md px-6">
              {nowThumb ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={nowThumb} alt="thumb" className="mx-auto w-64 rounded-xl border border-zinc-800" />
              ) : null}
              <div className="text-sm text-zinc-200">{nowTitle || "Preparing…"}</div>
              {/* Saved name moved below transport */}
              <div className="text-[12px] text-zinc-500">{status === "completed" ? "Video not available (audio ready)." : "Working…"}</div>
              {status === "processing" ? (
                <div className="rounded-xl border border-zinc-800 bg-zinc-950/40 px-4 py-3">
                  <div className="text-[11px] text-zinc-400">
                    {stage} • {progress}%
                  </div>
                  <div className="h-2 bg-zinc-800/70 rounded-full overflow-hidden mt-2">
                    <div className="h-full bg-blue-500/70" style={{ width: `${Math.max(0, Math.min(100, progress))}%` }} />
                  </div>
                </div>
              ) : null}
            </div>
          </div>
        ) : (
          <div className="h-full flex items-center justify-center text-zinc-600 text-sm">Library에서 곡을 선택하세요</div>
        )}

        {toastMsg ? (
          <div className="absolute left-1/2 -translate-x-1/2 top-4 rounded-full border border-zinc-800 bg-zinc-950/70 backdrop-blur px-4 py-2 shadow text-xs text-zinc-200">
            {toastMsg}
          </div>
        ) : null}

        {/* Fullscreen 오버레이 — 상단 1/3에 코드(위)+가사(아래) 나란히 표시 */}
        {fsMode ? (
          <div className="absolute inset-x-0 top-0 z-20 pointer-events-none">
            <div className="h-[33vh] flex flex-col items-center justify-center gap-2 bg-gradient-to-b from-black/70 via-black/40 to-transparent px-8 pt-4">
              {/* 코드 (위) — 현재줄 + 다음줄 미리보기 (일반 스트립과 동일 구조) */}
              {chords && chordsShow && chordActiveIdx >= 0 ? (
                <div className="text-center space-y-1">
                  {chordActiveIdx > 0 ? (
                    <div className="text-lg lg:text-xl text-zinc-500 truncate">
                      {chords.lines[chordActiveIdx - 1].chords.map((c, ci) => (
                        <span key={ci}>{transposeChordText(c.text, semitones + keyAdj)}{"  "}</span>
                      ))}
                    </div>
                  ) : null}
                  <div className="flex flex-wrap justify-center items-baseline gap-x-8 text-4xl lg:text-5xl font-bold break-keep drop-shadow-lg">
                    {chords.lines[chordActiveIdx].chords.map((c, ci) => (
                      <span
                        key={`${ci}-${c.time}`}
                        className={
                          ci === chordInLineIdx
                            ? "text-white border-b-4 border-emerald-400"
                            : ci < chordInLineIdx
                              ? "text-zinc-300/80"
                              : "text-zinc-500/70"
                        }
                      >
                        {transposeChordText(c.text, semitones + keyAdj)}
                      </span>
                    ))}
                  </div>
                  {chordActiveIdx + 1 < chords.lines.length ? (
                    <div className="text-xl lg:text-2xl text-zinc-400 mt-1 truncate">
                      {chords.lines[chordActiveIdx + 1].chords.map((c, ci) => (
                        <span key={ci}>{transposeChordText(c.text, semitones + keyAdj)}{"  "}</span>
                      ))}
                    </div>
                  ) : null}
                </div>
              ) : null}
              {/* 가사 (아래) — 이전/현재/다음 3줄 (일반 스트립과 동일 구조) */}
              {lyrics && lyricsShow && lyricActiveIdx >= 0 ? (
                <div className="text-center space-y-1">
                  {lyricActiveIdx > 0 ? (
                    <div className="text-lg lg:text-xl text-zinc-500 truncate">
                      {lyricLines[lyricActiveIdx - 1].text}
                    </div>
                  ) : null}
                  <div className="text-2xl lg:text-3xl font-bold text-white break-keep drop-shadow-lg">
                    {lyricLines[lyricActiveIdx].text}
                  </div>
                  {lyricActiveIdx + 1 < lyricLines.length ? (
                    <div className="text-lg lg:text-xl text-zinc-400 mt-1 truncate">
                      {lyricLines[lyricActiveIdx + 1].text}
                    </div>
                  ) : null}
                </div>
              ) : (!chords || !chordsShow) && (!lyrics || !lyricsShow) ? (
                <div className="text-zinc-600 text-lg">♪</div>
              ) : null}
            </div>
          </div>
        ) : null}

        {/* Fullscreen 토글 버튼 — 영상 영역 우측 하단 */}
        {videoUrl || videoId ? (
          <button
            onClick={() => (fsMode ? exitFs() : enterFs())}
            className="absolute bottom-3 right-3 z-30 p-2 rounded-lg border border-zinc-700 bg-black/60 backdrop-blur text-zinc-300 hover:text-white hover:bg-black/80 transition-colors"
            title={fsMode ? "전체화면 종료 (Esc)" : "전체화면 — 코드·가사 오버레이"}
          >
            {fsMode ? <Minimize size={18} /> : <Maximize size={18} />}
          </button>
        ) : null}

        {/* 위/아래 리사이즈 핸들 — 영상 영역 높이 조절 (더블클릭: 자동 높이 복귀) */}
        <div
          className="absolute top-0 left-0 right-0 h-2 -translate-y-1/2 z-30 cursor-row-resize touch-none group"
          onPointerDown={onVideoResizeDown("top")}
          onPointerMove={onVideoResizeMove}
          onPointerUp={onVideoResizeUp}
          onPointerCancel={onVideoResizeUp}
          onDoubleClick={() => { setVideoH(null); persistVideoH(null); }}
        >
          <div className={`h-0.5 w-full transition-colors ${videoResizing ? "bg-blue-500" : "bg-transparent group-hover:bg-blue-500/60"}`} />
        </div>
        <div
          className="absolute bottom-0 left-0 right-0 h-2 translate-y-1/2 z-30 cursor-row-resize touch-none group"
          onPointerDown={onVideoResizeDown("bottom")}
          onPointerMove={onVideoResizeMove}
          onPointerUp={onVideoResizeUp}
          onPointerCancel={onVideoResizeUp}
          onDoubleClick={() => { setVideoH(null); persistVideoH(null); }}
        >
          <div className={`h-0.5 w-full transition-colors ${videoResizing ? "bg-blue-500" : "bg-transparent group-hover:bg-blue-500/60"}`} />
        </div>
      </div>

      {/* Lyrics strip — 영상과 겹치지 않는 별도 영역 (가사 3줄 분량, 타이트) */}
      {lyrics && lyricsShow ? (
        <div
          className="flex-none flex items-center justify-center px-6 bg-black border-t border-zinc-900 overflow-hidden"
          style={{ height: lyricsBandH }}
        >
          {lyricActiveIdx >= 0 ? (
            <div className="max-w-[85%] space-y-1 text-center">
              {lyricActiveIdx > 0 ? (
                <div className="text-sm sm:text-base text-zinc-500 truncate">{lyricLines[lyricActiveIdx - 1].text}</div>
              ) : null}
              <div className="text-xl sm:text-3xl font-bold text-white break-keep">
                {lyricLines[lyricActiveIdx].text}
              </div>
              {lyricActiveIdx + 1 < lyricLines.length ? (
                <div className="text-sm sm:text-base text-zinc-400 truncate">{lyricLines[lyricActiveIdx + 1].text}</div>
              ) : null}
            </div>
          ) : (
            <div className="text-zinc-700 text-lg">♪</div>
          )}
        </div>
      ) : null}

      {/* Controls — 영상을 크게 키우면 남는 공간이 줄어드므로 내부 스크롤 허용 */}
      <div className="p-6 bg-zinc-900/80 border-t border-zinc-800 min-h-0 overflow-y-auto overscroll-contain">
        {/* Start screen: choose instrument */}
        {mixMode.kind === "select" ? (
          <div className="max-w-3xl mx-auto">
            <div className="text-center text-zinc-200 text-lg font-semibold">Choose your instrument</div>
            <div className="mt-4 grid grid-cols-2 sm:grid-cols-3 gap-3">
              <button
                onClick={() => setMixMode({ kind: "vocal" })}
                className="rounded-2xl border border-zinc-800 bg-zinc-950/60 px-4 py-4 text-left hover:bg-zinc-900"
              >
                <div className="text-2xl">🎤</div>
                <div className="mt-2 text-sm text-zinc-200">Vocal</div>
              </button>
              <button
                onClick={() => setMixMode({ kind: "instrument", instrument: "drums" })}
                className="rounded-2xl border border-zinc-800 bg-zinc-950/60 px-4 py-4 text-left hover:bg-zinc-900"
              >
                <div className="text-2xl">🥁</div>
                <div className="mt-2 text-sm text-zinc-200">Drum</div>
              </button>
              <button
                onClick={() => setMixMode({ kind: "instrument", instrument: "bass" })}
                className="rounded-2xl border border-zinc-800 bg-zinc-950/60 px-4 py-4 text-left hover:bg-zinc-900"
              >
                <div className="text-2xl">🎸</div>
                <div className="mt-2 text-sm text-zinc-200">Bass</div>
              </button>
              <button
                onClick={() => setMixMode({ kind: "instrument", instrument: "guitar" })}
                className="rounded-2xl border border-zinc-800 bg-zinc-950/60 px-4 py-4 text-left hover:bg-zinc-900"
              >
                <div className="text-2xl">🎸</div>
                <div className="mt-2 text-sm text-zinc-200">Guitar</div>
              </button>
              <button
                onClick={() => setMixMode({ kind: "instrument", instrument: "piano" })}
                className="rounded-2xl border border-zinc-800 bg-zinc-950/60 px-4 py-4 text-left hover:bg-zinc-900"
              >
                <div className="text-2xl">🎹</div>
                <div className="mt-2 text-sm text-zinc-200">Piano</div>
              </button>
              <button
                onClick={() => setMixMode({ kind: "master" })}
                className="rounded-2xl border border-blue-800 bg-blue-950/30 px-4 py-4 text-left hover:bg-blue-900/30"
              >
                <div className="text-2xl">🎛️</div>
                <div className="mt-2 text-sm text-zinc-100">Master</div>
              </button>
            </div>
            <div className="mt-4 text-center text-[11px] text-zinc-500">
              Load a song first (top). Then pick a mode.
            </div>
          </div>
        ) : null}
        <div className="max-w-3xl mx-auto space-y-4">
          <div className="flex items-center justify-center gap-4">
            <button
              onClick={() => jumpSeconds(-5)}
              disabled={!audioReady}
              className={`px-3 py-2 rounded-lg font-bold border ${audioReady ? "border-zinc-700 hover:bg-zinc-800" : "border-zinc-800 text-zinc-600 cursor-not-allowed"}`}
            >
              −5s
            </button>

            <button
              onClick={togglePlay}
              disabled={!canPlay}
              className={`relative overflow-hidden px-4 py-2 rounded-lg font-bold flex items-center gap-2 border ${canPlay ? "border-zinc-700 hover:bg-zinc-800" : "border-zinc-800 text-zinc-600 cursor-not-allowed"}`}
            >
              {isPlaying ? <Pause size={18} /> : <Play size={18} />}
              <span className="relative z-10">
                {isPlaying ? "Pause" : audioReady ? "Play" : audioLoadPercent != null ? `Loading ${audioLoadPercent}%` : "Loading"}
              </span>
              {!audioReady && audioLoadPercent != null ? (
                <span
                  className="absolute inset-y-0 left-0 bg-blue-600/25"
                  style={{ width: `${Math.max(0, Math.min(100, audioLoadPercent))}%` }}
                />
              ) : null}
              {!audioReady && audioLoadPercent == null ? <span className="absolute inset-0 bg-blue-600/10 animate-pulse" /> : null}
            </button>

            <button
              onClick={() => jumpSeconds(5)}
              disabled={!audioReady}
              className={`px-3 py-2 rounded-lg font-bold border ${audioReady ? "border-zinc-700 hover:bg-zinc-800" : "border-zinc-800 text-zinc-600 cursor-not-allowed"}`}
            >
              +5s
            </button>
          </div>

          {/* Timeline (seek) */}
          <div className="flex items-center gap-3">
            <div className="text-xs font-mono text-zinc-400 w-12 text-right">{fmtTime(isScrubbing ? scrubPos : uiPos)}</div>
            <input
              type="range"
              min={0}
              max={Math.max(0, audioDuration || 0)}
              step={0.01}
              value={Math.max(0, Math.min(audioDuration || 0, isScrubbing ? scrubPos : uiPos))}
              onChange={(e) => {
                const v = Number(e.target.value);
                setIsScrubbing(true);
                setScrubPos(v);
              }}
              onMouseUp={async () => {
                setIsScrubbing(false);
                await seekTo(scrubPos);
              }}
              onTouchEnd={async () => {
                setIsScrubbing(false);
                await seekTo(scrubPos);
              }}
              disabled={!audioReady}
              className={`flex-1 ${audioReady ? "" : "opacity-50"}`}
            />
            <div className="text-xs font-mono text-zinc-400 w-12">{fmtTime(audioDuration || 0)}</div>
          </div>

          <div className="flex items-center justify-center gap-3 flex-wrap">
            {/* Lyrics button + stamp + offset */}
            <div className="flex items-center gap-2">
              <button
                onClick={() => (lyrics ? setLyricsShow((v) => !v) : openLyricsMenu())}
                disabled={status !== "completed"}
                title={lyrics ? "가사 표시 on/off" : "가사 가져오기"}
                className={`px-3 py-2 rounded-lg border text-sm ${status === "completed" ? "border-zinc-700 hover:bg-zinc-900" : "border-zinc-800 text-zinc-600 cursor-not-allowed"} ${lyrics && lyricsShow ? "border-blue-700 text-blue-200" : ""}`}
              >
                {lyrics ? (lyricsShow ? "가사 숨기기" : "가사 보기") : "가사 가져오기"}
              </button>
              {lyrics ? (
                <>
                  <button
                    onClick={async () => {
                      // 최신 lrc를 서버에서 다시 읽어 편집기에 반영 (빈 스탬프 등 최신 상태)
                      try {
                        const r = await fetch(`${BACKEND}/lyrics/${videoId}`);
                        if (r.ok) {
                          const j = await r.json();
                          setLyricsEditText(j.lrc || "");
                        } else {
                          setLyricsEditText(lyrics.lrc || "");
                        }
                      } catch {
                        setLyricsEditText(lyrics.lrc || "");
                      }
                      setLyricsOpen(true);
                      setLyricsMode("edit");
                    }}
                    className="px-2 py-2 rounded-lg border border-zinc-700 text-sm hover:bg-zinc-900"
                    title="LRC 편집"
                  >
                    편집
                  </button>
                  <div className="flex items-center gap-1" title="가사 오프셋 (초)">
                    <button
                      onClick={() => lyricsSaveOffset(lyrics.offsetMs - 250)}
                      className="px-2 py-1 rounded-md border border-zinc-700 text-xs hover:bg-zinc-900"
                    >
                      −0.25s
                    </button>
                    <div className="text-[11px] font-mono text-zinc-400 w-14 text-center">
                      {(lyrics.offsetMs / 1000).toFixed(2)}s
                    </div>
                    <button
                      onClick={() => lyricsSaveOffset(lyrics.offsetMs + 250)}
                      className="px-2 py-1 rounded-md border border-zinc-700 text-xs hover:bg-zinc-900"
                    >
                      +0.25s
                    </button>
                  </div>
                </>
              ) : null}
            </div>

            {/* Chords button + edit */}
            <div className="flex items-center gap-2">
              <button
                onClick={() => (chords ? setChordsShow((v) => !v) : openChordsEditor("create"))}
                disabled={status !== "completed"}
                title={chords ? "코드 표시 on/off" : "코드 만들기"}
                className={`px-3 py-2 rounded-lg border text-sm ${status === "completed" ? "border-zinc-700 hover:bg-zinc-900" : "border-zinc-800 text-zinc-600 cursor-not-allowed"} ${chords && chordsShow ? "border-emerald-700 text-emerald-200" : ""}`}
              >
                {chords ? (chordsShow ? "코드 숨기기" : "코드 보기") : "코드 만들기"}
              </button>
              {chords ? (
                <button
                  onClick={() => openChordsEditor("edit")}
                  className="px-2 py-2 rounded-lg border border-zinc-700 text-sm hover:bg-zinc-900"
                  title="코드 편집"
                >
                  편집
                </button>
              ) : null}
            </div>

            <div className="w-px h-6 bg-zinc-800" />

            <div className="flex items-center gap-2">
              <div className="text-xs text-zinc-400">BPM</div>
              <input
                value={bpm}
                onChange={(e) => setBpm(e.target.value.replace(/[^0-9.]/g, ""))}
                onBlur={() => saveMetaToLibrary({ bpm: bpm ? Number(bpm) : null })}
                placeholder=""
                className="w-20 bg-zinc-900 border border-zinc-700 rounded-lg px-2 py-2 text-sm"
              />
              <button
                onClick={detectBpm}
                disabled={status !== "completed" || bpmDetecting}
                className={`relative overflow-hidden px-3 py-2 rounded-lg border text-sm ${status === "completed" && !bpmDetecting ? "border-zinc-700 hover:bg-zinc-900" : "border-zinc-800 text-zinc-600 cursor-not-allowed"}`}
              >
                <span className="relative z-10">{bpmDetecting ? "Detecting…" : "Detect"}</span>
                {bpmDetecting ? <span className="absolute inset-0 bg-blue-600/10 animate-pulse" /> : null}
              </button>
            </div>

            <div className="flex items-center gap-2">
              <div className="text-xs text-zinc-400">Key</div>
              <select
                value={displayedKeyTonicPending}
                onChange={(e) => {
                  const disp = e.target.value;
                  const base = shiftTonic(disp, -semitonesPending);
                  setKeyTonic(base);
                  saveMetaToLibrary({ key_tonic: base, key_mode: keyMode });
                }}
                className="bg-zinc-900 border border-zinc-700 rounded-lg px-2 py-2 text-sm"
              >
                {NOTE_OPTIONS.map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
              <button
                onClick={() => {
                  setKeyMode("major");
                  saveMetaToLibrary({ key_tonic: keyTonic, key_mode: "major" });
                }}
                className={`px-2 py-2 rounded-lg border text-sm ${keyMode === "major" ? "border-blue-700 text-blue-200" : "border-zinc-700 text-zinc-300"}`}
                title="Major"
              >
                M
              </button>
              <button
                onClick={() => {
                  setKeyMode("minor");
                  saveMetaToLibrary({ key_tonic: keyTonic, key_mode: "minor" });
                }}
                className={`px-2 py-2 rounded-lg border text-sm ${keyMode === "minor" ? "border-blue-700 text-blue-200" : "border-zinc-700 text-zinc-300"}`}
                title="Minor"
              >
                m
              </button>
              <button
                onClick={detectKey}
                disabled={status !== "completed" || keyDetecting}
                className={`relative overflow-hidden px-3 py-2 rounded-lg border text-sm ${status === "completed" && !keyDetecting ? "border-zinc-700 hover:bg-zinc-900" : "border-zinc-800 text-zinc-600 cursor-not-allowed"}`}
              >
                <span className="relative z-10">{keyDetecting ? "Detecting…" : "Detect"}</span>
                {keyDetecting ? <span className="absolute inset-0 bg-blue-600/10 animate-pulse" /> : null}
              </button>

              <div className="w-px h-6 bg-zinc-800 mx-1" />

              <button
                onClick={() => setSemitonesPending((v) => Math.max(-6, v - 1))}
                disabled={semitonesPending <= -6 || transposing}
                className={`px-2 py-2 rounded-lg border text-sm ${semitonesPending > -6 && !transposing ? "border-zinc-700 hover:bg-zinc-900" : "border-zinc-800 text-zinc-600 cursor-not-allowed"}`}
                title="Transpose down"
              >
                −
              </button>
              <div className="text-xs font-mono text-zinc-300 w-12 text-center">
                {semitonesPending >= 0 ? `+${semitonesPending}` : String(semitonesPending)}
              </div>
              <button
                onClick={() => setSemitonesPending((v) => Math.min(6, v + 1))}
                disabled={semitonesPending >= 6 || transposing}
                className={`px-2 py-2 rounded-lg border text-sm ${semitonesPending < 6 && !transposing ? "border-zinc-700 hover:bg-zinc-900" : "border-zinc-800 text-zinc-600 cursor-not-allowed"}`}
                title="Transpose up"
              >
                +
              </button>
              <button
                onClick={() => setSemitonesPending(0)}
                disabled={semitonesPending === 0 || transposing}
                className={`px-2 py-2 rounded-lg border text-[11px] ${semitonesPending !== 0 && !transposing ? "border-zinc-700 hover:bg-zinc-900 text-zinc-200" : "border-zinc-800 text-zinc-600 cursor-not-allowed"}`}
                title="Reset transpose (pending)"
              >
                0
              </button>
              <button
                onClick={() => applyTranspose(semitonesPending)}
                disabled={transposing || semitonesPending === semitones || status !== "completed"}
                className={`relative overflow-hidden px-3 py-2 rounded-lg border text-sm ${!transposing && semitonesPending !== semitones && status === "completed" ? "border-blue-700 text-blue-200 hover:bg-blue-950/30" : "border-zinc-800 text-zinc-600 cursor-not-allowed"}`}
                title="Apply transpose"
              >
                {transposing ? (
                  <span className="relative z-10">Transposing {transposePct}%</span>
                ) : (
                  <span className="relative z-10">Apply</span>
                )}
                {transposing ? (
                  <span
                    className="absolute inset-y-0 left-0 bg-blue-600/30"
                    style={{ width: `${Math.max(0, Math.min(100, transposePct))}%` }}
                  />
                ) : null}
              </button>
            </div>
          </div>

          {/* Saved name removed (title is shown as overlay on video) */}

          <div className="flex items-center gap-4">
            <div className="text-xs text-zinc-400 w-32">Master</div>
            <input type="range" min={0} max={100} value={masterVolume} onChange={(e) => setMasterVolume(Number(e.target.value))} className="flex-1" />
            <div className="text-xs font-mono text-zinc-300 w-12 text-right">{masterVolume}%</div>
          </div>

          {/* Instrumental slider removed */}

          <div className="flex items-center justify-between">
            <div className="text-[11px] text-zinc-500">Stems: {stemOrder.length ? stemOrder.join(", ") : "(none yet)"}</div>
            <div className="flex gap-2">
              <button
                onClick={() => setMixMode({ kind: "select" })}
                className="text-[11px] px-2 py-1 rounded-md border border-zinc-800 text-zinc-300"
              >
                Mode
              </button>
              <button
                onClick={() => setMixMode({ kind: "master" })}
                className={`text-[11px] px-2 py-1 rounded-md border ${mixMode.kind === "master" ? "border-blue-700 text-blue-200" : "border-zinc-800 text-zinc-300"}`}
              >
                Master
              </button>
            </div>
          </div>

          {mixMode.kind === "vocal" ? (
            <>
              <div className="flex flex-nowrap gap-3 overflow-x-auto pb-2">
                <div className="rounded-2xl border border-zinc-800 bg-zinc-950/40 p-2 flex flex-col items-center gap-2 min-w-[120px]">
                  <div className="text-xs text-zinc-300">{stemIcon("vocals")} Vocals</div>
                  <VerticalFader value={vocalsVol} disabled={!audioReady} height={180} onChange={(v) => setVocalsVol(v)} />
                </div>
                <div className="rounded-2xl border border-zinc-800 bg-zinc-950/40 p-2 flex flex-col items-center gap-2 min-w-[120px]">
                  <div className="text-xs text-zinc-300">{stemIcon("instruments")} Instruments</div>
                  <VerticalFader value={instrumentsVol} disabled={!audioReady} height={180} onChange={(v) => setInstrumentsVol(v)} />
                </div>
              </div>
            </>
          ) : null}

          {mixMode.kind === "instrument" ? (
            <>
              <div className="flex flex-nowrap gap-3 overflow-x-auto pb-2">
                <div className="rounded-2xl border border-zinc-800 bg-zinc-950/40 p-2 flex flex-col items-center gap-2 min-w-[120px]">
                  <div className="text-xs text-zinc-300">{stemIcon(mixMode.instrument)} My {mixMode.instrument}</div>
                  <VerticalFader value={focusVol} disabled={!audioReady} height={180} onChange={(v) => setFocusVol(v)} />
                </div>
                <div className="rounded-2xl border border-zinc-800 bg-zinc-950/40 p-2 flex flex-col items-center gap-2 min-w-[120px]">
                  <div className="text-xs text-zinc-300">{stemIcon("other")} Other</div>
                  <VerticalFader value={otherInstVol} disabled={!audioReady} height={180} onChange={(v) => setOtherInstVol(v)} />
                </div>
                <div className="rounded-2xl border border-zinc-800 bg-zinc-950/40 p-2 flex flex-col items-center gap-2 min-w-[120px]">
                  <div className="text-xs text-zinc-300">{stemIcon("vocals")} Vocals</div>
                  <VerticalFader value={vocalsVol} disabled={!audioReady} height={180} onChange={(v) => setVocalsVol(v)} />
                </div>
              </div>
            </>
          ) : null}

          {mixMode.kind === "master" ? (
            <>
              <div className="flex flex-nowrap gap-3 overflow-x-auto pb-2">
                {stemOrder.map((stem) => {
                  const st = stemLoad[stem] || { status: "idle" as const };
                  let sub = "";
                  if (st.status === "loading") {
                    const pct = st.total ? Math.round((st.loaded / Math.max(1, st.total)) * 100) : null;
                    sub = pct != null ? `loading ${pct}%` : `loading ${Math.round(st.loaded / 1024)}KB`;
                  } else if (st.status === "decoding") {
                    sub = "decoding…";
                  } else if (st.status === "ready") {
                    sub = "ready";
                  } else if (st.status === "error") {
                    sub = `error: ${st.error}`;
                  }

                  return (
                    <div key={stem} className="rounded-2xl border border-zinc-800 bg-zinc-950/40 p-2 flex flex-col items-center gap-2 min-w-[120px]">
                      <div className="text-xs text-zinc-300 capitalize">{stemIcon(stem)} {stem}</div>
                      <VerticalFader
                        value={Number(stemVolumes[stem] ?? 100)}
                        disabled={!audioReady}
                        height={180}
                        onChange={(v) => setStemVolumes((prev) => ({ ...prev, [stem]: v }))}
                      />
                      {sub ? <div className="text-[11px] text-zinc-600 text-center">{sub}</div> : <div className="text-[11px] text-zinc-800">&nbsp;</div>}
                    </div>
                  );
                })}
              </div>
            </>
          ) : null}

        </div>
      </div>

      {/* Jobs modal removed */}

      {/* Lyrics modal: menu / lrclib / paste / edit */}
      {lyricsOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" onClick={() => setLyricsOpen(false)}>
          <div
            className="w-full max-w-lg rounded-2xl border border-zinc-800 bg-zinc-950 p-5 space-y-4 max-h-[85vh] overflow-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between">
              <div className="text-lg font-bold text-zinc-100">가사 {lyricsMode === "edit" ? "편집" : "가져오기"}</div>
              <button onClick={() => setLyricsOpen(false)} className="text-zinc-500 hover:text-zinc-200 text-sm px-2">✕</button>
            </div>

            {lyricsMode === "menu" ? (
              <div className="grid grid-cols-1 gap-3">
                <button
                  onClick={() => setLyricsMode("lrclib")}
                  className="rounded-xl border border-zinc-700 bg-zinc-900/60 px-4 py-5 text-left hover:bg-zinc-900"
                >
                  <div className="text-base font-semibold text-zinc-100">1. LRCLIB에서 가져오기</div>
                  <div className="text-xs text-zinc-500 mt-1">lrclib.net — 싱크된 가사 DB에서 자동 검색</div>
                </button>
                <button
                  onClick={() => setLyricsMode("paste")}
                  className="rounded-xl border border-zinc-700 bg-zinc-900/60 px-4 py-5 text-left hover:bg-zinc-900"
                >
                  <div className="text-base font-semibold text-zinc-100">2. 가사 직접 업로드 (LRC)</div>
                  <div className="text-xs text-zinc-500 mt-1">LRCLIB 등에서 복사한 LRC 텍스트를 붙여넣기</div>
                </button>
                <button
                  onClick={lyricsCreateNew}
                  className="rounded-xl border border-zinc-700 bg-zinc-900/60 px-4 py-5 text-left hover:bg-zinc-900"
                >
                  <div className="text-base font-semibold text-zinc-100">3. 가사 생성</div>
                  <div className="text-xs text-zinc-500 mt-1">빈 상태에서 직접 만들기 — 트랜스포트로 재생하며 스탬프 찍기</div>
                </button>
              </div>
            ) : null}

            {lyricsMode === "lrclib" ? (
              <div className="space-y-3">
                <div className="grid grid-cols-2 gap-2">
                  <input
                    className="bg-zinc-900 border border-zinc-700 rounded-lg px-3 py-2 text-sm"
                    placeholder="곡 제목"
                    value={lyricsSearchTitle}
                    onChange={(e) => setLyricsSearchTitle(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && lrclibSearch()}
                  />
                  <input
                    className="bg-zinc-900 border border-zinc-700 rounded-lg px-3 py-2 text-sm"
                    placeholder="아티스트"
                    value={lyricsSearchArtist}
                    onChange={(e) => setLyricsSearchArtist(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && lrclibSearch()}
                  />
                </div>
                <button
                  onClick={lrclibSearch}
                  disabled={lyricsSearchBusy}
                  className="w-full px-3 py-2 rounded-lg border border-blue-700 text-blue-200 text-sm hover:bg-blue-950/30 disabled:opacity-50"
                >
                  {lyricsSearchBusy ? "검색 중…" : "LRCLIB 검색"}
                </button>

                {lyricsCandidates.length ? (
                  <div className="space-y-2 max-h-[300px] overflow-auto pr-1">
                    {lyricsCandidates.map((c) => (
                      <button
                        key={c.id}
                        onClick={() => lrclibPick(c)}
                        disabled={!c.synced || lyricsSearchBusy}
                        className={`w-full text-left rounded-lg border p-3 ${c.synced ? "border-zinc-700 hover:bg-zinc-900" : "border-zinc-900 opacity-50 cursor-not-allowed"}`}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <div className="text-sm text-zinc-200 truncate">{c.artist} — {c.title}</div>
                          <div className="text-[11px] text-zinc-500 shrink-0">
                            {c.duration ? `${Math.floor(c.duration / 60)}:${String(Math.round(c.duration % 60)).padStart(2, "0")}` : "?"} {c.synced ? "✓싱크" : "싱크없음"}
                          </div>
                        </div>
                        <div className="text-[11px] text-zinc-500 truncate mt-0.5">{c.preview}</div>
                      </button>
                    ))}
                  </div>
                ) : (
                  <div className="text-xs text-zinc-500">
                    곡 제목이 자동으로 채워집니다. 틀리면 수정 후 검색하세요. (유튜브 제목과 음원 제목이 다를 수 있음)
                  </div>
                )}
              </div>
            ) : null}

            {lyricsMode === "paste" ? (
              <div className="space-y-3">
                <div className="text-xs text-zinc-500">
                  LRC 형식 예: <code className="text-zinc-400">[00:12.50] 가사 한 줄</code> — lrclib.net에서 곡을 찾아 {"{...}"} 버튼으로 복사한 뒤 붙여넣으세요.
                </div>
                <textarea
                  className="w-full h-64 bg-zinc-900 border border-zinc-700 rounded-lg px-3 py-2 text-sm font-mono"
                  placeholder={"[ti:곡제목]\n[ar:아티스트]\n[00:12.50] 첫 번째 가사 줄\n[00:16.02] 두 번째 줄"}
                  value={lyricsPasteText}
                  onChange={(e) => setLyricsPasteText(e.target.value)}
                />
                <button
                  onClick={lyricsSavePaste}
                  className="w-full px-3 py-2 rounded-lg border border-blue-700 text-blue-200 text-sm hover:bg-blue-950/30"
                >
                  저장
                </button>
              </div>
            ) : null}

            {lyricsMode === "edit" ? (
              <div className="space-y-3">
                <div className="text-xs text-zinc-500">LRC 원문을 직접 수정합니다. 타임스탬프와 가사를 모두 고칠 수 있어요.</div>
                <textarea
                  id="lyrics-edit-area"
                  className="w-full h-72 bg-zinc-900 border border-zinc-700 rounded-lg px-3 py-2 text-sm font-mono"
                  value={lyricsEditText}
                  onChange={(e) => setLyricsEditText(e.target.value)}
                  onClick={handleEditClick}
                />
                {/* Transport: 재생 컨트롤 + 커서 위치 스탬프 */}
                <div className="flex items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-900/60 px-2 py-1.5">
                  <button
                    onClick={togglePlay}
                    className="px-2.5 py-1 rounded-md border border-zinc-700 text-xs hover:bg-zinc-800"
                    title={isPlaying ? "일시정지" : "재생"}
                  >
                    {isPlaying ? "⏸" : "▶"}
                  </button>
                  <button
                    onClick={() => jumpSeconds(-5)}
                    className="px-2 py-1 rounded-md border border-zinc-700 text-xs hover:bg-zinc-800"
                    title="5초 뒤로"
                  >
                    −5s
                  </button>
                  <button
                    onClick={() => jumpSeconds(-1)}
                    className="px-2 py-1 rounded-md border border-zinc-700 text-xs hover:bg-zinc-800"
                    title="1초 뒤로"
                  >
                    −1s
                  </button>
                  <button
                    onClick={() => jumpSeconds(1)}
                    className="px-2 py-1 rounded-md border border-zinc-700 text-xs hover:bg-zinc-800"
                    title="1초 앞으로"
                  >
                    +1s
                  </button>
                  <button
                    onClick={() => jumpSeconds(5)}
                    className="px-2 py-1 rounded-md border border-zinc-700 text-xs hover:bg-zinc-800"
                    title="5초 앞으로"
                  >
                    +5s
                  </button>
                  <div className="text-[11px] font-mono text-zinc-400 w-12 text-center">
                    {fmtTime(currentPositionLive())}
                  </div>
                  <div className="flex-1" />
                  <button
                    onClick={stampAtCursor}
                    className="px-2 py-1 rounded-md border border-blue-700 text-blue-200 text-xs hover:bg-blue-950/30"
                    title="텍스트 커서 위치에 현재 재생 시간의 타임스탬프 삽입"
                  >
                    ⏱ 스탬프
                  </button>
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={lyricsSaveEdit}
                    className="flex-1 px-3 py-2 rounded-lg border border-blue-700 text-blue-200 text-sm hover:bg-blue-950/30"
                  >
                    저장
                  </button>
                  <button
                    onClick={async () => {
                      if (!confirm("저장된 가사를 삭제할까요?")) return;
                      await fetch(`${BACKEND}/lyrics/${videoId}`, { method: "DELETE" });
                      setLyrics(null);
                      setLyricsOpen(false);
                      toast("가사 삭제됨");
                    }}
                    className="px-3 py-2 rounded-lg border border-red-900/60 text-red-300 text-sm"
                  >
                    삭제
                  </button>
                </div>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}

      {chordsOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" onClick={() => setChordsOpen(false)}>
          <div
            className="w-full max-w-2xl rounded-2xl border border-zinc-800 bg-zinc-950 p-5 space-y-4 max-h-[85vh] overflow-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between">
              <div className="text-lg font-bold text-zinc-100">{chordsMode === "edit" ? "코드 편집" : "코드 만들기"}</div>
              <button onClick={() => setChordsOpen(false)} className="text-zinc-500 hover:text-zinc-200 text-sm px-2">✕</button>
            </div>

            <div className="text-xs text-zinc-500">
              형식: <code className="text-zinc-400">[00:11.82] Am[00:12.44] Bm[00:13.82] C7</code> — 같은 줄에 코드 여러 개 나열 (표시될 때 한 줄로 묶임). 줄바꿈 = 표시 줄 구분.
            </div>
            <textarea
              id="chords-edit-area"
              className="w-full h-80 bg-zinc-900 border border-zinc-700 rounded-lg px-3 py-2 text-sm font-mono"
              placeholder={"[00:07.82] Am[00:08.44] Bm[00:09.82] C7\n[00:14.82] F[00:15.44] G[00:16.82] Am"}
              value={chordsText}
              onChange={(e) => setChordsText(e.target.value)}
              onClick={handleChordsEditClick}
            />
            {/* Transport: 재생 컨트롤 + 커서 위치 코드 스탬프 */}
            <div className="flex items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-900/60 px-2 py-1.5">
              <button
                onClick={togglePlay}
                className="px-2.5 py-1 rounded-md border border-zinc-700 text-xs hover:bg-zinc-800"
                title={isPlaying ? "일시정지" : "재생"}
              >
                {isPlaying ? "⏸" : "▶"}
              </button>
              <button onClick={() => jumpSeconds(-5)} className="px-2 py-1 rounded-md border border-zinc-700 text-xs hover:bg-zinc-800" title="5초 뒤로">−5s</button>
              <button onClick={() => jumpSeconds(-1)} className="px-2 py-1 rounded-md border border-zinc-700 text-xs hover:bg-zinc-800" title="1초 뒤로">−1s</button>
              <button onClick={() => jumpSeconds(1)} className="px-2 py-1 rounded-md border border-zinc-700 text-xs hover:bg-zinc-800" title="1초 앞으로">+1s</button>
              <button onClick={() => jumpSeconds(5)} className="px-2 py-1 rounded-md border border-zinc-700 text-xs hover:bg-zinc-800" title="5초 앞으로">+5s</button>
              <div className="text-[11px] font-mono text-zinc-400 w-12 text-center">
                {fmtTime(currentPositionLive())}
              </div>
              <div className="flex-1" />
              <button
                onClick={stampChordAtCursor}
                className="px-2 py-1 rounded-md border border-emerald-700 text-emerald-200 text-xs hover:bg-emerald-950/30"
                title="텍스트 커서 위치에 현재 재생 시간의 타임스탬프 삽입 (빈 스탬프 연타 가능 — 나중에 코드 채우기)"
              >
                ⏱ 스탬프
              </button>
              <button
                onClick={newlineInChordsEditor}
                className="px-2 py-1 rounded-md border border-zinc-700 text-zinc-200 text-xs hover:bg-zinc-800"
                title="커서 위치에서 줄바꿈 (엔터와 동일)"
              >
                ↵ 줄바꿈
              </button>
            </div>
            <div className="flex gap-2">
              <button
                onClick={chordsSave}
                disabled={chordsSaving}
                className="flex-1 px-3 py-2 rounded-lg border border-emerald-700 text-emerald-200 text-sm hover:bg-emerald-950/30 disabled:opacity-50"
              >
                저장
              </button>
              {chords ? (
                <button
                  onClick={async () => {
                    if (!confirm("저장된 코드를 삭제할까요?")) return;
                    await fetch(`${BACKEND}/chords/${videoId}`, { method: "DELETE" });
                    setChords(null);
                    setChordsOpen(false);
                    toast("코드 삭제됨");
                  }}
                  className="px-3 py-2 rounded-lg border border-red-900/60 text-red-300 text-sm"
                >
                  삭제
                </button>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}
    </main>
  );
}
