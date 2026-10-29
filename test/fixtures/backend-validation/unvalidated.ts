// Backend handlers that read client input without any recognized validation.
import type {FastifyInstance} from 'fastify';

export function routes(app: FastifyInstance, repo: {save(x: unknown): Promise<void>; find(q: string): Promise<unknown>}): void {
  // flagged: reads req.body and persists it, no validation of any kind
  app.post('/items', async (req, reply) => {
    const data = req.body as {name: string; price: number};
    await repo.save(data);
    return reply.send({ok: true});
  });

  // flagged: reads req.query and uses it, no validation
  app.get('/search', async (req, reply) => {
    const term = (req.query as {term: string}).term;
    return reply.send(await repo.find(term));
  });
}
