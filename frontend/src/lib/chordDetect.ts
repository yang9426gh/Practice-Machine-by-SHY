// Chord detection for the "스탬프+코드" button.
// Algorithm ported from the validated Python prototype (backend venv numpy, validated against
// user-entered chords on 3 real songs): bass low-band chroma = root evidence, upper-stem
// (other/guitar/piano) chroma = quality evidence, fused by score = chroma_sim + 0.5 * bass_support.
// Measured accuracy (prototype, 153 stamp events): overall root 54% / root+quality 42%;
// simple-triad worship songs root 65% / full 56%. Treat output as an editable guess.

// ---------- constants (mirrors chord_proto3 FINAL config) ----------
const NFFT = 8192;
const FMIN = 60;
const MIX_FMAX = 2000;
const BASS_FMIN = 40;
const BASS_FMAX = 280;
const UPPER_EXPO = 0.4;
const BASS_EXPO = 0.7;
const WIN_DUR = 1.2; // analysis window: [t, t+1.2s] — the chord that just started at the stamp
const W_BASS = 0.5;
const TONE_W = 0.7;
const ROOT_W = 1.15;
const PENALTY = 0.05;
const PRIOR_SCALE = 4.0;
const INV_MIN_BASS = 0.45;

const QUAL_PRIOR: Record<string, number> = {
  maj: 0, min: 0, sus4: 0.02, sus2: 0.03, "5": 0.03,
  "7": 0.04, m7: 0.03, maj7: 0.05, m7b5: 0.08, dim: 0.06, aug: 0.08,
};

const CHORD_TONES: Record<string, number[]> = {
  maj: [0, 4, 7], min: [0, 3, 7], dim: [0, 3, 6], aug: [0, 4, 8],
  sus2: [0, 2, 7], sus4: [0, 5, 7], "5": [0, 7],
  maj7: [0, 4, 7, 11], "7": [0, 4, 7, 10], m7: [0, 3, 7, 10], m7b5: [0, 3, 6, 10],
};
const QSUF: Record<string, string> = {
  maj: "", min: "m", dim: "dim", aug: "aug", sus2: "sus2", sus4: "sus4",
  "5": "5", maj7: "maj7", "7": "7", m7: "m7", m7b5: "m7b5",
};

export const PC_SHARP = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
export const PC_FLAT = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"];
const NOTE_PC: Record<string, number> = {};
for (let i = 0; i < 12; i++) {
  NOTE_PC[PC_SHARP[i]] = i;
  NOTE_PC[PC_FLAT[i]] = i;
}

const FLAT_KEYS_MAJOR = new Set(["F", "Bb", "Eb", "Ab", "Db", "Gb"]);
const FLAT_KEYS_MINOR = new Set(["D", "G", "C", "F", "Bb", "Eb"]);

// ---------- enharmonic spelling ----------
// Key-signature preference: flat keys spell flats (Bb not A#), sharp keys spell sharps.
export function keyAccidentalPref(tonic: string | null | undefined, mode: string | null | undefined): "flat" | "sharp" {
  const t = tonic || "C";
  if (mode === "minor") return FLAT_KEYS_MINOR.has(t) ? "flat" : "sharp";
  return FLAT_KEYS_MAJOR.has(t) ? "flat" : "sharp";
}

export function spellPc(pc: number, pref: "flat" | "sharp"): string {
  return pref === "flat" ? PC_FLAT[((pc % 12) + 12) % 12] : PC_SHARP[((pc % 12) + 12) % 12];
}

// Fallback preference when the song has no key info: follow the accidentals already
// present in the user's chord text (# vs b count); default sharp.
export function prefFromChordText(text: string): "flat" | "sharp" {
  const sharps = (text.match(/#/g) || []).length;
  const flats = (text.match(/b(?![a-zA-Z])/g) || []).length; // b used as accidental, not note name
  return flats > sharps ? "flat" : "sharp";
}

// ---------- templates ----------
interface Tpl { q: string; root: number; v: Float32Array }

function buildTemplates(): Tpl[] {
  const tpls: Tpl[] = [];
  for (const q of Object.keys(CHORD_TONES)) {
    for (let root = 0; root < 12; root++) {
      const v = new Float32Array(12);
      for (const off of CHORD_TONES[q]) v[(root + off) % 12] = off === 0 ? ROOT_W : 1.0;
      let n = 0;
      for (let i = 0; i < 12; i++) n += v[i] * v[i];
      n = Math.sqrt(n);
      for (let i = 0; i < 12; i++) v[i] /= n;
      tpls.push({ q, root, v });
    }
  }
  return tpls;
}
const TPLS = buildTemplates();

// ---------- FFT (iterative radix-2) ----------
function fft(re: Float32Array, im: Float32Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k], ui = im[i + k];
        const vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
        const vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k] = ur + vr; im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}

function pcOfFreq(f: number): number {
  const midi = 69 + 12 * Math.log2(Math.max(f, 1e-9) / 440);
  return ((Math.round(midi) % 12) + 12) % 12;
}

