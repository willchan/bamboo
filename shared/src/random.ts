// Seeded randomness for the tutor evaluation (docs/ROADMAP.md › Tutor): the engine samples turns
// and the Mac side shuffles answer labels with it, so a run is reproducible from its `--seed`.
// Not for anything security-related.

/** A 32-bit hash of `seed` (FNV-1a), the PRNG's state. */
function hashSeed(seed: string): number {
  let h = 0x811c9dc5;
  for (const ch of seed) {
    h ^= ch.codePointAt(0)!;
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** A PRNG (mulberry32) seeded by a string: numbers in [0, 1), the same sequence for the same seed. */
export function seededRandom(seed: string): () => number {
  let a = hashSeed(seed);
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A shuffled copy of `xs` (Fisher–Yates), determined by `seed`. */
export function seededShuffle<T>(xs: readonly T[], seed: string): T[] {
  const out = [...xs];
  const rand = seededRandom(seed);
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}
