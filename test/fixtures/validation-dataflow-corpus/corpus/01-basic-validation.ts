// Golden-corpus group 1/2/5/13: the baseline request -> validation ->
// persistence chain, both correctly done and genuinely missing, plus the
// Phase 1.1 correctness-fix regression (a throw unrelated to the request
// must not count as a validation guard).
import {z} from 'zod';

interface Repo {
  findById(id: string): Promise<unknown>;
  save(x: unknown): Promise<void>;
}

const ItemSchema = z.object({name: z.string()});

// Group 1 + 5: correct Zod validation, and the validated result (not the
// raw body) is what gets saved — the positive baseline. No finding.
export async function createItemValidated(req: {body: unknown}, repo: Repo): Promise<void> {
  const data = ItemSchema.parse(req.body);
  await repo.save(data);
}

// Group 2: missing backend validation — req.body read, saved raw, nothing
// resembling a validator anywhere in the function.
export async function createItemNoValidation(req: {body: unknown}, repo: Repo): Promise<void> {
  await repo.save(req.body);
}

// Group 13: a generic exception gated by a condition UNRELATED to the
// request (a DB lookup) must not be mistaken for an input-validation guard —
// req.body still reaches save() unguarded.
export async function createItemUnrelatedThrow(req: {body: unknown; params: {id: string}}, repo: Repo): Promise<void> {
  const owner = await repo.findById(req.params.id);
  if (!owner) {
    throw new Error('owner not found');
  }
  await repo.save(req.body);
}
