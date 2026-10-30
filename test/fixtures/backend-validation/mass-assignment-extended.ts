// Phase 5 extensions to R-VALIDATION-MASS-ASSIGNMENT: a direct property
// assignment tainting an object later saved, a raw value passed through one
// cross-function hop to a persistence call, and the narrow ORM-specific
// "merge" verb addition.
import type {FastifyInstance} from 'fastify';

interface Entity {
  data?: unknown;
}

interface Repo {
  save(x: unknown): Promise<void>;
  merge(target: unknown, source: unknown): unknown;
}

class UserService {
  constructor(private repository: Repo) {}
  // Name intentionally does NOT read like a persistence verb — only
  // resolving one hop into the body shows it ultimately saves.
  async register(data: unknown): Promise<void> {
    await this.repository.save(data);
  }
}

export function routes(app: FastifyInstance, repo: Repo, userService: UserService): void {
  // flagged: a direct assignment taints `entity`, which is then saved whole —
  // not a `const x = req.body` alias, a plain property assignment instead.
  app.post('/direct-assignment', async (req, reply) => {
    const entity: Entity = {};
    entity.data = req.body;
    await repo.save(entity);
    return reply.send(entity);
  });

  // flagged: the raw request payload is passed through ONE cross-function
  // hop (userService.register's own name gives no hint) before reaching a
  // persistence-verb call inside that method's own body.
  app.post('/one-hop', async (req, reply) => {
    await userService.register(req.body);
    return reply.send({ok: true});
  });

  // flagged: TypeORM-style repository.merge(entity, req.body) copies the raw
  // payload onto `entity` directly, via the newly-included "merge" verb.
  app.post('/merge', async (req, reply) => {
    const entity: Entity = {};
    repo.merge(entity, req.body);
    return reply.send(entity);
  });

  // not flagged: a direct assignment of a SINGLE plucked field (not the
  // whole raw payload) is not a mass-assignment risk — the existing
  // single-field scope restriction still applies.
  app.post('/single-field-assignment', async (req, reply) => {
    const entity: Entity = {};
    entity.data = (req.body as {name?: string}).name;
    await repo.save(entity);
    return reply.send(entity);
  });
}
