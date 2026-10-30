// Mix-mode → bus routing table (pure, unit-testable).
// Page.tsx wires stem GainNodes to buses via this; keep in sync with the
// gains-apply effect (which drives the same buses by name).
export type BusName = "master" | "inst" | "vocalsBus" | "focusBus" | "otherBus";

export interface MixModeLite {
  kind: string;
  instrument?: string;
}

export function busForStem(stem: string, mode: MixModeLite): BusName {
  if (mode.kind === "vocal") {
    return stem === "vocals" ? "focusBus" : "otherBus";
  }
  if (mode.kind === "instrument") {
    if (stem === "vocals") return "vocalsBus";
    if (mode.instrument && stem === mode.instrument) return "focusBus";
    return "otherBus";
  }
  // master (and "select" fallback): vocals straight to master, rest via inst bus
  return stem === "vocals" ? "master" : "inst";
}
