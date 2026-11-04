import type {Dto} from '../data/types.js';
export {type Dto as Data} from '../data/types.js';

export const show = (dto: Dto): number => dto.id;
