// Golden-corpus group 8/14: cross-function data handoffs (both a VALIDATED
// value traced one hop to persistence, and a RAW value doing the same), and
// mass assignment via a spread of the raw payload.
import {z} from 'zod';

interface Repo {
  save(x: unknown): Promise<void>;
}

class OrderService {
  constructor(private repository: Repo) {}
  // Name intentionally does NOT read like a persistence verb — only
  // resolving one hop into the body shows it ultimately saves.
  async register(data: unknown): Promise<void> {
    await this.repository.save(data);
  }
}

// Group 8 (good path): the validated value is handed off through ONE
// cross-function hop before reaching persistence — traced as `heuristic` in
// the Evidence Graph fact, and correctly produces NO finding (a confirmed
// chain, not a gap).
// stoa:validation VC-CORPUS-CROSS-FUNCTION-106
const noteSchema = z.object({note: z.string()});
export async function createNoteCrossFunction(req: {body: unknown}, orderService: OrderService): Promise<void> {
  const result = noteSchema.safeParse(req.body);
  if (!result.success) {
    return;
  }
  await orderService.register(result.data);
}

// Group 8 (bad path): the RAW payload — never validated — is handed off
// through the SAME kind of cross-function hop; this one must be flagged.
export async function createOrderCrossFunctionRaw(req: {body: unknown}, orderService: OrderService): Promise<void> {
  await orderService.register(req.body);
}

// Group 14: the raw payload is spread into an object literal passed to a
// persistence call — not passed whole, but every one of its keys still
// flows in unvalidated.
export async function createOrderSpread(req: {body: unknown}, repo: Repo): Promise<void> {
  await repo.save({...(req.body as Record<string, unknown>), createdAt: new Date(0)});
}
