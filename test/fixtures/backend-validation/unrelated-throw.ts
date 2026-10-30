// A throw that rejects a condition UNRELATED to the request input (a DB-lookup
// result) must not count as evidence of input validation — this is the exact
// correctness bug the follow-up spec reported: previously ANY throw anywhere in
// the handler was treated as proof of a validation guard.
interface Repo {
  findById(id: string): Promise<unknown>;
  save(x: unknown): Promise<void>;
}

// flagged: the throw is gated by `!user` (a DB-lookup result), which has no
// relationship to req.body at all — req.body still reaches save() unguarded.
export async function createUserUnrelatedThrow(req: {body: unknown; params: {id: string}}, repo: Repo): Promise<void> {
  const user = await repo.findById(req.params.id);
  if (!user) {
    throw new Error('Database operation failed');
  }
  await repo.save(req.body);
}

// not flagged: the throw IS gated by a condition that directly inspects
// req.body — a genuine (if manual) input check.
export async function createUserDirectGuard(req: {body: {name?: string}}, repo: Repo): Promise<void> {
  if (!req.body.name) {
    throw new Error('name required');
  }
  await repo.save(req.body);
}

// not flagged: the throw is gated by a condition on `body`, a direct whole-
// object alias of req.body (not a downstream computation) — still a genuine
// input check despite the indirection.
export async function createUserAliasedGuard(req: {body: {name?: string}}, repo: Repo): Promise<void> {
  const body = req.body;
  if (!body.name) {
    throw new Error('name required');
  }
  await repo.save(body);
}
