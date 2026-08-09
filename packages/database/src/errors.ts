export class HardDeleteForbiddenError extends Error {
  constructor(readonly model: string) {
    super(
      `${model} is soft-deletable: use update({ data: { deletedAt: new Date() } }) instead of delete(). ` +
        'Hard-deleting it would orphan history that other records still point at — see docs/DOMAIN_MODEL.md §6.',
    );
    this.name = 'HardDeleteForbiddenError';
  }
}
