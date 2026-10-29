// Backend handlers that read client input without any recognized validation.
import type {FastifyInstance} from 'fastify';

export function routes(app: FastifyInstance, repo: {save(x: unknown): Promise<void>; find(q: unknown): Promise<unknown>}): void {
  // flagged: reads req.body and persists it, no validation of any kind
  app.post('/items', async (req, reply) => {
    const data = req.body as {name: string; price: number};
    await repo.save(data);
    return reply.send({ok: true});
  });

  // flagged: passes the whole req.query object on, no validation
  app.get('/search', async (req, reply) => {
    const filters = req.query as Record<string, string>;
    return reply.send(await repo.find(filters));
  });

  // not flagged: a single-field pluck (an id lookup) is out of scope
  app.get('/item', async (req, reply) => {
    const id = (req.query as {id: string}).id;
    return reply.send(await repo.find(id));
  });
}
