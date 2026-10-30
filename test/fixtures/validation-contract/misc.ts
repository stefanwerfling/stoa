// Edge cases: a malformed ID, an ID the contract does not define, an enum
// allowedValues mismatch, and a shape Stoa cannot resolve (.refine() has an
// effect Stoa cannot verify, so the whole schema stays unresolved rather than
// silently treated as "just a number").
import {z} from 'zod';

// stoa:validation quantity_bad
const malformedId = z.number().min(1);

// stoa:validation VC-GHOST-FIELD-099
const unknownId = z.number().min(1);

// The contract declares allowedValues=[admin,user,guest]; this implementation
// only allows two of the three — a MISMATCH (z.enum is a recognized base
// shape, so this is resolved, not unresolved).
// stoa:validation VC-USER-ROLE-004
const roleSchema = z.enum(['admin', 'user']);
roleSchema.parse('admin');

// .refine() carries a predicate Stoa cannot evaluate statically, so the whole
// schema stays unresolved rather than being silently described as "just a
// non-negative-looking number".
// stoa:validation VC-AGE-CHECK-013
const ageSchema = z.number().refine((value) => value >= 0);

export {malformedId, unknownId, roleSchema, ageSchema};
