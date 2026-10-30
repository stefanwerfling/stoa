// Exercises object-field CONFLICT detection: two z.object() implementations
// sharing one Validation Trace ID, differing in their contract-named
// field's conditions — the exact FE/BE shape from the spec (quantity
// min=1 vs min=10), but via z.object() rather than a bare scalar.
import {z} from 'zod';

// stoa:validation VC-OBJECT-CONFLICT-206
const frontendSchema = z.object({quantity: z.number().min(1)});

// stoa:validation VC-OBJECT-CONFLICT-206
const backendSchema = z.object({quantity: z.number().min(10)});

function applyFrontend(value: unknown): unknown {
  return frontendSchema.parse(value);
}

function applyBackend(value: unknown): unknown {
  return backendSchema.parse(value);
}

// A missing field must never be treated as "the same" as a resolved sibling
// — but it must also not be forced into its OWN conflict finding; it stays
// excluded from the comparison (already covered by its own UNRESOLVED
// finding from evaluateAnnotation()). Only ONE comparable entry remains
// (declaredSchema's "amount"), so there is nothing to conflict WITH.
// stoa:validation VC-OBJECT-CONFLICT-MISSING-207
const declaredSchema = z.object({amount: z.number().min(5)});

// stoa:validation VC-OBJECT-CONFLICT-MISSING-207
const undeclaredSchema = z.object({otherField: z.string()});

function applyDeclared(value: unknown): unknown {
  return declaredSchema.parse(value);
}

function applyUndeclared(value: unknown): unknown {
  return undeclaredSchema.parse(value);
}

export {frontendSchema, backendSchema, applyFrontend, applyBackend, declaredSchema, undeclaredSchema, applyDeclared, applyUndeclared};
