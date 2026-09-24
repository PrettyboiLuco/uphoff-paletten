import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { LayoutEditor } from '../layout/LayoutEditor';
import {
  defaultLayout,
  profileForViewport,
  type LayoutDocument,
  type LayoutItem,
  type LayoutProfile,
} from '../layout/layout';
import { loadLayout } from '../layout/storage';
import { logOperationalError } from '../ops/errorLog';
import { OpsPanel } from '../ops/OpsPanel';
import { listEvents, loadProjection } from '../persistence/localDb';
import { requestDurableStorage } from '../pwa/storageDurability';
import {
  comparePeriod,
  periodWindow,
  statisticsForRange,
  type PeriodComparison,
  type PeriodStatistics,
  type StatisticsPeriodKind,
} from '../statistics/statistics';
import {
  checkCurrentDeviceEnrollment,
  getFirebaseRuntime,
} from '../sync/firebaseRuntime';
import { getSyncHealth } from '../sync/health';
import { runFullSync, startRealtimeSync } from '../sync/reconcile';
import { runSyncPass } from '../sync/syncEngine';
import type { RemoteRealtimeEventStore, RemoteUnsubscribe } from '../sync/types';
import { LocalBookingController, type BookingAction } from './bookingController';
import { PALLET_TYPES } from './config';
import { syncLabel, type CountMode } from './logic';

type Tab = 'COUNT' | 'STATS';

