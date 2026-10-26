// Positive: reaches past the public entry into another module's internals.
import {secret} from '../internal/secret.js';

export const exposed = secret;
