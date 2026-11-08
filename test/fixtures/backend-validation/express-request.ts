// A file that imports its own `Request` (Express): `request.body` is the
// parsed client payload, so the annotation does not make it a Fetch request.
import type {Request, Response} from 'express';

declare const repo: {save(x: unknown): Promise<void>};

// flagged: Express request body persisted without validation
export const create = async (request: Request, res: Response): Promise<void> => {
  const data = request.body as {name: string};
  await repo.save(data);
  res.send({ok: true});
};
