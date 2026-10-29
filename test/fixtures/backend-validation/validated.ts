// Backend handlers that DO validate their input in a recognized way — none should
// be flagged. Covers Zod, vts (wrapper + schema.validate), a manual 400 guard, a
// framework route-schema option, and a params-only handler (out of scope).
import type {FastifyInstance} from 'fastify';
import {z} from 'zod';

const ItemSchema = z.object({name: z.string(), price: z.number().min(0)});

// A vts-style schema + reply wrapper (as in real backends).
function validateBody<T>(schema: {validate(b: unknown, e: unknown[]): boolean}, body: unknown, reply: {code(n: number): {send(x: unknown): void}}): T | undefined {
  const errors: unknown[] = [];
  if (schema.validate(body, errors)) return body as T;
  reply.code(400).send({errors});
  return undefined;
}

export function routes(app: FastifyInstance, repo: {save(x: unknown): Promise<void>; get(id: string): Promise<unknown>}): void {
  // zod .parse
  app.post('/zod', async (req, reply) => {
    const data = ItemSchema.parse(req.body);
    await repo.save(data);
    return reply.send(data);
  });

  // vts wrapper that receives req.body
  app.post('/vts', async (req, reply) => {
    const data = validateBody(ItemSchema as never, req.body, reply as never);
    if (!data) return;
    await repo.save(data);
  });

  // vts schema.validate(body, errors) with body derived from req.body
  app.post('/vts2', async (req, reply) => {
    const body = req.body;
    const errors: unknown[] = [];
    if (!(ItemSchema as never as {validate(b: unknown, e: unknown[]): boolean}).validate(body, errors)) {
      return reply.code(400).send({errors});
    }
    await repo.save(body);
  });

  // manual guard that rejects bad input with 400
  app.post('/manual', async (req, reply) => {
    const body = req.body as {name?: string};
    if (!body.name) return reply.code(400).send('name required');
    await repo.save(body);
  });

  // framework route-schema option validates before the handler runs
  app.post('/schema', {schema: {body: {type: 'object'}}}, async (req, reply) => {
    await repo.save(req.body);
    return reply.send({ok: true});
  });

  // only a route param — out of scope (authorization/ownership, not a schema)
  app.get('/items/:id', async (req, reply) => {
    return reply.send(await repo.get((req.params as {id: string}).id));
  });
}
