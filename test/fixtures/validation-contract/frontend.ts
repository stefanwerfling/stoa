// A frontend-side schema for the same business rules the backend enforces.
import {z} from 'zod';

// stoa:validation VC-ITEM-QUANTITY-001
const quantitySchema = z.number().int().min(1).max(100);

// stoa:validation VC-ITEM-PRICE-002
const priceSchema = z.number().min(1);

export {quantitySchema, priceSchema};
