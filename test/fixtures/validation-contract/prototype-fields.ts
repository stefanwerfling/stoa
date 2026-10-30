// Exercises prototype-safe z.object() field lookup (Object.hasOwn + a
// null-prototype fields map, not the `in` operator on a plain object): a
// field literally named "constructor", "toString" or "__proto__" must
// never be confused with an INHERITED Object.prototype property, and must
// never be silently swallowed by the `__proto__` setter either.
import {z} from 'zod';

// stoa:validation VC-PROTO-CONSTRUCTOR-201
const constructorFieldSchema = z.object({constructor: z.string()});

// stoa:validation VC-PROTO-TOSTRING-202
const toStringFieldSchema = z.object({toString: z.string()});

// stoa:validation VC-PROTO-PROTO-203
const protoFieldSchema = z.object({__proto__: z.string()});

// stoa:validation VC-PROTO-PRESENT-204
const presentFieldSchema = z.object({realField: z.string()});

// stoa:validation VC-PROTO-ABSENT-205
const absentFieldSchema = z.object({realField: z.string()});

function checkAll(input: {a: unknown; b: unknown; c: unknown; d: unknown; e: unknown}) {
  return {
    a: constructorFieldSchema.parse(input.a),
    b: toStringFieldSchema.parse(input.b),
    c: protoFieldSchema.parse(input.c),
    d: presentFieldSchema.parse(input.d),
    e: absentFieldSchema.parse(input.e)
  };
}

export {constructorFieldSchema, toStringFieldSchema, protoFieldSchema, presentFieldSchema, absentFieldSchema, checkAll};
