// Golden-corpus group 15: structured security requirements Stoa's fact
// model has no way to verify (no session/auth/tenant modeling exists) must
// produce NO finding either way — their absence from a finding list is NOT
// confirmation they are met. Only `serverSideValidation` has a real static
// signal (checked via R-VALIDATION-CONTRACT-SECURITY-UNVERIFIED, exercised
// separately in test/ValidationContract.test.ts; this fixture is specifically
// about the OTHER five flags staying silent).
import {z} from 'zod';

interface Repo {
  save(x: unknown): Promise<void>;
}

// stoa:validation VC-CORPUS-SECURITY-UNCHECKED-107
const transferSchema = z.object({amount: z.number()});

// The contract for VC-CORPUS-SECURITY-UNCHECKED-107 declares
// authenticationRequired/ownershipRequired/tenantIsolation/
// massAssignmentProtection — none of which Stoa checks — AND is backend-
// attributed (fed by req.body), so no LAYER/SECURITY finding fires either.
export async function transferFunds(req: {body: unknown}, repo: Repo): Promise<void> {
  const data = transferSchema.parse(req.body);
  await repo.save(data);
}
