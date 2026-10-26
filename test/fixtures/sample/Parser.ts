// A deliberately imperfect fixture for later rule stages (M3):
// the empty catch here is the kind of thing R-ERR-SWALLOWED will flag.
export const parseRecord = (raw: string): unknown => {
    try {
        return JSON.parse(raw);
    } catch {
        return null;
    }
};
