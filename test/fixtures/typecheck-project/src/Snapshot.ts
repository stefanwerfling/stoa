export interface Snapshot {
    byType: Record<string, number>;
}

export const RATING_TO_FSK: Readonly<Record<string, number>> = Object.freeze({G: 0, PG: 6});
