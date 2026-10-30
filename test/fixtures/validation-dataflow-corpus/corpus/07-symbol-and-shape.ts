// Golden-corpus group: symbol-based resolution (shadowing), safeParse
// control-flow verification, object-field conflicts, prototype-safe field
// lookup, and an unsupported z.object() construct staying unresolved — one
// representative case per category, sampled into the SAME precision/recall
// gate as the other 16 required groups (see src/analysis/typescript/
// SymbolResolution.ts, SafeParseGuard.ts and ValidationAnnotations.ts for
// the dedicated, more exhaustive unit coverage of each).
import {z} from 'zod';

interface Repo {
  save(x: unknown): Promise<void>;
}

// Group: shadowing. A DIFFERENT, shadowed `result` must not be mistaken for
// the validated one — the real result reaches its OWN save() afterward.
// stoa:validation VC-CORPUS-SHADOW-401
const ShadowSchema = z.object({name: z.string()});
export async function shadowedScope(req: {body: unknown}, repo: Repo): Promise<void> {
  const result = ShadowSchema.parse(req.body);
  {
    const result = {data: {admin: true}};
    await repo.save(result);
  }
  await repo.save(result);
}

// Group: safeParse control flow. No check of result.success anywhere —
// flagged as unguarded, not silently treated as safe.
// stoa:validation VC-CORPUS-UNGUARDED-402
const UnguardedSchema = z.object({tag: z.string()});
export async function unguardedAccess(req: {body: unknown}, repo: Repo): Promise<void> {
  const result = UnguardedSchema.safeParse(req.body);
  await repo.save(result.data);
}

// Group: object-field conflict. Two z.object() implementations sharing one
// trace ID, differing in the contract-named field's conditions.
// stoa:validation VC-CORPUS-FIELD-CONFLICT-403
const feQuantitySchema = z.object({quantity: z.number().min(1)});
// stoa:validation VC-CORPUS-FIELD-CONFLICT-403
const beQuantitySchema = z.object({quantity: z.number().min(10)});
export function applyFe(value: unknown): unknown {
  return feQuantitySchema.parse(value);
}
export function applyBe(value: unknown): unknown {
  return beQuantitySchema.parse(value);
}

// Group: prototype-safe field lookup. A field literally named "constructor"
// must match its own contract entry, not an inherited Object.prototype one.
// stoa:validation VC-CORPUS-PROTO-404
const constructorFieldSchema = z.object({constructor: z.string()});
export function applyConstructorField(value: unknown): unknown {
  return constructorFieldSchema.parse(value);
}

// Group: unsupported construct. A nested z.object() field is itself not a
// scalar chain — stays unresolved, not guessed at.
// stoa:validation VC-CORPUS-NESTED-405
const nestedSchema = z.object({address: z.object({city: z.string()})});
export function applyNested(value: unknown): unknown {
  return nestedSchema.parse(value);
}
