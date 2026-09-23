import { useEffect, useMemo, useRef, useState } from 'react';
import { LocalBookingController, type BookingAction } from './bookingController';
import { PALLET_TYPES } from './config';
import { syncLabel, type CountMode } from './logic';

type Tab = 'COUNT' | 'STATS';

interface LastAction {
  palletName: string;
  delta: number;
  mode: CountMode;
}

export function App() {
  const controllerRef = useRef<LocalBookingController | null>(null);
  const [tab, setTab] = useState<Tab>('COUNT');
  const [mode, setMode] = useState<CountMode>('EINGANG');
  const [stocks, setStocks] = useState<Record<string, number>>({});
  const [syncState, setSyncState] = useState<'SYNCHRON' | 'PENDING' | 'REJECTED' | 'NEVER_SYNCED'>('NEVER_SYNCED');
  const [pendingCount, setPendingCount] = useState(0);
  const [lastAction, setLastAction] = useState<LastAction | null>(null);
  const [error, setError] = useState<string | null>(null);

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
      })
      .catch(() => {
        if (!cancelled) setError('Lokaler Speicher konnte nicht geöffnet werden.');
      });

    return () => {
      cancelled = true;
      controller.db.close();
      controllerRef.current = null;
    };
  }, []);

  const total = useMemo(
    () => Object.values(stocks).reduce((sum, value) => sum + value, 0),
    [stocks],
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
      const { event, projection } = await controller.book(mode, pallet, action);
      setStocks(projection.bestandJeSorte);
      const pending = await controller.db.outbox.count();
      setPendingCount(pending);
      setSyncState(pending > 0 ? 'PENDING' : 'SYNCHRON');
      setLastAction({
        palletName: pallet.name,
        delta: event.delta,
        mode,
      });
    } catch {
      setError('Buchung wurde nicht gespeichert. Bitte erneut versuchen.');
    }
  };

  return (
    <main className="app-shell" data-mode={mode.toLowerCase()}>
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
            <button disabled>RÜCKGÄNGIG</button>
          </div>
        </section>
      ) : (
        <section className="stats-page">
          <div className="stat-hero">
            <span>WEGGEKOMMEN</span>
            <strong>0</strong>
            <small>Heute</small>
          </div>
          <div className="stats-grid">
            <div><span>Bestand</span><strong>{total}</strong></div>
            <div><span>Dazugekommen</span><strong>0</strong></div>
          </div>
          <div className="chart-placeholder">Statistikdaten werden im nächsten UI-Schritt direkt aus E3 gespeist.</div>
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
