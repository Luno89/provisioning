import { stampNever } from './clocked.js';

const given: (() => string) | undefined = undefined;

export const stampedNever = (): string => stampNever({ never: given ?? (() => 'later') });
