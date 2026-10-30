// Exercises the incremental z.object() support: object-level modifiers
// (.strict()/.partial()/.extend()/.merge()), plus explicit confirmation of
// what stays safely unresolved rather than guessed at (spread, shorthand,
// computed property names, nested objects, an array of objects).
import {z} from 'zod';

// Match: .strict() does not change the field set at all.
// stoa:validation VC-SHAPE-STRICT-301
const strictSchema = z.object({name: z.string()}).strict();

// Match: .partial() makes every field optional, including ones not marked
// .optional() in the literal — the contract declares required=false.
// stoa:validation VC-SHAPE-PARTIAL-302
const partialSchema = z.object({name: z.string()}).partial();

// Match: .extend({...}) adds a field; the contract names the EXTENDED
// field, not one from the base shape.
const baseForExtend = z.object({id: z.string()});
// stoa:validation VC-SHAPE-EXTEND-303
const extendedSchema = baseForExtend.extend({quantity: z.number().min(1)});

// Match: .merge(<inline z.object(...)>) — the contract names a field from
// the MERGED-IN inline schema.
// stoa:validation VC-SHAPE-MERGE-INLINE-304
const mergeInlineSchema = z.object({id: z.string()}).merge(z.object({amount: z.number().min(5)}));

// Match: .merge(<identifier>) — the contract names a field from the
// REFERENCED schema (the realistic shape: a shared, separately-declared
// schema merged in by name), resolved via ONE identifier hop.
const sharedFields = z.object({tag: z.string().min(1)});
// stoa:validation VC-SHAPE-MERGE-REF-305
const mergeRefSchema = z.object({id: z.string()}).merge(sharedFields);

// Match: a field explicitly marked .optional() already worked before this
// round (resolveZodConditions recognizes .optional() like any top-level
// scalar chain) — confirmed here, not newly implemented.
// stoa:validation VC-SHAPE-OPTIONAL-306
const optionalFieldSchema = z.object({nickname: z.string().optional()});

// Unresolved: an unrecognized object-level modifier after z.object({...})
// (anything other than strict/partial/extend/merge) stays unresolved,
// never guessed at.
// stoa:validation VC-SHAPE-UNKNOWN-MODIFIER-307
const unknownModifierSchema = z.object({name: z.string()}).readonly();

// Unresolved: a spread-introduced field is not statically resolvable in
// general — the field is simply absent from the map (reported as "not
// found"), not guessed at.
const spreadBase = {extra: z.string()};
// stoa:validation VC-SHAPE-SPREAD-308
const spreadSchema = z.object({...spreadBase, name: z.string()});

// Unresolved: a nested z.object() field is itself not a scalar chain, so
// the OUTER field ("address") resolves to null (present, but not a
// recognized scalar chain) — dotted/nested paths are not attempted.
// stoa:validation VC-SHAPE-NESTED-309
const nestedSchema = z.object({address: z.object({city: z.string()})});

// Unresolved: z.array(z.object({...})) is not a bare z.object() at the top
// level at all — stays fully unresolved, same as before this round.
// stoa:validation VC-SHAPE-ARRAY-310
const arraySchema = z.array(z.object({name: z.string()}));

function checkAll(input: {a: unknown; b: unknown; c: unknown; d: unknown; e: unknown; f: unknown; g: unknown; h: unknown; i: unknown; j: unknown}) {
  return {
    a: strictSchema.parse(input.a),
    b: partialSchema.parse(input.b),
    c: extendedSchema.parse(input.c),
    d: mergeInlineSchema.parse(input.d),
    e: mergeRefSchema.parse(input.e),
    f: optionalFieldSchema.parse(input.f),
    g: unknownModifierSchema.parse(input.g),
    h: spreadSchema.parse(input.h),
    i: nestedSchema.parse(input.i),
    j: arraySchema.parse(input.j)
  };
}

export {
  strictSchema, partialSchema, baseForExtend, extendedSchema, mergeInlineSchema, sharedFields, mergeRefSchema,
  optionalFieldSchema, unknownModifierSchema, spreadSchema, nestedSchema, arraySchema, checkAll
};
