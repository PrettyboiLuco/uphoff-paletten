import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { listEvents } from '../persistence/localDb';
import {
  comparePeriod,
  periodWindow,
  statisticsForRange,
  type PeriodComparison,
  type PeriodStatistics,
  type StatisticsPeriodKind,
} from '../statistics/statistics';
import { LocalBookingController, type BookingAction } from './bookingController';
import { PALLET_TYPES } from './config';
import { syncLabel, type CountMode } from './logic';

type Tab = 'COUNT' | 'STATS';

interface LastAction {
  palletName: string;
  delta: number;
  mode: CountMode;
  processId: string;
}

const emptyStats: PeriodStatistics = {
  dazugekommen: 0,
  weggekommen: 0,
  inventurdifferenz: 0,
  nettoBestandsaenderung: 0,
  bySort: {},
};

const emptyComparison: PeriodComparison = {
  dazugekommen: { current: 0, previous: 0, percentChange: 0 },
  weggekommen: { current: 0, previous: 0, percentChange: 0 },
  inventurdifferenz: { current: 0, previous: 0, percentChange: 0 },
};

const PERIODS: readonly { id: StatisticsPeriodKind; label: string }[] = [
  { id: 'TODAY', label: 'HEUTE' },
  { id: 'FOUR_WEEKS', label: '4 WOCHEN' },
  { id: 'SIX_MONTHS', label: '6 MONATE' },
  { id: 'ONE_YEAR', label: '1 JAHR' },
];

