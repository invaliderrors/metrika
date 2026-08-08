type Shape = { kind: 'circle' } | { kind: 'square' };
export function area(shape: Shape): number {
  switch (shape.kind) {
    case 'circle':
      return 1;
  }
  return 0;
}
