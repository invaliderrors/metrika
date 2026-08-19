// `brandUnsafe` outside a persistence zone. REJECTED — ADR-0018's guarantee is
// that a branded id cannot be minted from a bare string anywhere it is reachable.
import { brandUnsafe } from '../../../infrastructure/persistence/branding.js';

export const brand = brandUnsafe;
