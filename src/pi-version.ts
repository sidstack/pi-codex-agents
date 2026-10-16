/** Patch releases share the guarded native adapter contract; new minors need validation. */
export const PI_VERSION_RANGE = ">=1.3.0 <1.4.0";
export function supportedPiVersion(version: string): boolean {
  return /^1\.3\.(0|[1-9]\d*)$/.test(version);
}