// ---------- chroma ----------
function monoMix(buf: AudioBuffer): Float32Array {
  const n = buf.length;
  const out = new Float32Array(n);
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < n; i++) out[i] += d[i];
  }
  if (buf.numberOfChannels > 1) {
    const k = 1 / buf.numberOfChannels;
    for (let i = 0; i < n; i++) out[i] *= k;
  }
  return out;
}

// Mono mixes are expensive to recompute (whole-song copy) and the live monitor calls
// detection ~3x/s, so cache them per AudioBuffer for the session.
const monoCache = new WeakMap<AudioBuffer, Float32Array>();
function monoMixCached(buf: AudioBuffer): Float32Array {
  let m = monoCache.get(buf);
  if (!m) {
    m = monoMix(buf);
    monoCache.set(buf, m);
  }
  return m;
}

interface ChromaOpts {
  fmin: number; fmax: number; expo: number; harm: boolean; frameL1?: boolean;
}

function chromaOfWindow(x: Float32Array, sr: number, startS: number, durS: number, opts: ChromaOpts): Float32Array | null {
  const nfft = Math.min(NFFT, x.length);
  if (x.length < nfft) return null;
  const i0 = Math.max(0, Math.round(startS * sr));
  const n = Math.round(durS * sr);
  const segEnd = Math.min(x.length, i0 + n);
  if (segEnd - i0 < nfft) return null;
  const hop = nfft >> 1;
  const win = new Float32Array(nfft);
  for (let i = 0; i < nfft; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (nfft - 1));
  const harmonics: Array<[number, number]> = opts.harm
    ? [[1, 1], [2, 0.6], [3, 0.4], [4, 0.25]]
    : [[1, 1]];
  const re = new Float32Array(nfft);
  const im = new Float32Array(nfft);
  const acc = new Float32Array(12);
  const frames: Array<{ mag: Float32Array; e: number }> = [];
  for (let s = i0; s + nfft <= segEnd; s += hop) {
    for (let i = 0; i < nfft; i++) { re[i] = x[s + i] * win[i]; im[i] = 0; }
    fft(re, im);
    const mag = new Float32Array(nfft / 2 + 1);
    let e = 0;
    for (let k = 0; k <= nfft / 2; k++) {
      const m = Math.sqrt(re[k] * re[k] + im[k] * im[k]) ** opts.expo;
      mag[k] = m;
      const f = (k * sr) / nfft;
      if (f >= opts.fmin && f <= opts.fmax) e += m;
    }
    frames.push({ mag, e });
  }
  let emax = 0;
  for (const f of frames) emax = Math.max(emax, f.e);
  let nfr = 0;
  for (const { mag, e } of frames) {
    if (e <= 0.1 * emax) continue;
    const c = new Float32Array(12);
    const nbin = nfft / 2 + 1;
    for (const [h, w] of harmonics) {
      const m = Math.floor(nbin / h);
      for (let k = 0; k < m; k++) {
        const fund = (k * sr) / nfft; // fundamental frequency of this entry
        if (fund < opts.fmin || fund > opts.fmax) continue;
        c[pcOfFreq(fund)] += mag[k * h] * w; // harmonic-bin magnitude pulled down to fundamental pc
      }
    }
    if (opts.frameL1) {
      let s = 0;
      for (let i = 0; i < 12; i++) s += c[i];
      if (s > 1e-9) for (let i = 0; i < 12; i++) c[i] /= s;
    }
    for (let i = 0; i < 12; i++) acc[i] += c[i];
    nfr++;
  }
  if (nfr === 0) return null;
  for (let i = 0; i < 12; i++) acc[i] /= nfr;
  return acc;
}

// ---------- detection ----------
export interface ChordGuess {
  root: number;       // pitch class 0-11 (in BASE key space if shiftBack applied by caller)
  quality: string;
  bass: number | null; // slash-chord bass pc, or null
  label: string;       // spelled, e.g. "G/B" or "Bb"
}

export interface DetectOptions {
  keyTonic?: string | null;
  keyMode?: string | null;
  semitones?: number; // audio transpose applied to the buffers; detected pcs are shifted back
  pref?: "flat" | "sharp"; // accidental preference when no key info (falls back to "sharp")
  durSec?: number; // analysis window length; default 1.2s (live monitor uses 1.0s)
}

const UPPER_STEMS = ["other", "guitar", "piano"];

