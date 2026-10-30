// Exercises symbol-based (not identifier-TEXT-based) dataflow resolution in
// ValidationDataflow.ts / OneHopResolution.ts: two different variables that
// merely share a spelling must never be treated as the same value.
import {z} from 'zod';

interface Repo {
  save(x: unknown): Promise<void>;
}

// stoa:validation VC-SYMBOL-SHADOW-101
const ShadowSchema = z.object({name: z.string()});

// Case 1/2: a DIFFERENT, shadowed `result` in a nested block must not be
// mistaken for the validated one — req.body still reaches save() unguarded
// via the real `result` only through the OUTER call below, which is what a
// pre-fix, text-based match would have wrongly "verified" via the INNER one.
export async function shadowedScope(req: {body: unknown}, repo: Repo): Promise<void> {
  const result = ShadowSchema.parse(req.body);
  {
    const result = {data: {admin: true}};
    await repo.save(result);
  }
  await repo.save(result);
}

// stoa:validation VC-SYMBOL-ALIAS-102
const AliasSchema = z.object({note: z.string()});

// Case 3: a plain `const alias = result` must still resolve to the SAME
// validated value as `result` itself.
export async function aliasedResult(req: {body: unknown}, repo: Repo): Promise<void> {
  const result = AliasSchema.parse(req.body);
  const alias = result;
  await repo.save(alias);
}

// stoa:validation VC-SYMBOL-DESTRUCTURE-103
const DestructureSchema = z.object({tag: z.string()});

// Case 4: `const { data } = result` (destructuring) after `.safeParse()`
// must resolve to the same validated value as `result.data` would.
export async function destructuredResult(req: {body: unknown}, repo: Repo): Promise<void> {
  const result = DestructureSchema.safeParse(req.body);
  if (!result.success) {
    return;
  }
  const {data} = result;
  await repo.save(data);
}

// stoa:validation VC-SYMBOL-REASSIGN-104
const ReassignSchema = z.object({flag: z.boolean()});

// Case 5: the validated binding is reassigned before reaching save() — Stoa
// must not claim the ORIGINAL validated value still reaches persistence,
// since it was overwritten by something else in between.
export async function reassignedResult(req: {body: unknown}, repo: Repo): Promise<void> {
  let value: unknown = ReassignSchema.parse(req.body);
  value = {tampered: true};
  await repo.save(value);
}

class OrderService {
  constructor(private repository: Repo) {}
  // Name intentionally does NOT read like a persistence verb — only
  // resolving one hop into the body (by symbol, not by the parameter's
  // spelling) shows it ultimately saves.
  async register(data: unknown): Promise<void> {
    await this.repository.save(data);
  }
}

// stoa:validation VC-SYMBOL-PARAM-105
const ParamSchema = z.object({quantity: z.number()});

// Case 6: a validated value passed as an argument to a function whose own
// (symbol-matched, not text-matched) parameter reaches a persistence call.
export async function passedToFunction(req: {body: unknown}, orderService: OrderService): Promise<void> {
  const result = ParamSchema.parse(req.body);
  await orderService.register(result);
}

// stoa:validation VC-SYMBOL-WRONGVAR-106
const WrongVarSchema = z.object({label: z.string()});

// Case 7 (negative): a DIFFERENT variable that merely happens to be passed
// to save() in the same function as an unrelated validated `result` must
// never be treated as connected to it — req.body (never validated through
// WrongVarSchema) still reaches save() here.
export async function unrelatedVariable(req: {body: unknown}, repo: Repo): Promise<void> {
  const result = WrongVarSchema.parse(req.body);
  const other = req.body;
  await repo.save(other);
  void result;
}
