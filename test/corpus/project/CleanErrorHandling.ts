function risky(): void {}
function log(message: string): void {
    void message;
}

// Negative: rethrows — the error is not swallowed.
export function rethrow(): void {
    try {
        risky();
    } catch (error) {
        throw error;
    }
}

// Negative: handles by logging — not swallowed.
export function handled(): void {
    try {
        risky();
    } catch (error) {
        log(String(error));
    }
}
