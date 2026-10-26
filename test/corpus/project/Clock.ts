// Positive: reads the clock directly — non-deterministic side effect.
export function stamp(): number {
    return Date.now();
}
