// Positive: CycleA and CycleB import each other (a dependency cycle).
import {b} from './CycleB.js';

export const a = (): number => b() + 1;
