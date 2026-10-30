// Golden-corpus group 3/4/6/7/12: whether an annotated validator is actually
// WIRED IN, not just declared — unused, called-but-ignored, validation
// living in a function that is never called, and an AST-verified alias.
import {z} from 'zod';

interface Repo {
  save(x: unknown): Promise<void>;
}

// Group 3: declared, annotated, resolvable — but .parse()/.safeParse() is
// never called on it anywhere in this file.
// stoa:validation VC-CORPUS-UNUSED-101
const unusedSchema = z.object({quantity: z.number()});

// Group 4/6: the validator IS called and fed the request, but the SAME
// function still routes the untouched raw body into persistence — the
// validation ran, but did not gate what actually got saved.
// stoa:validation VC-CORPUS-RAW-REUSE-102
const rawReuseSchema = z.object({comment: z.string()});
export async function createCommentRawReuse(req: {body: {comment: unknown}}, repo: Repo): Promise<void> {
  rawReuseSchema.parse(req.body.comment);
  await repo.save(req.body);
}

// Group 7: validateNote exists, is a genuine validator — but
// createNoteValidatorElsewhere below never calls it. A validator existing
// SOMEWHERE in the file must not be mistaken for proof that THIS handler
// validates its own input.
function validateNote(body: unknown): unknown {
  return z.object({note: z.string()}).parse(body);
}

export async function createNoteValidatorElsewhere(req: {body: unknown}, repo: Repo): Promise<void> {
  await repo.save(req.body);
}

// Group 12: an AST-verified `.bind()` alias, reached by a verified AST
// relationship, not by a name heuristic ("boundValidate" matches no
// validate/parse/assert/ensure/check/guard prefix).
const TagSchema = z.object({label: z.string()});
const boundValidate = TagSchema.safeParse.bind(TagSchema);

export async function createTagViaAlias(req: {body: unknown}, repo: Repo): Promise<void> {
  const result = boundValidate(req.body);
  if (!result.success) {
    return;
  }
  await repo.save(result.data);
}

export {validateNote, unusedSchema};
