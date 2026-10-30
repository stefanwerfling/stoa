// Golden-corpus group 9/10/11: multiple .max() constraints merge to the
// smallest (not "last wins"), multiple format constraints AND together (not
// "last wins" either), and an unrecognized modifier stays explicitly
// unresolved rather than silently guessed at.
import {z} from 'zod';

// Group 9: .max(100).max(50) must resolve to max=50 — matching the
// contract's max=50 exactly. A pre-fix "last wins" bug would have produced
// max=100, a false mismatch against this contract.
// stoa:validation VC-CORPUS-MAX-MERGE-103
const quantitySchema = z.number().min(0).max(100).max(50);

// Group 10: .email().url() chained together must both remain visible (Zod
// ANDs every check) — the contract requires only "email", which is among
// the enforced formats, so this must NOT be a mismatch.
// stoa:validation VC-CORPUS-FORMAT-AND-104
const handleSchema = z.string().email().url();

// Group 11: .refine() is not a recognized scalar Zod chain modifier — the
// whole schema stays unresolved rather than silently treated as a no-op.
// stoa:validation VC-CORPUS-UNKNOWN-MODIFIER-105
const ageSchema = z.number().refine((value) => value >= 0);

function checkAll(input: {quantity: number; handle: string; age: number}) {
  return {
    quantity: quantitySchema.parse(input.quantity),
    handle: handleSchema.parse(input.handle),
    age: ageSchema.parse(input.age)
  };
}

export {quantitySchema, handleSchema, ageSchema, checkAll};
