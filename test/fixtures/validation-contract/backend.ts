// A backend-side schema for the same business rules the frontend enforces.
import {z} from 'zod';

// stoa:validation VC-ITEM-QUANTITY-001
const quantitySchema = z.number().int().min(1).max(100);

// stoa:validation VC-ITEM-PRICE-002
const priceSchema = z.number().min(0);

// stoa:validation VC-EMAIL-FORMAT-003
const emailSchema = z.string().trim().toLowerCase().email();

// Exercises all three schemas with plain (non-request) local input so this
// fixture demonstrates only the mismatch/conflict checks, not "unused
// validator" (see usage.ts for that).
function validateOrder(input: {quantity: number; price: number; email: string}): {quantity: number; price: number; email: string} {
  return {
    quantity: quantitySchema.parse(input.quantity),
    price: priceSchema.parse(input.price),
    email: emailSchema.parse(input.email)
  };
}

export {quantitySchema, priceSchema, emailSchema, validateOrder};
