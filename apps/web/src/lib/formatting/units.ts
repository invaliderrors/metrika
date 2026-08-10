import type { SupportedLocale } from '../../config/env';

const decimal = (locale: SupportedLocale, maximumFractionDigits: number) =>
  new Intl.NumberFormat(locale, { maximumFractionDigits });

/** Millimetres, because every length in this system is millimetres. */
export function formatLengthMm(lengthMm: number, locale: SupportedLocale): string {
  return `${decimal(locale, 1).format(lengthMm)} mm`;
}

export function formatMassG(massG: number, locale: SupportedLocale): string {
  return `${decimal(locale, 2).format(massG)} g`;
}

/**
 * Locale-independent by design: "1 h 30 min" is what an operator reads off a
 * job card, and `Intl.DurationFormat` is not available everywhere this runs.
 * Seconds are never shown — a print time in seconds is unreadable and invites
 * false precision about an estimate.
 *
 * Two edges are decided here rather than left to fall out of the arithmetic,
 * because both fell out WRONG:
 *
 *   - SUB-MINUTE. `formatDurationS(29)` is `"0 min"`, and that is the intended
 *     answer, not a gap. This function's contract is minute resolution; "0 min"
 *     is the honest rendering of twenty-nine seconds at that resolution. The
 *     tempting alternative, `"< 1 min"`, is English copy with a symbol in it,
 *     inside a function that deliberately takes no locale — it would be the
 *     first untranslatable string in the UI.
 *
 *   - NEGATIVE. The sign is factored out and applied ONCE. Left to the raw
 *     arithmetic, `-600` produced `"-1 h -10 min"`: `Math.floor(-10 / 60)` is
 *     -1, not 0, and `-10 % 60` is -10, so the hours branch fires and both
 *     components carry a minus. A negative print time is a defect upstream and
 *     this function does not hide it — it renders `"-10 min"`, which is exactly
 *     what it was handed, rather than a second minus sign it was not.
 *
 * `String(...)` around each component rather than bare interpolation:
 * `strictTypeChecked` sets `restrict-template-expressions` with
 * `allowNumber: false`, so a number in a template is a lint error here.
 */
export function formatDurationS(durationS: number): string {
  const sign = durationS < 0 ? '-' : '';
  const totalMinutes = Math.round(Math.abs(durationS) / 60);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${sign}${String(minutes)} min`;
  if (minutes === 0) return `${sign}${String(hours)} h`;
  return `${sign}${String(hours)} h ${String(minutes)} min`;
}
