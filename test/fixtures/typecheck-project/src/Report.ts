// Regression fixture (SwipeMeister StatsReportService): the value type of
// Object.entries() over an IMPORTED Record is only known when the import is
// resolved. Checked in isolation the import degrades to `any`, Object.entries
// yields `unknown` values and esc(count) is a false [2345].
import type {Snapshot} from './Snapshot.js';

const esc = (value: string | number): string => String(value);

export const render = (snapshot: Snapshot): string => {
    const out: string[] = [];
    for (const [type, count] of Object.entries(snapshot.byType)) {
        out.push(`${esc(type)}: ${esc(count)}`);
    }
    return out.join('\n');
};
