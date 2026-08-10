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
 * `String(...)` around each component rather than bare interpolation:
 * `strictTypeChecked` sets `restrict-template-expressions` with
 * `allowNumber: false`, so a number in a template is a lint error here.
 */
export function formatDurationS(durationS: number): string {
  const totalMinutes = Math.round(durationS / 60);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${String(minutes)} min`;
  if (minutes === 0) return `${String(hours)} h`;
  return `${String(hours)} h ${String(minutes)} min`;
}
