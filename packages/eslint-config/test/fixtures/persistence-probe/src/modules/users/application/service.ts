// One segment outside the exemption — `*` matches a single path segment, so
// `modules/users/application/` is not `modules/users/infrastructure/`. REJECTED.
import { withTenantContext } from '@metrika/database';

export const scope = withTenantContext;
