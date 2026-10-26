// Negative: same shape as the tangled positive, but the team documented that the
// complexity is necessary, so stoa must stay silent (context beats threshold).
// stoa:allow-complexity
export function tangledAllowed(a: number, b: number): number {
    let r = 0;
    if (a > 0) {
        for (let i = 0; i < b; i++) {
            if (i % 2 === 0) {
                if (a > i && b > i) {
                    r += 1;
                }
            }
        }
    }
    return r;
}
