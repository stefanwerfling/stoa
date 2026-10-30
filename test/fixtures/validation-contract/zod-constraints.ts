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

// Plain (non-request) local usage so none of the above is also flagged as an
// unused validator — this fixture is only about the constraint comparisons.
function checkInventory(input: {stock: number; discount: number; rating: number; website: string}) {
  return {
    stock: stockSchema.parse(input.stock),
    discount: discountSchema.parse(input.discount),
    rating: ratingSchema.parse(input.rating),
    website: websiteSchema.parse(input.website)
  };
}

export {stockSchema, discountSchema, ratingSchema, websiteSchema, checkInventory};
