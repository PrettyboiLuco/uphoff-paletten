import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { Temporal } from '@js-temporal/polyfill';
import type { StoredEvent } from '../domain/types';
import { PALLET_TYPES } from '../ui/config';
import {
  BUSINESS_TIME_ZONE,
  berlinDateKey,
  dayRangeForKey,
  statisticsForRange,
  type TimeRange,
} from '../statistics/statistics';

export type ReportKind = 'DAY' | 'WEEK';

export function reportRange(kind: ReportKind, dateKey: string): TimeRange {
  if (kind === 'DAY') return dayRangeForKey(dateKey);
  const date = Temporal.PlainDate.from(dateKey);
  const monday = date.subtract({ days: date.dayOfWeek - 1 });
  const start = monday.toZonedDateTime(BUSINESS_TIME_ZONE);
  return {
    start: start.toInstant().toString(),
    end: start.add({ weeks: 1 }).toInstant().toString(),
  };
}

export function periodReport(
  events: readonly StoredEvent[],
  kind: ReportKind,
  dateKey: string,
) {
  const range = reportRange(kind, dateKey);
  const startMs = Date.parse(range.start);
  const endMs = Date.parse(range.end);
  const entries = events
    .filter((event) => {
      const time = Date.parse(event.buchungszeit);
      return time >= startMs && time < endMs;
    })
    .sort((a, b) =>
      Date.parse(b.buchungszeit) - Date.parse(a.buchungszeit)
      || b.id.localeCompare(a.id),
    );

  return {
    range,
    entries,
    statistics: statisticsForRange(events, range),
    pending: entries.filter((event) =>
      event.syncState === 'PENDING' || event.syncState === 'LOCAL_ONLY',
    ).length,
    rejected: entries.filter((event) => event.syncState === 'REJECTED').length,
  };
}

const germanTime = new Intl.DateTimeFormat('de-DE', {
  timeZone: BUSINESS_TIME_ZONE,
  dateStyle: 'short',
  timeStyle: 'short',
});

function printable(value: string, maxLength: number): string {
  return value
    .replace(/[^\x20-\x7EäöüÄÖÜß€]/g, '?')
    .slice(0, maxLength);
}

export async function createPeriodPdf(
  events: readonly StoredEvent[],
  kind: ReportKind,
  dateKey: string,
  createdAt = new Date().toISOString(),
): Promise<Uint8Array> {
  const report = periodReport(events, kind, dateKey);
  const pdf = await PDFDocument.create();
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const dark = rgb(0.12, 0.15, 0.17);
  const muted = rgb(0.40, 0.44, 0.47);
  const lineHeight = 17;
  let page = pdf.addPage([595, 842]);
  let y = 794;

  const write = (value: string, size = 10, strong = false, x = 42) => {
    page.drawText(printable(value, 105), {
      x,
      y,
      size,
      font: strong ? bold : regular,
      color: strong ? dark : muted,
    });
    y -= lineHeight;
  };
  const nextPage = () => {
    page = pdf.addPage([595, 842]);
    y = 794;
    write('UPHOFF PALETTEN - Buchungsprotokoll (Fortsetzung)', 11, true);
    y -= 12;
  };

  write('UPHOFF PALETTEN', 18, true);
  y -= 6;
  const start = germanTime.format(new Date(report.range.start));
  const end = germanTime.format(new Date(Date.parse(report.range.end) - 1));
  write(`${kind === 'DAY' ? 'Tagesbericht' : 'Wochenbericht'}: ${start} bis ${end}`, 11, true);
  write(`Erstellt: ${germanTime.format(new Date(createdAt))}`);
  write(`Eintraege: ${report.entries.length} | ausstehend: ${report.pending} | abgelehnt: ${report.rejected}`);
  y -= 10;
  write('BESTANDSBEWEGUNG IM ZEITRAUM', 11, true);
  write(`Zugang: +${report.statistics.dazugekommen}  |  Abgang: -${report.statistics.weggekommen}  |  Inventurdifferenz: ${report.statistics.inventurdifferenz}`);
  write(`Nettoveraenderung: ${report.statistics.nettoBestandsaenderung}`);
  write('Korrekturen werden dem Datum der urspruenglichen Buchung zugeordnet.', 9);
  write('Ausstehende Buchungen koennen auf anderen Geraeten noch fehlen.', 9);
  y -= 12;

  write('JE SORTE', 11, true);
  for (const type of PALLET_TYPES) {
    const stats = report.statistics.bySort[type.id];
    write(`${type.name}: +${stats?.dazugekommen ?? 0} / -${stats?.weggekommen ?? 0} / netto ${stats?.nettoBestandsaenderung ?? 0}`);
  }
  y -= 12;
  write('BUCHUNGEN (neueste zuerst)', 11, true);

  const names = new Map(PALLET_TYPES.map((type) => [type.id, type.name]));
  if (report.entries.length === 0) write('Keine Buchungen in diesem Zeitraum.');
  for (const event of report.entries) {
    if (y < 64) nextPage();
    const date = germanTime.format(new Date(event.buchungszeit));
    const name = printable(names.get(event.sorte) ?? event.sorte, 22);
    const device = printable(event.geraetId, 14);
    const delta = event.delta > 0 ? `+${event.delta}` : String(event.delta);
    write(`${date}  ${name}  ${event.art} ${delta}  ${device}  ${event.syncState}`, 8);
  }

  pdf.setTitle(`UPHOFF Paletten ${kind === 'DAY' ? 'Tagesbericht' : 'Wochenbericht'} ${dateKey}`);
  return pdf.save();
}

export function defaultReportDate(): string {
  return berlinDateKey(new Date().toISOString());
}
