// A single empty catch → exactly one R-ERR-SWALLOWED finding (catch#0).
export function risky(): void {
    try {
        doIt();
    } catch (error) {}
}
