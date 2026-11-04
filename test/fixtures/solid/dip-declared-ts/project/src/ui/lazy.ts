export const later = async (): Promise<number> => (await import('../data/api.js')).load();
