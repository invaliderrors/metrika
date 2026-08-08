// deliberate CI-gate test file: proves the "Reject @ts-ignore" workflow step fires on
// a real GNU-grep runner. Placed directly under packages/ (not inside any package's
// own src/test tree) so it is not compiled, linted, or coverage-measured by any package's
// own tooling -- only the CI grep step should ever touch it. Reverted in the next commit.
// @ts-ignore
export const __ciGateProbe = 1;
