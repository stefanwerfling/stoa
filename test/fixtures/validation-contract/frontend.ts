// A frontend-side schema for the same business rules the backend enforces.
import {z} from 'zod';

// stoa:validation VC-ITEM-QUANTITY-001
const quantitySchema = z.number().int().min(1).max(100);

// stoa:validation VC-ITEM-PRICE-002
const priceSchema = z.number().min(1);

// Exercises both schemas with plain (non-request) local input so this fixture
// demonstrates only the mismatch/conflict checks, not "unused validator" (see
// usage.ts for that — a dedicated, isolated fixture).
function validateForm(input: {quantity: number; price: number}): {quantity: number; price: number} {
  return {quantity: quantitySchema.parse(input.quantity), price: priceSchema.parse(input.price)};
}

export {quantitySchema, priceSchema, validateForm};
