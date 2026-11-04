// Storage keys are '#'-joined. A segment containing '#' could escape its prefix and read another
// record family, so every interpolated segment must match this strict pattern.
const SEGMENT = /^[A-Za-z0-9:._-]{1,100}$/;

/** Returns the segment unchanged or throws; never builds a key from unvalidated input. */
export function seg(value: string): string {
  if (!SEGMENT.test(value)) throw new Error('invalid key segment');
  return value;
}