type BackendState =
  | 'INITIALIZING'
  | 'NOT_CONFIGURED'
  | 'AWAITING_APPROVAL'
  | 'DISABLED'
  | 'ACTIVE'
  | 'OFFLINE'
  | 'ERROR';

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
  const remoteRef = useRef<RemoteRealtimeEventStore | null>(null);
  const realtimeStopRef = useRef<RemoteUnsubscribe | null>(null);
  const syncQueueRef = useRef<Promise<void>>(Promise.resolve());
  const swipeStartX = useRef<number | null>(null);

  const [tab, setTab] = useState<Tab>('COUNT');
  const [mode, setMode] = useState<CountMode>('EINGANG');
  const [stocks, setStocks] = useState<Record<string, number>>({});
  const [syncState, setSyncState] = useState<
    | 'SYNCHRON'
    | 'PENDING'
    | 'REJECTED'
    | 'NEVER_SYNCED'
    | 'STALE'
  >('NEVER_SYNCED');
  const [pendingCount, setPendingCount] = useState(0);
  const [lastRetryError, setLastRetryError] = useState<string | null>(null);
  const [backendState, setBackendState] = useState<BackendState>('INITIALIZING');
  const [backendUid, setBackendUid] = useState<string | null>(null);
  const [bookingReady, setBookingReady] = useState(false);
  const [lastAction, setLastAction] = useState<LastAction | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [period, setPeriod] = useState<StatisticsPeriodKind>('TODAY');
  const [sortFilter, setSortFilter] = useState<string>('ALL');
  const periodRef = useRef<StatisticsPeriodKind>('TODAY');
  const sortFilterRef = useRef<string>('ALL');
  periodRef.current = period;
  sortFilterRef.current = sortFilter;

  const [stats, setStats] = useState<PeriodStatistics>(emptyStats);
  const [comparison, setComparison] =
    useState<PeriodComparison>(emptyComparison);

  const initialProfile = profileForViewport(
    typeof window === 'undefined' ? 390 : window.innerWidth,
  );
  const [layoutProfile] = useState<LayoutProfile>(initialProfile);
  const [layout, setLayout] = useState<LayoutDocument>(() =>
    defaultLayout(initialProfile),
  );
  const [layoutEditorOpen, setLayoutEditorOpen] = useState(false);
  const [layoutReady, setLayoutReady] = useState(false);
  const [opsOpen, setOpsOpen] = useState(false);
  const allowLocalOnly =
    import.meta.env.DEV
    || import.meta.env.VITE_ALLOW_LOCAL_ONLY === 'true';

  const refreshStatistics = async (
    controller: LocalBookingController,
    nextPeriod = periodRef.current,
    nextSort = sortFilterRef.current,
  ) => {
    const events = await listEvents(controller.db);
    const now = new Date().toISOString();
    const window = periodWindow(nextPeriod, now);
    const sort = nextSort === 'ALL' ? undefined : nextSort;
    setStats(statisticsForRange(events, window.current, sort));
    setComparison(comparePeriod(events, nextPeriod, now, sort));
  };

  const refreshLocalState = async (controller: LocalBookingController) => {
    const [projection, health] = await Promise.all([
      loadProjection(controller.db),
      getSyncHealth(controller.db),
    ]);

    setStocks(projection.bestandJeSorte);
    setPendingCount(health.pendingCount);
    setSyncState(health.state);
    setLastRetryError(health.lastRetryError ?? null);
    await refreshStatistics(controller);
  };

  const recordSyncError = async (
    controller: LocalBookingController,
    code: string,
    caught: unknown,
  ) => {
    try {
      await logOperationalError(controller.db, {
        code,
        severity: 'ERROR',
        message: caught instanceof Error ? caught.message : String(caught),
        occurredAt: new Date().toISOString(),
      });
    } catch {
      // The UI must remain usable even if diagnostic logging itself fails.
    }
  };

  const verifyDeviceStillAllowed = async (
    controller: LocalBookingController,
  ): Promise<boolean | null> => {
    const enrollment = await checkCurrentDeviceEnrollment();

    if (enrollment === 'DISABLED') {
      setBookingReady(false);
      setBackendState('DISABLED');
      setError(
        'Dieses Gerät wurde gesperrt. Neue Buchungen sind bis zur erneuten Freigabe deaktiviert.',
      );
      await recordSyncError(
        controller,
        'DEVICE_DISABLED_DURING_SESSION',
        'device-disabled',
      );
      return false;
    }

    if (enrollment === 'MISSING') {
      setBookingReady(false);
      setBackendState('AWAITING_APPROVAL');
      setError(
        'Die Gerätefreigabe ist nicht mehr vorhanden. Neue Buchungen sind bis zur erneuten Freigabe deaktiviert.',
      );
      await recordSyncError(
        controller,
        'DEVICE_ENROLLMENT_MISSING',
        'device-enrollment-missing',
      );
      return false;
    }

    return enrollment === 'ACTIVE' ? true : null;
  };

  const enqueueSync = (
    work: () => Promise<void>,
  ): Promise<void> => {
    const task = syncQueueRef.current.then(work, work);
    syncQueueRef.current = task.catch(() => undefined);
    return task;
  };

  const pushPending = (
    controller: LocalBookingController,
  ): Promise<void> => {
    if (!remoteRef.current) return Promise.resolve();

    return enqueueSync(async () => {
      const remote = remoteRef.current;
      if (!remote) return;

      try {
        const result = await runSyncPass(
          controller.db,
          remote,
          Date.now(),
        );

        if (result.rejected > 0 && navigator.onLine) {
          await verifyDeviceStillAllowed(controller);
        }
      } catch (caught) {
        const enrollment = navigator.onLine
          ? await verifyDeviceStillAllowed(controller)
          : null;
        if (enrollment !== false) {
          setBackendState(navigator.onLine ? 'ERROR' : 'OFFLINE');
        }
        await recordSyncError(controller, 'SYNC_PUSH_FAILED', caught);
      } finally {
        await refreshLocalState(controller);
      }
    });
  };

  const fullSync = (
    controller: LocalBookingController,
  ): Promise<void> => {
    if (!remoteRef.current) return Promise.resolve();

    return enqueueSync(async () => {
      const remote = remoteRef.current;
      if (!remote) return;

      try {
        const now = new Date();
        const result = await runFullSync(
          controller.db,
          remote,
          now.getTime(),
          now.toISOString(),
        );

        const enrollment =
          result.push.rejected > 0 && navigator.onLine
            ? await verifyDeviceStillAllowed(controller)
            : true;

        if (enrollment !== false) {
          setBackendState(
            navigator.onLine ? 'ACTIVE' : 'OFFLINE',
          );
        }
      } catch (caught) {
        const enrollment = navigator.onLine
          ? await verifyDeviceStillAllowed(controller)
          : null;
        if (enrollment !== false) {
          setBackendState(navigator.onLine ? 'ERROR' : 'OFFLINE');
        }
        await recordSyncError(
          controller,
          'SYNC_RECONCILE_FAILED',
          caught,
        );
      } finally {
        await refreshLocalState(controller);
      }
    });
  };

  useEffect(() => {
    let cancelled = false;
    let retryTimer: number | null = null;
    let reconcileTimer: number | null = null;

    const controller = new LocalBookingController();
    controllerRef.current = controller;

    const onOnline = () => {
      setBackendState('INITIALIZING');
      void fullSync(controller);
    };

    const onOffline = () => {
      setBackendState('OFFLINE');
      void refreshLocalState(controller);
    };

    const onVisibility = () => {
      if (document.visibilityState === 'visible' && remoteRef.current) {
        void fullSync(controller);
      }
    };

    void (async () => {
      try {
        await controller.initialize();
        if (cancelled) return;

        await refreshLocalState(controller);
        setLayout(await loadLayout(controller.db, layoutProfile));
        setLayoutReady(true);

        const storage = await requestDurableStorage();
        await controller.db.meta.put({
          key: 'storageDurability',
          value: JSON.stringify(storage),
        });

        const runtime = await getFirebaseRuntime();
        if (cancelled) return;

        if (runtime.uid) {
          controller.setDeviceId(runtime.uid);
          setBackendUid(runtime.uid);
        }

        if (runtime.status === 'NOT_CONFIGURED') {
          setBackendState('NOT_CONFIGURED');
          setBookingReady(allowLocalOnly);
          if (!allowLocalOnly) {
            setError(
              'Die Produktions-Cloud ist nicht konfiguriert. Neue Buchungen bleiben gesperrt, damit dieses Gerät nicht zur einzigen Datenkopie wird.',
            );
          }
          return;
        }

        if (runtime.status === 'AWAITING_APPROVAL') {
          setBackendState('AWAITING_APPROVAL');
          const approved = await controller.db.meta.get(
            'approvedDeviceUid',
          );
          setBookingReady(
            Boolean(
              runtime.uid
              && approved?.value === runtime.uid,
            ),
          );
          return;
        }

        if (runtime.status === 'DISABLED') {
          setBackendState('DISABLED');
          setBookingReady(false);
          setError(
            'Dieses Gerät wurde gesperrt. Neue Buchungen sind bis zur erneuten Freigabe deaktiviert.',
          );
          return;
        }

        if (!runtime.remote || !runtime.uid) {
          setBackendState('ERROR');
          return;
        }

        await controller.db.meta.put({
          key: 'approvedDeviceUid',
          value: runtime.uid,
        });

        const incompatiblePending = await controller.db.events
          .filter(
            (event) =>
              (event.syncState === 'LOCAL_ONLY' || event.syncState === 'PENDING')
              && event.geraetId !== runtime.uid,
          )
          .count();

        if (incompatiblePending > 0) {
          setBookingReady(false);
          setBackendState('ERROR');
          setError(
            `${incompatiblePending} lokale Buchung(en) stammen von einer anderen Geräte-ID und werden nicht still umgeschrieben. Bitte im Datenbereich prüfen.`,
          );
          await logOperationalError(controller.db, {
            code: 'PENDING_DEVICE_ID_MISMATCH',
            severity: 'ERROR',
            message: 'Pending events use a different device identity.',
            occurredAt: new Date().toISOString(),
            context: {
              count: incompatiblePending,
              activeUid: runtime.uid,
            },
          });
          return;
        }

        remoteRef.current = runtime.remote;
        setBookingReady(true);
        setBackendState(
          navigator.onLine ? 'INITIALIZING' : 'OFFLINE',
        );

        await pushPending(controller);
        if (cancelled) return;

        realtimeStopRef.current = await startRealtimeSync(
          controller.db,
          runtime.remote,
          () => new Date().toISOString(),
          (caught) => {
            setBackendState(navigator.onLine ? 'ERROR' : 'OFFLINE');
            void recordSyncError(
              controller,
              'REALTIME_LISTENER_FAILED',
              caught,
            );
          },
          async () => {
            await refreshLocalState(controller);
          },
        );

        window.addEventListener('online', onOnline);
        window.addEventListener('offline', onOffline);
        document.addEventListener('visibilitychange', onVisibility);

        retryTimer = window.setInterval(() => {
          if (navigator.onLine && remoteRef.current) {
            void pushPending(controller);
          }
        }, 15_000);

        reconcileTimer = window.setInterval(() => {
          if (navigator.onLine && remoteRef.current) {
            void fullSync(controller);
          }
        }, 5 * 60_000);
      } catch (caught) {
        if (cancelled) return;
        setBackendState('ERROR');
        setError(
          'Die lokale App läuft weiter, aber die Cloud-Verbindung konnte nicht initialisiert werden.',
        );
        await recordSyncError(controller, 'STARTUP_FAILED', caught);
      }
    })();

    return () => {
      cancelled = true;
      if (retryTimer !== null) window.clearInterval(retryTimer);
      if (reconcileTimer !== null) window.clearInterval(reconcileTimer);
      realtimeStopRef.current?.();
      realtimeStopRef.current = null;
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
      document.removeEventListener('visibilitychange', onVisibility);
      controller.db.close();
      controllerRef.current = null;
      remoteRef.current = null;
    };
    // Startup is intentionally one-shot. Current filters are read through refs.
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
    () =>
      Math.max(
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
      const { event, processId } = await controller.book(mode, pallet, action);
      setLastAction({
        palletName: pallet.name,
        delta: event.delta,
        mode,
        processId,
      });

      await refreshLocalState(controller);
      await pushPending(controller);
    } catch {
      setError('Buchung wurde nicht gespeichert. Bitte erneut versuchen.');
    }
  };

  const undoLastProcess = async () => {
    const controller = controllerRef.current;
    if (!controller || !lastAction) return;

    setError(null);
    try {
      await controller.undoProcess(lastAction.processId);
      setLastAction(null);
      await refreshLocalState(controller);
      await pushPending(controller);
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

  const onPagePointerUp = (event: ReactPointerEvent<HTMLElement>) => {
    const start = swipeStartX.current;
    swipeStartX.current = null;
    if (start === null) return;

    const delta = event.clientX - start;
    if (Math.abs(delta) < 70) return;
    setTab(delta < 0 ? 'STATS' : 'COUNT');
  };

  const blockStyle = (id: LayoutItem['id']) => {
    const item = layout.items.find((candidate) => candidate.id === id);
    if (!item || (item.w === layout.cols && item.x === 0)) return undefined;
    return {
      width: `${(item.w / layout.cols) * 100}%`,
      marginLeft: `${(item.x / layout.cols) * 100}%`,
    };
  };

  const outgoingChange = comparison.weggekommen.percentChange;
  const outgoingComparisonText =
    outgoingChange === null
      ? 'Keine belastbare Vorperiode'
      : `${outgoingChange >= 0 ? '+' : ''}${Math.round(outgoingChange)} % zur Vorperiode`;

  const syncDisplay = (() => {
    if (lastRetryError === 'QUOTA_EXHAUSTED') return 'Kontingent erreicht';
    if (lastRetryError === 'UNAUTHENTICATED') return 'Anmeldung prüfen';
    if (backendState === 'INITIALIZING') return 'Verbinde …';
    if (backendState === 'NOT_CONFIGURED') {
      return pendingCount > 0 ? `Nur lokal · ${pendingCount} ausstehend` : 'Nur lokal';
    }
    if (backendState === 'AWAITING_APPROVAL') {
      return pendingCount > 0
        ? `Freigabe nötig · ${pendingCount} ausstehend`
        : 'Gerät freigeben';
    }
    if (backendState === 'DISABLED') return 'Gerät gesperrt';
    if (backendState === 'OFFLINE') {
      return pendingCount > 0 ? `Offline · ${pendingCount} ausstehend` : 'Offline';
    }
    if (backendState === 'ERROR') return 'Sync prüfen';
    return syncLabel(syncState, pendingCount);
  })();

  const syncTone =
    lastRetryError === 'QUOTA_EXHAUSTED'
      ? 'quota'
      : lastRetryError === 'UNAUTHENTICATED'
        ? 'error'
        : backendState === 'ACTIVE'
          ? syncState.toLowerCase()
          : backendState.toLowerCase();

  return (
    <main
      className="app-shell"
      data-mode={mode.toLowerCase()}
      data-layout-ready={layoutReady ? 'true' : 'false'}
      data-backend-state={backendState.toLowerCase()}
      data-booking-ready={bookingReady ? 'true' : 'false'}
      onPointerDown={onPagePointerDown}
      onPointerUp={onPagePointerUp}
    >
      <div className="orientation-warning" role="status">
        <strong>HOCHFORMAT VERWENDEN</strong>
        <span>
          Für sicheres Zählen ist diese Ansicht auf Hochformat ausgelegt.
        </span>
      </div>

      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            U
          </span>
          <div>
            <strong>UPHOFF</strong>
            <span>PALETTENSERVICE</span>
          </div>
        </div>

        <div className="header-actions">
          <button
            className="layout-open-button"
            onClick={() => setLayoutEditorOpen(true)}
          >
            LAYOUT
          </button>
          <button
            className="layout-open-button"
            onClick={() => setOpsOpen(true)}
          >
            DATEN
          </button>
          <div
            className={`sync-pill sync-${syncTone}`}
            aria-label="Synchronisationsstatus"
            title={
              backendState === 'AWAITING_APPROVAL' && backendUid
                ? `Geräte-ID: ${backendUid}`
                : syncDisplay
            }
          >
            <span className="sync-dot" />
            {syncDisplay}
          </div>
        </div>
      </header>

      {backendState === 'AWAITING_APPROVAL' && backendUid && (
        <div className="cloud-banner" role="status">
          Geräte-ID zur Freigabe: <strong>{backendUid}</strong>
        </div>
      )}

      {!bookingReady
        && backendState !== 'DISABLED'
        && (
        <div className="cloud-banner" role="status">
          Buchungen werden freigegeben, sobald die Geräte-ID sicher feststeht.
        </div>
      )}

      {error && (
        <div className="error-banner" role="alert">
          {error}
        </div>
      )}

      {tab === 'COUNT' ? (
        <section className="count-page">
          <div className="hero-total" style={blockStyle('TOTAL')}>
            <span>PALETTEN INSGESAMT</span>
            <strong aria-live="polite">
              {total.toLocaleString('de-DE')}
            </strong>
          </div>

          <div
            className="mode-switch"
            role="group"
            aria-label="Buchungsmodus"
            style={blockStyle('MODE')}
          >
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
                  onClick={() =>
                    void book(type.id, 'STACK', type.stackSize)
                  }
                  disabled={!bookingReady}
                  aria-label={`${type.name} Stapel buchen`}
                >
                  <span>
                    {mode === 'EINGANG' ? '+' : '−'}
                    {type.stackSize}
                  </span>
                  <small>STAPEL</small>
                </button>
                <button
                  className="adjust-button"
                  onClick={() =>
                    void book(type.id, 'MINUS_ONE', type.stackSize)
                  }
                  disabled={!bookingReady}
                  aria-label={`${type.name} minus eins`}
                >
                  −1
                </button>
                <button
                  className="adjust-button"
                  onClick={() =>
                    void book(type.id, 'PLUS_ONE', type.stackSize)
                  }
                  disabled={!bookingReady}
                  aria-label={`${type.name} plus eins`}
                >
                  +1
                </button>
              </article>
            ))}
          </div>

          <div
            className="last-action"
            style={blockStyle('LAST_ACTION')}
          >
            <div>
              <span>LETZTER VORGANG</span>
              <strong>
                {lastAction
                  ? `${lastAction.palletName} · ${lastAction.mode} · ${lastAction.delta > 0 ? '+' : ''}${lastAction.delta}`
                  : 'Noch keine Buchung'}
              </strong>
            </div>
            <button
              disabled={!lastAction}
              onClick={() => void undoLastProcess()}
            >
              RÜCKGÄNGIG
            </button>
          </div>
        </section>
      ) : (
        <section className="stats-page">
          <div
            className="period-switch"
            role="group"
            aria-label="Statistikzeitraum"
          >
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
                <option key={type.id} value={type.id}>
                  {type.name}
                </option>
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
              <strong>
                {sortFilter === 'ALL'
                  ? total
                  : (stocks[sortFilter] ?? 0)}
              </strong>
            </div>
            <div>
              <span>DAZUGEKOMMEN</span>
              <strong>
                {stats.dazugekommen.toLocaleString('de-DE')}
              </strong>
            </div>
            <div>
              <span>INVENTURDIFFERENZ</span>
              <strong>
                {stats.inventurdifferenz > 0 ? '+' : ''}
                {stats.inventurdifferenz}
              </strong>
            </div>
          </div>

          <div className="bar-chart" aria-label="Weggekommen je Sorte">
            {PALLET_TYPES.filter(
              (type) => sortFilter === 'ALL' || type.id === sortFilter,
            ).map((type) => {
              const value = stats.bySort[type.id]?.weggekommen ?? 0;
              return (
                <div className="bar-row" key={type.id}>
                  <span>{type.name}</span>
                  <div className="bar-track">
                    <div
                      className="bar-fill"
                      style={{
                        width: `${(value / maxOutgoing) * 100}%`,
                      }}
                    />
                  </div>
                  <strong>{value}</strong>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {opsOpen && controllerRef.current && (
        <OpsPanel
          db={controllerRef.current.db}
          remote={remoteRef.current}
          deviceId={backendUid}
          onClose={() => setOpsOpen(false)}
          onDataChanged={async () => {
            const controller = controllerRef.current;
            if (!controller) return;
            await refreshLocalState(controller);
            await pushPending(controller);
          }}
        />
      )}

      {layoutEditorOpen && controllerRef.current && (
        <LayoutEditor
          db={controllerRef.current.db}
          profile={layoutProfile}
          onSaved={(nextLayout) => {
            setLayout(nextLayout);
            setLayoutReady(true);
          }}
          onClose={() => setLayoutEditorOpen(false)}
        />
      )}

      <nav className="bottom-nav" aria-label="Hauptnavigation">
        <button
          className={tab === 'COUNT' ? 'active' : ''}
          onClick={() => setTab('COUNT')}
        >
          ZÄHLEN
        </button>
        <button
          className={tab === 'STATS' ? 'active' : ''}
          onClick={() => setTab('STATS')}
        >
          STATISTIK
        </button>
      </nav>
    </main>
  );
}