export function App() {
  const controllerRef = useRef<LocalBookingController | null>(null);
  const swipeStartX = useRef<number | null>(null);
  const [tab, setTab] = useState<Tab>('COUNT');
  const [mode, setMode] = useState<CountMode>('EINGANG');
  const [stocks, setStocks] = useState<Record<string, number>>({});
  const [syncState, setSyncState] = useState<'SYNCHRON' | 'PENDING' | 'REJECTED' | 'NEVER_SYNCED'>('NEVER_SYNCED');
  const [pendingCount, setPendingCount] = useState(0);
  const [lastAction, setLastAction] = useState<LastAction | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [period, setPeriod] = useState<StatisticsPeriodKind>('TODAY');
  const [sortFilter, setSortFilter] = useState<string>('ALL');
  const [stats, setStats] = useState<PeriodStatistics>(emptyStats);
  const [comparison, setComparison] = useState<PeriodComparison>(emptyComparison);

  const refreshStatistics = async (
    controller: LocalBookingController,
    nextPeriod = period,
    nextSort = sortFilter,
  ) => {
    const events = await listEvents(controller.db);
    const now = new Date().toISOString();
    const window = periodWindow(nextPeriod, now);
    const sort = nextSort === 'ALL' ? undefined : nextSort;
    setStats(statisticsForRange(events, window.current, sort));
    setComparison(comparePeriod(events, nextPeriod, now, sort));
  };

  useEffect(() => {
    let cancelled = false;
    const controller = new LocalBookingController();
    controllerRef.current = controller;

    void controller.initialize()
      .then(async (projection) => {
        if (cancelled) return;
        setStocks(projection.bestandJeSorte);
        const pending = await controller.db.outbox.count();
        setPendingCount(pending);
        setSyncState(pending > 0 ? 'PENDING' : 'NEVER_SYNCED');
        await refreshStatistics(controller);
      })
      .catch(() => {
        if (!cancelled) setError('Lokaler Speicher konnte nicht geöffnet werden.');
      });

    return () => {
      cancelled = true;
      controller.db.close();
      controllerRef.current = null;
    };
    // Initialisierung bewusst nur einmal; Filteränderungen werden separat behandelt.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const controller = controllerRef.current;
    if (!controller) return;
    void refreshStatistics(controller, period, sortFilter);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [period, sortFilter]);

  const total = useMemo(
    () => Object.values(stocks).reduce((sum, value) => sum + value, 0),
    [stocks],
  );

  const maxOutgoing = useMemo(
    () => Math.max(
      1,
      ...Object.values(stats.bySort).map((value) => value.weggekommen),
    ),
    [stats.bySort],
  );

  const book = async (
    palletId: string,
    action: BookingAction,
    stackSize: number,
  ) => {
    const pallet = PALLET_TYPES.find((item) => item.id === palletId);
    const controller = controllerRef.current;
    if (!pallet || !controller || pallet.stackSize !== stackSize) return;

    setError(null);

    try {
      const { event, projection, processId } = await controller.book(mode, pallet, action);
      setStocks(projection.bestandJeSorte);
      const pending = await controller.db.outbox.count();
      setPendingCount(pending);
      setSyncState(pending > 0 ? 'PENDING' : 'SYNCHRON');
      setLastAction({
        palletName: pallet.name,
        delta: event.delta,
        mode,
        processId,
      });
      await refreshStatistics(controller);
    } catch {
      setError('Buchung wurde nicht gespeichert. Bitte erneut versuchen.');
    }
  };


  const undoLastProcess = async () => {
    const controller = controllerRef.current;
    if (!controller || !lastAction) return;

    setError(null);
    try {
      const { projection } = await controller.undoProcess(lastAction.processId);
      setStocks(projection.bestandJeSorte);
      const pending = await controller.db.outbox.count();
      setPendingCount(pending);
      setSyncState(pending > 0 ? 'PENDING' : 'SYNCHRON');
      setLastAction(null);
      await refreshStatistics(controller);
    } catch {
      setError('Rückgängig konnte nicht vollständig gespeichert werden.');
    }
  };


  const onPagePointerDown = (event: ReactPointerEvent<HTMLElement>) => {
    const target = event.target as HTMLElement;
    if (target.closest('button, select, input, a')) {
      swipeStartX.current = null;
      return;
    }
    swipeStartX.current = event.clientX;
  };

  const onPagePointerUp = (event: React.PointerEvent<HTMLElement>) => {
    const start = swipeStartX.current;
    swipeStartX.current = null;
    if (start === null) return;

    const delta = event.clientX - start;
    if (Math.abs(delta) < 70) return;
    setTab(delta < 0 ? 'STATS' : 'COUNT');
  };

  const outgoingChange = comparison.weggekommen.percentChange;
  const outgoingComparisonText = outgoingChange === null
    ? 'Keine belastbare Vorperiode'
    : `${outgoingChange >= 0 ? '+' : ''}${Math.round(outgoingChange)} % zur Vorperiode`;

  return (
    <main className="app-shell" data-mode={mode.toLowerCase()} onPointerDown={onPagePointerDown} onPointerUp={onPagePointerUp}>
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">U</span>
          <div>
            <strong>UPHOFF</strong>
            <span>PALETTENSERVICE</span>
          </div>
        </div>
        <div className={`sync-pill sync-${syncState.toLowerCase()}`} aria-label="Synchronisationsstatus">
          <span className="sync-dot" />
          {syncLabel(syncState, pendingCount)}
        </div>
      </header>

      {error && <div className="error-banner" role="alert">{error}</div>}

      {tab === 'COUNT' ? (
        <section className="count-page">
          <div className="hero-total">
            <span>PALETTEN INSGESAMT</span>
            <strong aria-live="polite">{total.toLocaleString('de-DE')}</strong>
          </div>

          <div className="mode-switch" role="group" aria-label="Buchungsmodus">
            {(['EINGANG', 'AUSGANG'] as const).map((value) => (
              <button
                key={value}
                className={mode === value ? 'active' : ''}
                onClick={() => setMode(value)}
              >
                {value}
              </button>
            ))}
          </div>

          <div className="pallet-list">
            {PALLET_TYPES.map((type) => (
              <article className="pallet-row" key={type.id}>
                <div className="type-accent" />
                <div className="type-copy">
                  <strong>{type.name}</strong>
                  <span>Stapel {type.stackSize}</span>
                </div>
                <div className="row-stock">
                  <span>Bestand</span>
                  <strong>{stocks[type.id] ?? 0}</strong>
                </div>
                <button
                  className="stack-button"
                  onClick={() => void book(type.id, 'STACK', type.stackSize)}
                  aria-label={`${type.name} Stapel buchen`}
                >
                  <span>{mode === 'EINGANG' ? '+' : '−'}{type.stackSize}</span>
                  <small>STAPEL</small>
                </button>
                <button
                  className="adjust-button"
                  onClick={() => void book(type.id, 'MINUS_ONE', type.stackSize)}
                  aria-label={`${type.name} minus eins`}
                >
                  −1
                </button>
                <button
                  className="adjust-button"
                  onClick={() => void book(type.id, 'PLUS_ONE', type.stackSize)}
                  aria-label={`${type.name} plus eins`}
                >
                  +1
                </button>
              </article>
            ))}
          </div>

          <div className="last-action">
            <div>
              <span>LETZTER VORGANG</span>
              <strong>
                {lastAction
                  ? `${lastAction.palletName} · ${lastAction.mode} · ${lastAction.delta > 0 ? '+' : ''}${lastAction.delta}`
                  : 'Noch keine Buchung'}
              </strong>
            </div>
            <button disabled={!lastAction} onClick={() => void undoLastProcess()}>RÜCKGÄNGIG</button>
          </div>
        </section>
      ) : (
        <section className="stats-page">
          <div className="period-switch" role="group" aria-label="Statistikzeitraum">
            {PERIODS.map((item) => (
              <button
                key={item.id}
                className={period === item.id ? 'active' : ''}
                onClick={() => setPeriod(item.id)}
              >
                {item.label}
              </button>
            ))}
          </div>

          <div className="filter-row">
            <label htmlFor="sort-filter">SORTE</label>
            <select
              id="sort-filter"
              value={sortFilter}
              onChange={(event) => setSortFilter(event.target.value)}
            >
              <option value="ALL">Alle Paletten</option>
              {PALLET_TYPES.map((type) => (
                <option key={type.id} value={type.id}>{type.name}</option>
              ))}
            </select>
          </div>

          <div className="stat-hero">
            <span>WEGGEKOMMEN</span>
            <strong>{stats.weggekommen.toLocaleString('de-DE')}</strong>
            <small>{outgoingComparisonText}</small>
          </div>

          <div className="stats-grid">
            <div>
              <span>BESTAND</span>
              <strong>{sortFilter === 'ALL' ? total : (stocks[sortFilter] ?? 0)}</strong>
            </div>
            <div>
              <span>DAZUGEKOMMEN</span>
              <strong>{stats.dazugekommen.toLocaleString('de-DE')}</strong>
            </div>
            <div>
              <span>INVENTURDIFFERENZ</span>
              <strong>{stats.inventurdifferenz > 0 ? '+' : ''}{stats.inventurdifferenz}</strong>
            </div>
          </div>

          <div className="bar-chart" aria-label="Weggekommen je Sorte">
            {PALLET_TYPES
              .filter((type) => sortFilter === 'ALL' || type.id === sortFilter)
              .map((type) => {
                const value = stats.bySort[type.id]?.weggekommen ?? 0;
                return (
                  <div className="bar-row" key={type.id}>
                    <span>{type.name}</span>
                    <div className="bar-track">
                      <div className="bar-fill" style={{ width: `${(value / maxOutgoing) * 100}%` }} />
                    </div>
                    <strong>{value}</strong>
                  </div>
                );
              })}
          </div>
        </section>
      )}

      <nav className="bottom-nav" aria-label="Hauptnavigation">
        <button className={tab === 'COUNT' ? 'active' : ''} onClick={() => setTab('COUNT')}>
          ZÄHLEN
        </button>
        <button className={tab === 'STATS' ? 'active' : ''} onClick={() => setTab('STATS')}>
          STATISTIK
        </button>
      </nav>
    </main>
  );
}
