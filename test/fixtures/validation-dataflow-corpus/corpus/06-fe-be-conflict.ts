// Golden-corpus group 16: two implementations sharing the same Validation
// Trace ID but enforcing different conditions — a conflict Stoa reports
// symmetrically (it cannot tell which side, if either, is correct). Both
// implementations live in this one file (two different functions) purely
// for corpus-file-count convenience; the rule itself is file-agnostic.
import {z} from 'zod';

// stoa:validation VC-CORPUS-FE-BE-CONFLICT-108
const discountFrontend = z.number().min(0).max(50);

// stoa:validation VC-CORPUS-FE-BE-CONFLICT-108
const discountBackend = z.number().min(0).max(80);

function applyFrontend(value: number): number {
  return discountFrontend.parse(value);
}

function applyBackend(value: number): number {
  return discountBackend.parse(value);
}

export {applyFrontend, applyBackend};
