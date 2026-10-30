// Exercises safeParse() success/failure-path control-flow verification
// (src/analysis/typescript/SafeParseGuard.ts): accessing `.data` is not by
// itself proof the access is safe — `.safeParse()` returns a discriminated
// union, and `.data` is only sound once `result.success` is PROVEN true.
import {z} from 'zod';

interface Repo {
  save(x: unknown): Promise<void>;
}

// stoa:validation VC-GUARD-FALLA-101
const FallASchema = z.object({name: z.string()});

// Fall A — correct: an early-exit guard (`if (!result.success) throw`)
// unconditionally terminates, so the save() below is proven reachable only
// when result.success was true. Status: failure-path-rejected (verified).
export async function fallA(req: {body: unknown}, repo: Repo): Promise<void> {
  const result = FallASchema.safeParse(req.body);
  if (!result.success) {
    throw new Error('Invalid input');
  }
  await repo.save(result.data);
}

// stoa:validation VC-GUARD-FALLB-102
const FallBSchema = z.object({note: z.string()});

// Fall B — also correct: the access is nested INSIDE the positive
// `if (result.success)` branch. Status: success-guard-verified.
export async function fallB(req: {body: unknown}, repo: Repo): Promise<void> {
  const result = FallBSchema.safeParse(req.body);
  if (result.success) {
    await repo.save(result.data);
  } else {
    return;
  }
}

// stoa:validation VC-GUARD-FALLC-103
const FallCSchema = z.object({tag: z.string()});

// Fall C — unsafe: no check of result.success anywhere before the access.
// Status: success-guard-missing (not verified).
export async function fallC(req: {body: unknown}, repo: Repo): Promise<void> {
  const result = FallCSchema.safeParse(req.body);
  await repo.save(result.data);
}

// stoa:validation VC-GUARD-FALLD-104
const FallDSchema = z.object({flag: z.boolean()});

// Fall D — unsafe: a throw exists, but its condition is entirely UNRELATED
// to result.success — Stoa must not assume safety just because SOME
// condition happens to precede the access. Status: success-guard-missing
// (the condition does not mention result.success at all, so this is
// indistinguishable from "missing", not "unresolved").
export async function fallD(req: {body: unknown; flag?: boolean}, repo: Repo, someCondition: boolean): Promise<void> {
  const result = FallDSchema.safeParse(req.body);
  if (someCondition) {
    throw new Error('Stopped');
  }
  await repo.save(result.data);
}

// stoa:validation VC-GUARD-UNRESOLVED-105
const UnresolvedSchema = z.object({amount: z.number()});

// Negative control for "unresolved" (as opposed to "missing"): the
// condition DOES mention result.success, but AND-combined with an
// unrelated check in the REJECT branch — rejecting only when BOTH hold
// means reaching the access does NOT prove success was true (it could have
// been false while `other` was also false). Status: success-guard-unresolved.
export async function unresolvedGuard(req: {body: unknown}, repo: Repo, other: boolean): Promise<void> {
  const result = UnresolvedSchema.safeParse(req.body);
  if (!result.success && other) {
    throw new Error('Stopped');
  }
  await repo.save(result.data);
}
