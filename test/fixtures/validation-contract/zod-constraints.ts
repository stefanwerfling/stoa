// Exercises the fuller Zod modifier modeling: .int(), .positive(),
// .nonnegative(), .email() and .url() each have an explicit, modeled effect —
// none is a silent no-op.
import {z} from 'zod';

// Mismatch: the contract requires an integer; this schema accepts any number.
// stoa:validation VC-STOCK-COUNT-009
const stockSchema = z.number().min(0);

// Match: .nonnegative() (inclusive min 0) + max 100 exactly matches the
// contract's declared min/max — no finding.
// stoa:validation VC-DISCOUNT-PERCENT-010
const discountSchema = z.number().nonnegative().max(100);

// Mismatch: the contract's min=0 is inclusive (0 is a valid, unrated score),
// but .positive() excludes exactly 0 — stricter than the business rule allows.
// stoa:validation VC-RATING-SCORE-011
const ratingSchema = z.number().positive();

// Mismatch: the contract requires a URL format; this schema validates an
// email format instead.
// stoa:validation VC-WEBSITE-URL-012
const websiteSchema = z.string().email();

// Match: multiple .max() calls AND together like multiple .min() sources — the
// smallest value (50) wins regardless of chain order, exactly matching the
// contract's max=50. Before the fix, the LAST .max() in the chain silently
// overwrote the earlier, tighter one.
// stoa:validation VC-COUPON-CAP-014
const couponSchema = z.number().min(0).max(100).max(50);

// Unresolved: .min(10).max(5) is an impossible range — no value can satisfy
// both bounds at once — so this is reported as unresolved rather than
// silently picking one bound and hiding the conflict.
// stoa:validation VC-IMPOSSIBLE-RANGE-015
const impossibleSchema = z.number().min(10).max(5);

// Match: chaining .email().url() means the value must satisfy BOTH checks
// (Zod ANDs them) — the contract only requires "email", and email is among
// the formats this schema enforces, so the extra .url() narrows further
// rather than conflicting. Before the fix, the LAST format modifier silently
// overwrote the earlier one.
// stoa:validation VC-CONTACT-HANDLE-016
const contactSchema = z.string().email().url();

// Field-by-field z.object() resolution: the contract names exactly ONE field
// per Validation Trace ID (contractRule.field); Stoa resolves that one field
// the same way a top-level scalar chain would be, without resolving or
// guessing at the rest of the object's shape.

// Match: the object as a WHOLE is never a scalar chain (so `resolved` stays
// false), but its one contract-named field ("sku") resolves cleanly and
// matches exactly — no finding, same as a matching bare scalar schema would
// produce.
// stoa:validation VC-OBJECT-FIELD-MATCH-025
const orderSchema = z.object({sku: z.string().min(1), quantity: z.number()});

// Mismatch: the contract's field "price" requires non-negative, but this
// object's "price" field has no lower bound at all.
// stoa:validation VC-OBJECT-FIELD-MISMATCH-026
const productSchema = z.object({price: z.number(), label: z.string()});

// Unresolved: the contract names a field ("missingField") that this object
// does not declare at all — Stoa must not silently treat an absent field as
// "no constraint" or guess at one; it stays unresolved, naming the field.
// stoa:validation VC-OBJECT-FIELD-ABSENT-027
const partialSchema = z.object({otherField: z.string()});

// Unresolved: the contract-named field ("note") exists, but its OWN value
// uses .refine() — not a recognized scalar chain — so just that field stays
// unresolved, the same as a top-level .refine() schema would.
// stoa:validation VC-OBJECT-FIELD-UNRESOLVED-028
const feedbackSchema = z.object({note: z.string().refine((value) => value.length > 0)});

// Plain (non-request) local usage so none of the above is also flagged as an
// unused validator — this fixture is only about the constraint comparisons.
function checkInventory(input: {stock: number; discount: number; rating: number; website: string; coupon: number; impossible: number; contact: string}) {
  return {
    stock: stockSchema.parse(input.stock),
    discount: discountSchema.parse(input.discount),
    rating: ratingSchema.parse(input.rating),
    website: websiteSchema.parse(input.website),
    coupon: couponSchema.parse(input.coupon),
    impossible: impossibleSchema.parse(input.impossible),
    contact: contactSchema.parse(input.contact)
  };
}

function checkObjects(input: {order: unknown; product: unknown; partial: unknown; feedback: unknown}) {
  return {
    order: orderSchema.parse(input.order),
    product: productSchema.parse(input.product),
    partial: partialSchema.parse(input.partial),
    feedback: feedbackSchema.parse(input.feedback)
  };
}

export {
  stockSchema, discountSchema, ratingSchema, websiteSchema, couponSchema, impossibleSchema, contactSchema, checkInventory,
  orderSchema, productSchema, partialSchema, feedbackSchema, checkObjects
};