export function detectChordAtTime(
  buffers: Record<string, AudioBuffer>,
  tSec: number,
  opts: DetectOptions = {}
): ChordGuess | null {
  const dur = opts.durSec ?? WIN_DUR;
  let u = new Float32Array(12);
  let nb = 0;
  for (const stem of UPPER_STEMS) {
    const buf = buffers[stem];
    if (!buf) continue;
    const c = chromaOfWindow(monoMixCached(buf), buf.sampleRate, tSec, dur,
      { fmin: FMIN, fmax: MIX_FMAX, expo: UPPER_EXPO, harm: false });
    if (!c) continue;
    for (let i = 0; i < 12; i++) u[i] += c[i];
    nb++;
  }
  if (nb === 0) {
    // legacy 2-stem songs: no_vocals carries the instruments
    const nv = buffers["no_vocals"];
    if (nv) {
      const c = chromaOfWindow(monoMixCached(nv), nv.sampleRate, tSec, dur,
        { fmin: FMIN, fmax: MIX_FMAX, expo: UPPER_EXPO, harm: false });
      if (c) { u = c.slice(); nb = 1; }
    }
  }
  if (nb === 0) return null;
  let n2 = 0;
  for (let i = 0; i < 12; i++) n2 += u[i] * u[i];
  n2 = Math.sqrt(n2);
  if (n2 < 1e-9) return null;
  for (let i = 0; i < 12; i++) u[i] /= n2;

  // bass root evidence
  let b: Float32Array | null = null;
  const bassBuf = buffers["bass"];
  if (bassBuf) {
    const c = chromaOfWindow(monoMixCached(bassBuf), bassBuf.sampleRate, tSec, dur,
      { fmin: BASS_FMIN, fmax: BASS_FMAX, expo: BASS_EXPO, harm: true, frameL1: true });
    if (c) {
      let mx = 0;
      for (let i = 0; i < 12; i++) mx = Math.max(mx, c[i]);
      if (mx > 1e-9) {
        b = c.slice();
        for (let i = 0; i < 12; i++) b[i] /= mx;
      }
    }
  }

  // Pedal-resistant bass support: what matters is where the bass JUST MOVED TO, not
  // what it currently rings (a held C pedal under Bb chords used to flip Bb -> C).
  // support = relu(b - baseline) where baseline = bass chroma over [t-4.5, t-1.2].
  // Songs shorter than the baseline window fall back to raw bass support.
  let bSup: Float32Array | null = null;
  if (b) {
    bSup = b;
    if (tSec >= 1.7 && bassBuf) {
      const bStart = Math.max(0, tSec - 4.5);
      const bEnd = Math.max(bStart + 0.5, tSec - 1.2);
      const baseC = chromaOfWindow(monoMixCached(bassBuf), bassBuf.sampleRate, bStart, bEnd - bStart,
        { fmin: BASS_FMIN, fmax: BASS_FMAX, expo: BASS_EXPO, harm: true, frameL1: true });
      if (baseC) {
        let bmx = 0;
        for (let i = 0; i < 12; i++) bmx = Math.max(bmx, baseC[i]);
        if (bmx > 1e-9) {
          const d = new Float32Array(12);
          let mx = 0;
          for (let i = 0; i < 12; i++) {
            d[i] = Math.max(0, b[i] - baseC[i] / bmx);
            mx = Math.max(mx, d[i]);
          }
          if (mx > 1e-9) {
            for (let i = 0; i < 12; i++) d[i] /= mx;
            bSup = d;
          }
        }
      }
    }
  }

  // score = cosine(upper, template) - prior - complexity penalty + W_BASS * bass support
  let bestIdx = -1, bestScore = -Infinity, secondScore = -Infinity;
  for (let i = 0; i < TPLS.length; i++) {
    const t = TPLS[i];
    let s = 0;
    for (let k = 0; k < 12; k++) s += u[k] * t.v[k];
    s -= QUAL_PRIOR[t.q] * PRIOR_SCALE;
    const extra = Math.max(0, CHORD_TONES[t.q].length - 3);
    s -= PENALTY * extra;
    if (bSup && W_BASS > 0) {
      let sup = bSup[t.root];
      for (const off of CHORD_TONES[t.q]) {
        if (off === 0) continue;
        sup = Math.max(sup, TONE_W * bSup[(t.root + off) % 12]);
      }
      s += W_BASS * sup;
    }
    if (s > bestScore) { secondScore = bestScore; bestScore = s; bestIdx = i; }
    else if (s > secondScore) secondScore = s;
  }
  if (bestIdx < 0) return null;
  const t = TPLS[bestIdx];

  // inversion: bass note is a non-root chord tone with real strength
  let inv: number | null = null;
  if (b) {
    let bpc = 0, bv = -1;
    for (let i = 0; i < 12; i++) if (b[i] > bv) { bv = b[i]; bpc = i; }
    const off = ((bpc - t.root) % 12 + 12) % 12;
    if (bpc !== t.root && CHORD_TONES[t.q].includes(off) && bv >= INV_MIN_BASS) inv = bpc;
  }

  // shift back to base-key space when the audio is transposed
  const shift = ((-(opts.semitones ?? 0) % 12) + 12) % 12;
  const root = (t.root + shift) % 12;
  const bass = inv === null ? null : (inv + shift) % 12;

  const pref = opts.keyTonic
    ? keyAccidentalPref(opts.keyTonic, opts.keyMode)
    : opts.pref ?? "sharp";
  let label = spellPc(root, pref) + QSUF[t.q];
  if (bass !== null) label += "/" + spellPc(bass, pref);
  return { root, quality: t.q, bass, label };
}
