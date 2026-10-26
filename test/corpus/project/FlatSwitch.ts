// Negative: long but flat — high line/case count, low cognitive load. stoa must
// not punish length (it is not a style linter).
export function label(code: number): string {
    switch (code) {
        case 1:
            return 'one';
        case 2:
            return 'two';
        case 3:
            return 'three';
        case 4:
            return 'four';
        case 5:
            return 'five';
        default:
            return 'other';
    }
}
