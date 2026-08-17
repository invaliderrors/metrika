// The shape of apps/api/test/branding.test.ts. The narrow exemption lets this
// path import branding.js — and MUST STILL reject the package bans it carries.
import { brandUnsafe } from '../src/infrastructure/persistence/branding.js';
import { withTenantContext } from '@metrika/database';

export const brand = brandUnsafe;
export const scope = withTenantContext;
