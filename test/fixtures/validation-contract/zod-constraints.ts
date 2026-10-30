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

export {stockSchema, discountSchema, ratingSchema, websiteSchema, couponSchema, impossibleSchema, contactSchema, checkInventory};
