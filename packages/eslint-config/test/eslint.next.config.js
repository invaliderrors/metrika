import { next } from '../src/next.js';

// The literal must stay equal to apps/web's `react` pin (ADR-0021's table).
// The two moving together is the whole point of obligation 3's fixture.
/** @type {import('eslint').Linter.Config[]} */
const config = next({ reactVersion: '19.2.8' });

export default config;
