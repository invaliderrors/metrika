import type { z } from 'zod';
import { brandedUuid } from './brand.js';

export const UserId = brandedUuid('UserId');
export const OrganizationId = brandedUuid('OrganizationId');
export const ProjectId = brandedUuid('ProjectId');
export const ModelId = brandedUuid('ModelId');
export const ModelVersionId = brandedUuid('ModelVersionId');
export const QuoteId = brandedUuid('QuoteId');
export const OrderId = brandedUuid('OrderId');
export const SliceJobId = brandedUuid('SliceJobId');
export const PrintJobId = brandedUuid('PrintJobId');
export const MaterialId = brandedUuid('MaterialId');
export const PrinterProfileVersionId = brandedUuid('PrinterProfileVersionId');

export type UserId = z.infer<typeof UserId>;
export type OrganizationId = z.infer<typeof OrganizationId>;
export type ProjectId = z.infer<typeof ProjectId>;
export type ModelId = z.infer<typeof ModelId>;
export type ModelVersionId = z.infer<typeof ModelVersionId>;
export type QuoteId = z.infer<typeof QuoteId>;
export type OrderId = z.infer<typeof OrderId>;
export type SliceJobId = z.infer<typeof SliceJobId>;
export type PrintJobId = z.infer<typeof PrintJobId>;
export type MaterialId = z.infer<typeof MaterialId>;
export type PrinterProfileVersionId = z.infer<typeof PrinterProfileVersionId>;
