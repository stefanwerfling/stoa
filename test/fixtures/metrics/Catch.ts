function risky(): void {}

export function emptyCatch(): void {
    try {
        risky();
    } catch {
    }
}

export function rethrowCatch(): void {
    try {
        risky();
    } catch (error) {
        throw error;
    }
}

export function swallowCatch(): number {
    try {
        risky();
        return 1;
    } catch {
        return 0;
    }
}
