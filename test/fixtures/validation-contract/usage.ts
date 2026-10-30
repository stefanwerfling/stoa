// Validator usage tracing: an annotated schema that is declared but never
// invoked, one that is invoked and whose validated result is what actually
// gets saved (no finding), and one that is invoked but a raw copy of the
// request body still reaches a persistence sink regardless of the
// validation having run.
import {z} from 'zod';

interface Repo {
  save(x: unknown): Promise<void>;
}

// stoa:validation VC-ORDER-QTY-006
const unusedSchema = z.number().int().min(1).max(100);

// Never calls .parse()/.safeParse() on unusedSchema anywhere in this file —
// the annotated validator exists but is not wired into this handler.
export async function createOrderUnvalidated(req: {body: {quantity: unknown}}, repo: Repo): Promise<void> {
  const rawQuantity = req.body.quantity;
  await repo.save({quantity: rawQuantity});
}

// stoa:validation VC-ORDER-NOTE-007
const validatedSchema = z.string().trim();

// Good: the validated result (not the raw field) is what gets saved.
export async function createOrderValidated(req: {body: {note: unknown}}, repo: Repo): Promise<void> {
  const note = validatedSchema.parse(req.body.note);
  await repo.save({note});
}

// stoa:validation VC-ORDER-COMMENT-008
const rawReuseSchema = z.string().trim();

// Validation runs on the comment field, but the whole raw body is also saved
// separately — the check has no effect on what actually gets persisted.
export async function createOrderRawReuse(req: {body: {comment: unknown}}, repo: Repo): Promise<void> {
  const comment = rawReuseSchema.parse(req.body.comment);
  console.log('validated comment length', comment.length);
  await repo.save(req.body);
}
