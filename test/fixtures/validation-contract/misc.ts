// Edge cases: a malformed ID, an ID the contract does not define, and a shape
// Stoa cannot resolve (not a direct scalar z.number/string/boolean chain).
import {z} from 'zod';

// stoa:validation quantity_bad
const malformedId = z.number().min(1);

// stoa:validation VC-GHOST-FIELD-099
const unknownId = z.number().min(1);

// stoa:validation VC-USER-ROLE-004
const roleSchema = z.enum(['admin', 'user']);

export {malformedId, unknownId, roleSchema};
