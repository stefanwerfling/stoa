// Outside the tsconfig `include` (like SwipeMeister's backend/test): tsc -p
// never checks this file, so --typecheck must not report on it either — not
// even this genuine error.
import {RATING_TO_FSK} from '../src/Snapshot.js';

const allowed = new Set([0, 6, 12, 16, 18]);
for (const fsk of Object.values(RATING_TO_FSK)) {
    allowed.has(fsk);
}
export const notChecked: number = 'outside the project';
