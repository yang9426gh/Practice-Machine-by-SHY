// 악기 모드 값 화이트리스트 (Default Instrument 설정 + 재생창 초기 모드 적용 공용)
export const MIX_MODE_VALUES = ["master", "vocal", "drums", "bass", "guitar", "piano"] as const;
export type MixModeValue = (typeof MIX_MODE_VALUES)[number];

export type UiSettings = {
  bgOpacity: number;        // 0..1
  bgBlurPx: number;         // px
  bgSaturate: number;       // 0.5..2.5
  overlayOpacity: number;   // 0..1
  vignetteTop: number;      // 0..1
  vignetteBottom: number;   // 0..1
  vignetteSides: number;    // 0..1
  chordStampOffsetSec: number; // 스탬프 오프셋(초): 음수=그만큼 더 일찍 기록, 양수=더 늦게 기록
  lyricStampOffsetSec: number; // 〃 가사 스탬프
  btcStampFillOffsetSec: number; // 스탬프 채우기 매칭 오프셋(초): 스탬프 시각 + 이 값으로 BTC 타임라인 조회
  defaultMixMode: MixModeValue; // 재생창 진입 시 항상 먼저 뜨는 스템 믹서 모드
};

export const DEFAULT_SETTINGS: UiSettings = {
  bgOpacity: 0.55,
  bgBlurPx: 20,
  bgSaturate: 1.4,
  overlayOpacity: 0.25,
  vignetteTop: 0.55,
  vignetteBottom: 0.65,
  vignetteSides: 0.55,
  chordStampOffsetSec: -0.25,
  lyricStampOffsetSec: -0.25,
  btcStampFillOffsetSec: 0.35, // SHY 튜닝값(2026-11-02) — 첫 설치부터 이 값으로 시작
  defaultMixMode: "master",
};

// 숫자 설정값 방어: 문자/null/NaN/범위 밖이 저장돼도 fallback 또는 clamp로 복귀 (소수 2자리 반올림)
export function clampNum(v: unknown, min: number, max: number, fallback: number): number {
  if (v === null || v === undefined) return fallback; // Number(null)===0 함정: 값 없음은 기본값으로
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n * 100) / 100));
}

const KEY = 'karaoke_ui_settings_v1';

export function loadSettings(): UiSettings {
  if (typeof window === 'undefined') return DEFAULT_SETTINGS;
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return DEFAULT_SETTINGS;
    const parsed = JSON.parse(raw);
    const merged = { ...DEFAULT_SETTINGS, ...parsed } as UiSettings;
    // 스탬프 오프셋은 스탬프 연산에 직접 쓰임 — 오염값(NaN 등)이면 스탬프가 [NaN:NaN]으로 찍히므로 방어
    // 구버전 마이그레이션: lead 저장(0.25 = 더 일찍) → offset은 부호 반전(-0.25 = 더 일찍). 새 키가 이미 있으면 무시
    if (parsed.chordStampOffsetSec === undefined && parsed.chordStampLeadSec !== undefined) {
      merged.chordStampOffsetSec = -Number(parsed.chordStampLeadSec);
    }
    if (parsed.lyricStampOffsetSec === undefined && parsed.lyricStampLeadSec !== undefined) {
      merged.lyricStampOffsetSec = -Number(parsed.lyricStampLeadSec);
    }
    merged.chordStampOffsetSec = clampNum(merged.chordStampOffsetSec, -2, 2, DEFAULT_SETTINGS.chordStampOffsetSec);
    merged.lyricStampOffsetSec = clampNum(merged.lyricStampOffsetSec, -2, 2, DEFAULT_SETTINGS.lyricStampOffsetSec);
    merged.btcStampFillOffsetSec = clampNum(merged.btcStampFillOffsetSec, -2, 2, DEFAULT_SETTINGS.btcStampFillOffsetSec);
    if (!(MIX_MODE_VALUES as readonly string[]).includes(merged.defaultMixMode)) merged.defaultMixMode = "master";
    return merged;
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function saveSettings(s: UiSettings) {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(KEY, JSON.stringify(s));
}
