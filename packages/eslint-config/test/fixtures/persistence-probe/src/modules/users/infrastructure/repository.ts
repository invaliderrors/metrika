// ADR-0041 answer (b): a module's repositories live here, per
// docs/ARCHITECTURE.md, and this path is exempt. ACCEPTED.
import { withTenantContext } from '@metrika/database';

export const scope = withTenantContext;
