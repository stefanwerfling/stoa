// Raw request payload flowing whole into Object.assign or a persistence call.
import type {FastifyInstance} from 'fastify';

type Entity = {id: string; name: string; role: string};

export function routes(app: FastifyInstance, repo: {save(x: unknown): Promise<void>; update(id: string, x: unknown): Promise<void>}, entity: Entity): void {
  // flagged: Object.assign fed the raw req.body
  app.post('/assign', async (req, reply) => {
    Object.assign(entity, req.body);
    return reply.send(entity);
  });

  // flagged: raw req.body passed directly to a persistence call
  app.post('/direct', async (req, reply) => {
    await repo.save(req.body);
    return reply.send({ok: true});
  });

  // flagged: raw req.body spread into an object literal passed to a persistence call
  app.put('/spread/:id', async (req, reply) => {
    await repo.update((req.params as {id: string}).id, {...(req.body as Record<string, unknown>)});
    return reply.send({ok: true});
  });
}
