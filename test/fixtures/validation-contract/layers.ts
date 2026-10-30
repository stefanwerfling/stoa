// Exercises layer/security attribution (src/rules/project/ValidationContractRule.ts's
// layerAndSecurityAttribution): a contract's "layers"/"security" fields are a
// CLAIM, not proof — Stoa only confirms backend attribution when the
// annotated schema is actually shown fed by request-handling data (the same
// evidence the Validator Dataflow Analysis produces).
import {z} from 'zod';

// stoa:validation VC-LAYER-ATTRIBUTED-021
const AttributedSchema = z.object({name: z.string()});

// stoa:validation VC-LAYER-UNATTRIBUTED-022
const UnattributedSchema = z.object({note: z.string()});

// stoa:validation VC-LAYER-SECURITY-UNVERIFIED-023
const SecuritySchema = z.object({tag: z.string()});

// stoa:validation VC-LAYER-FRONTEND-ONLY-024
const FrontendOnlySchema = z.object({label: z.string()});

interface Repo {
  save(data: unknown): Promise<void>;
}

// Backend attribution CONFIRMED: parsed directly from req.body.
export async function attributedHandler(req: {body: unknown}, repo: Repo): Promise<void> {
  const data = AttributedSchema.parse(req.body);
  await repo.save(data);
}

// Annotated and actually invoked — but NEVER shown fed by request data (a
// local literal, not req.*). The contract claims this applies to the
// backend; Stoa cannot confirm it from this evidence.
export function unattributedUsage(): unknown {
  return UnattributedSchema.parse({note: 'fixed-at-build-time'});
}

// Same shape as `unattributedUsage`: annotated, invoked, but never fed by
// the request — this time the contract declares the structured
// `security.serverSideValidation` flag instead of (or alongside) `layers`.
export function securityUsage(): unknown {
  return SecuritySchema.parse({tag: 'fixed-at-build-time'});
}

// Annotated and invoked only on a local literal — fine, because the
// contract declares ONLY the frontend layer for this id, which Stoa never
// checks.
export function frontendOnlyUsage(): unknown {
  return FrontendOnlySchema.parse({label: 'fixed-at-build-time'});
}
