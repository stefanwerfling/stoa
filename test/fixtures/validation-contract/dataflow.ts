// Exercises the validator dataflow tracer (src/analysis/typescript/ValidationDataflow.ts):
// where the VALIDATED value goes after a validator call, not just whether the
// call happened. Uses z.object(...) schemas on purpose — the realistic shape
// for a request body — which the scalar-chain resolver (ValidationAnnotations.ts)
// never resolves (R-VALIDATION-CONTRACT-UNRESOLVED fires for the shape check
// independently; that is expected and unrelated to the dataflow trace below).
import {z} from 'zod';

// stoa:validation VC-DATAFLOW-SAME-FUNCTION-017
const SameFunctionSchema = z.object({name: z.string()});

// stoa:validation VC-DATAFLOW-ONE-HOP-018
const OneHopSchema = z.object({note: z.string()});

// stoa:validation VC-DATAFLOW-UNRESOLVED-019
const UnresolvedSchema = z.object({tag: z.string()});

// Annotated for the dataflow tracer only (no matching contract.json entry —
// this scenario is checked directly at the fact level in
// test/ValidationDataflow.test.ts, which does not need a loaded contract).
// stoa:validation VC-DATAFLOW-NO-SINK-020
const NoSinkSchema = z.object({flag: z.boolean()});

interface Repo {
  save(data: unknown): Promise<void>;
}

class OrderService {
  constructor(private repository: Repo) {}
  // Name intentionally does NOT read like a persistence verb — only
  // resolving one hop into the body shows it ultimately saves.
  async register(data: unknown): Promise<void> {
    await this.repository.save(data);
  }
  // Resolvable one hop, but genuinely does nothing persistence-related —
  // nothing further should be reported past the validated value.
  async log(data: unknown): Promise<void> {
    console.log(data);
  }
}

declare const externalRepository: {commit(data: unknown): void};

// Traced and fully resolved within this one function: the validated value is
// a direct argument of a persistence-verb call in the SAME function.
export async function sameFunctionPersist(req: {body: unknown}, repo: Repo): Promise<void> {
  const data = SameFunctionSchema.parse(req.body);
  await repo.save(data);
}

// Traced one hop: OrderService.register's own name gives no hint, but its
// body resolves to this.repository.save(data).
export async function oneHopPersist(req: {body: unknown}, orderService: OrderService): Promise<void> {
  const result = OneHopSchema.safeParse(req.body);
  if (!result.success) {
    return;
  }
  await orderService.register(result.data);
}

// Not traceable beyond this function: externalRepository has no resolvable
// implementation in this file, but its name reads like a persistence layer.
export async function unresolvedDestination(req: {body: unknown}): Promise<void> {
  const data = UnresolvedSchema.parse(req.body);
  await externalRepository.commit(data);
}

// Resolvable one hop (OrderService.log is declared right here), but its body
// has no persistence call at all — nothing further to trace, and nothing
// should be fabricated.
export async function resolvableNoSink(req: {body: unknown}, orderService: OrderService): Promise<void> {
  const result = NoSinkSchema.safeParse(req.body);
  if (!result.success) {
    return;
  }
  await orderService.log(result.data);
}
