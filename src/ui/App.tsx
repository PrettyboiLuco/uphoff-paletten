import { useMemo, useState } from 'react';
import { PALLET_TYPES } from './config';
import { effectForTap, syncLabel, type CountMode } from './logic';

type Tab = 'COUNT' | 'STATS';

export function App() {
  const [tab, setTab] = useState<Tab>('COUNT');
  const [mode, setMode] = useState<CountMode>('EINGANG');
  const [stocks, setStocks] = useState<Record<string, number>>(
    Object.fromEntries(PALLET_TYPES.map((type) => [type.id, 0])),
  );

  const total = useMemo(
    () => Object.values(stocks).reduce((sum, value) => sum + value, 0),
    [stocks],
  );

  const book = (
    palletId: string,
    action: 'STACK' | 'PLUS_ONE' | 'MINUS_ONE',
    stackSize: number,
  ) => {
    const delta = effectForTap(mode, action, stackSize);
    setStocks((current) => ({
      ...current,
      [palletId]: (current[palletId] ?? 0) + delta,
    }));
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
        <div className="sync-pill" aria-label="Synchronisationsstatus">
          <span className="sync-dot" />
          {syncLabel('SYNCHRON', 0)}
        </div>
      </header>

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
                  onClick={() => book(type.id, 'STACK', type.stackSize)}
                  aria-label={`${type.name} Stapel buchen`}
                >
                  <span>{mode === 'EINGANG' ? '+' : '−'}{type.stackSize}</span>
                  <small>STAPEL</small>
                </button>
                <button
                  className="adjust-button"
                  onClick={() => book(type.id, 'MINUS_ONE', type.stackSize)}
                  aria-label={`${type.name} minus eins`}
                >
                  −1
                </button>
                <button
                  className="adjust-button"
                  onClick={() => book(type.id, 'PLUS_ONE', type.stackSize)}
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
              <strong>Noch keine Buchung</strong>
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
          <div className="chart-placeholder">Statistikdaten werden aus E3 gespeist.</div>
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
