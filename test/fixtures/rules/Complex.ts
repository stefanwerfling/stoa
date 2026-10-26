export function tangled(a: number, b: number): number {
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
    if (b > 0 && a > 0) {
        while (r > 0) {
            r -= 1;
        }
    }
    if (a < 0 || b < 0) {
        r = r > 0 ? r : -r;
    }
    return r;
}

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
