export function scratchPath(): string {
  return `${__dirname}/${String(Buffer.byteLength('x'))}`;
}
