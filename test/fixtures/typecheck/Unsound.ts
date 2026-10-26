// Self-contained type errors (no imports) for the opt-in type-check adapter.
export function bad(): number {
    const n: number = 'not a number';
    return n;
}

export function maybe(input?: {value: number}): number {
    return input.value;
}
