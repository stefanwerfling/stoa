// Three synchronize variants: literal true and `?? true` are flagged; false is not.
export const explicitTrue = {synchronize: true};
export const defaultTrue = {synchronize: globalThis.SYNC ?? true};
export const safe = {synchronize: false};
