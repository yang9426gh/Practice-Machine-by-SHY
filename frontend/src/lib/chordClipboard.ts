// 코드 편집창 — 코드 복사/붙여넣기 순수 함수 (node 단위테스트 대상).
// "스탬프 슬롯" 단위 모델: [스탬프] + 그 뒤에 붙은 코드 텍스트(다음 스탬프 또는 줄끝 직전까지, trim).
//   - 코드 복사: 선택 영역에 걸친 슬롯들의 코드값 목록만 추출 (타임스탬프는 복사 안 함)
//   - 코드 붙여넣기: 선택 영역의 슬롯에 복사해둔 코드를 "순서대로" 덮어씀 — 스탬프(타이밍) 보존, 코드만 교체
// 포함 판정은 "스탬프 토큰이 선택 영역과 맞닿아 있으면(부분이라도) 포함" — 드래그가 코드 이름
// 한가운데서 시작/끝나도 슬롯 개수가 어긋나지 않는다 (줄 단위 확장 방식과 다른, 슬롯 정밀 방식).

export const STAMP_SRC = "\\[\\d{1,3}:\\d{1,2}(?:[.:]\\d{1,3})?\\]";

export type ChordSlot = {
  stamp: string; // "[00:00.88]" 원본 토큰
  chord: string; // 스탬프 뒤 코드 텍스트 (trim, 빈 스탬프는 "")
  slotStart: number; // 슬롯 시작 = 스탬프 시작 (전체 텍스트 기준 index)
  slotEnd: number; // 슬롯 끝 = 코드 텍스트 마지막 글자 다음 (뒤쪽 공백은 슬롯 밖 — 인접 슬롯과의 간격 보존)
};

function lineEndOf(text: string, from: number): number {
  const nl = text.indexOf("\n", from);
  return nl < 0 ? text.length : nl;
}

// 선택 영역 [selStart, selEnd)에 걸친 스탬프 슬롯들을 순서대로 반환
export function findSlotsInSelection(text: string, selStart: number, selEnd: number): ChordSlot[] {
  const stamps: Array<{ token: string; start: number; end: number }> = [];
  const re = new RegExp(STAMP_SRC, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) stamps.push({ token: m[0], start: m.index, end: m.index + m[0].length });
  const slots: ChordSlot[] = [];
  for (let i = 0; i < stamps.length; i++) {
    const st = stamps[i];
    const segEnd = Math.min(
      i + 1 < stamps.length ? stamps[i + 1].start : text.length,
      lineEndOf(text, st.end),
    );
    const raw = text.slice(st.end, segEnd);
    const trimmed = raw.trim();
    const trailing = raw.length - raw.replace(/\s+$/, "").length;
    const slot: ChordSlot = {
      stamp: st.token,
      chord: trimmed,
      slotStart: st.start,
      slotEnd: st.end + raw.length - trailing,
    };
    // 슬롯 "전체" span(스탬프+코드 텍스트)이 선택 영역과 맞닿으면 포함 — 드래그가 코드 이름
    // 한가운데서 시작/끝나도 그 슬롯이 빠지지 않는다 (스탬프 토큰만 보면 코드 쪽 드래그를 놓침)
    if (slot.slotEnd <= selStart || slot.slotStart >= selEnd) continue;
    slots.push(slot);
  }
  return slots;
}

export type PasteResult = { newText: string; applied: number; kept: number };

// slots 순서대로 chords를 덮어씀. 복사본이 모자라면 남은 슬롯은 기존 코드 유지(kept),
// 넘치는 코드는 버림(호출부에서 개수 불일치 시 confirm으로 확인받은 뒤 호출).
export function applyChordsToSlots(text: string, slots: ChordSlot[], chords: string[]): PasteResult {
  let out = "";
  let pos = 0;
  let applied = 0;
  let kept = 0;
  for (let i = 0; i < slots.length; i++) {
    const sl = slots[i];
    const newChord = i < chords.length ? chords[i] : sl.chord;
    if (i < chords.length) applied++;
    else kept++;
    out += text.slice(pos, sl.slotStart) + sl.stamp + (newChord ? ` ${newChord}` : "");
    pos = sl.slotEnd;
  }
  out += text.slice(pos);
  return { newText: out, applied, kept };
}
