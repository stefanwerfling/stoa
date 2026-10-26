function risky(): void {}

// Positive: empty catch swallows the error.
export function emptyCatch(): void {
    try {
        risky();
    } catch {
    }
}

// Positive: catch returns a default without handling/logging/rethrowing.
export function swallowCatch(): number {
    try {
        risky();
        return 1;
    } catch {
        return 0;
    }
}
