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
  stockSeries,
  type PeriodComparison,
  type PeriodStatistics,
  type StatisticsPeriodKind,
} from '../statistics/statistics';
import {
  checkCurrentDeviceEnrollment,
  getFirebaseRuntime,
} from '../sync/firebaseRuntime';
import { validateServerPalletConfig } from '../sync/configValidation';
import { getSyncHealth } from '../sync/health';
import { writeDeviceHeartbeat } from '../sync/heartbeat';
import { runFullSync, startRealtimeSync } from '../sync/reconcile';
import { runSyncPass } from '../sync/syncEngine';
import type { RemoteRealtimeEventStore, RemoteUnsubscribe } from '../sync/types';
import { LocalBookingController, type BookingAction } from './bookingController';
import { PALLET_CONFIG_READY, PALLET_TYPES } from './config';
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
  warning: 'NONE' | 'ZERO_NET' | 'WRONG_SIGN';
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

const APP_VERSION =
  (import.meta.env.VITE_APP_VERSION as string | undefined)?.trim()
  || '0.1.0';

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
  const [todayStats, setTodayStats] =
    useState<PeriodStatistics>(emptyStats);
  const [comparison, setComparison] =
    useState<PeriodComparison>(emptyComparison);
  const [stockPoints, setStockPoints] = useState<
    Array<{ at: string; bestand: number }>
  >([]);
  const [scrubIndex, setScrubIndex] = useState<number | null>(null);
  const [barMetric, setBarMetric] = useState<'OUT' | 'IN'>('OUT');

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
    const todayWindow = periodWindow('TODAY', now);
    const sort = nextSort === 'ALL' ? undefined : nextSort;

    setStats(statisticsForRange(events, window.current, sort));
    setTodayStats(
      statisticsForRange(events, todayWindow.current),
    );
    setComparison(comparePeriod(events, nextPeriod, now, sort));
    setStockPoints(stockSeries(events, window.current, sort));
    setScrubIndex(null);
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
    let heartbeatTimer: number | null = null;

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

    const publishHeartbeat = async (
      firestore: NonNullable<
        Awaited<ReturnType<typeof getFirebaseRuntime>>['db']
      >,
      uid: string,
    ) => {
      if (!navigator.onLine) return;

      try {
        await writeDeviceHeartbeat(
          firestore,
          uid,
          controller.db,
          APP_VERSION,
        );
      } catch (caught) {
        await recordSyncError(
          controller,
          'HEARTBEAT_FAILED',
          caught,
        );
        await verifyDeviceStillAllowed(controller);
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
          const approved = await controller.db.meta.get(
            'approvedDeviceUid',
          );
          const wasApproved = Boolean(
            runtime.uid
            && approved?.value === runtime.uid,
          );

          setBookingReady(wasApproved);
          setBackendState(
            wasApproved && !navigator.onLine
              ? 'OFFLINE'
              : 'AWAITING_APPROVAL',
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

        if (!runtime.remote || !runtime.uid || !runtime.db) {
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

        let palletConfigUsable = PALLET_CONFIG_READY || allowLocalOnly;

        if (PALLET_CONFIG_READY && !allowLocalOnly && runtime.db) {
          const validation = await validateServerPalletConfig(runtime.db);

          if (validation.status === 'MATCH') {
            await controller.db.meta.put({
              key: 'validatedPalletConfigSignature',
              value: validation.signature,
            });
          } else if (validation.status === 'UNAVAILABLE') {
            const previousValidation = await controller.db.meta.get(
              'validatedPalletConfigSignature',
            );
            palletConfigUsable =
              previousValidation?.value === validation.signature;

            if (!palletConfigUsable) {
              setError(
                'Die Server-Konfiguration der Palettensorten konnte noch nie erfolgreich bestätigt werden. Neue Buchungen bleiben bis zur Prüfung gesperrt.',
              );
            }
          } else {
            palletConfigUsable = false;
            setError(
              validation.status === 'MISSING'
                ? 'Die passende Server-Konfiguration für diese App-Version fehlt. Neue Buchungen sind gesperrt.'
                : 'Die Stapelgrößen dieser App stimmen nicht mit der Server-Konfiguration überein. Neue Buchungen sind gesperrt.',
            );
          }
        }

        setBookingReady(palletConfigUsable);
        if (!palletConfigUsable && !PALLET_CONFIG_READY) {
          setError(
            'Die sieben echten Palettensorten und Stapelgrößen sind noch nicht final konfiguriert. Synchronisierung bleibt aktiv, neue Buchungen sind gesperrt.',
          );
        }
        setBackendState(
          navigator.onLine ? 'INITIALIZING' : 'OFFLINE',
        );

        if (navigator.onLine) {
          await fullSync(controller);
        }
        if (cancelled) return;

        realtimeStopRef.current = await startRealtimeSync(
          controller.db,
          runtime.remote,
          () => new Date().toISOString(),
          (caught) => {
            void (async () => {
              const enrollment = navigator.onLine
                ? await verifyDeviceStillAllowed(controller)
                : null;

              if (enrollment !== false) {
                setBackendState(
                  navigator.onLine ? 'ERROR' : 'OFFLINE',
                );
              }

              await recordSyncError(
                controller,
                'REALTIME_LISTENER_FAILED',
                caught,
              );
            })();
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

        await publishHeartbeat(runtime.db, runtime.uid);

        heartbeatTimer = window.setInterval(() => {
          void publishHeartbeat(runtime.db!, runtime.uid!);
        }, 15 * 60_000);
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
      if (heartbeatTimer !== null) window.clearInterval(heartbeatTimer);
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

  const maxBarValue = useMemo(
    () =>
      Math.max(
        1,
        ...Object.values(stats.bySort).map((value) =>
          barMetric === 'OUT'
            ? value.weggekommen
            : value.dazugekommen,
        ),
      ),
    [barMetric, stats.bySort],
  );

  const stockChart = useMemo(() => {
    const width = 1000;
    const height = 180;
    const padX = 18;
    const padY = 16;

    if (stockPoints.length === 0) {
      return {
        width,
        height,
        path: '',
        coords: [] as Array<{ x: number; y: number }>,
        min: 0,
        max: 0,
      };
    }

    const times = stockPoints.map((point) => Date.parse(point.at));
    const values = stockPoints.map((point) => point.bestand);
    const minTime = Math.min(...times);
    const maxTime = Math.max(...times);
    const min = Math.min(...values);
    const max = Math.max(...values);
    const timeSpan = Math.max(1, maxTime - minTime);
    const valueSpan = Math.max(1, max - min);

    const coords = stockPoints.map((point, index) => ({
      x:
        padX
        + ((times[index]! - minTime) / timeSpan)
          * (width - padX * 2),
      y:
        height
        - padY
        - ((point.bestand - min) / valueSpan)
          * (height - padY * 2),
    }));

    return {
      width,
      height,
      min,
      max,
      coords,
      path: coords
        .map(
          (point, index) =>
            `${index === 0 ? 'M' : 'L'} ${point.x.toFixed(2)} ${point.y.toFixed(2)}`,
        )
        .join(' '),
    };
  }, [stockPoints]);

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
      const {
        event,
        processId,
        operationWarning,
      } = await controller.book(mode, pallet, action);
      setLastAction({
        palletName: pallet.name,
        delta: event.delta,
        mode,
        processId,
        warning: operationWarning,
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

  const updateScrubFromPointer = (
    event: ReactPointerEvent<SVGSVGElement>,
  ) => {
    if (stockChart.coords.length === 0) return;
    const box = event.currentTarget.getBoundingClientRect();
    const x =
      ((event.clientX - box.left) / Math.max(1, box.width))
      * stockChart.width;

    let best = 0;
    let bestDistance = Number.POSITIVE_INFINITY;
    stockChart.coords.forEach((point, index) => {
      const distance = Math.abs(point.x - x);
      if (distance < bestDistance) {
        best = index;
        bestDistance = distance;
      }
    });
    setScrubIndex(best);
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
          <div
            className={`hero-total ${total < 0 ? 'negative' : ''}`}
            style={blockStyle('TOTAL')}
          >
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
            {PALLET_TYPES.map((type) => {
              const stock = stocks[type.id] ?? 0;
              const negative = stock < 0;

              return (
              <article
                className={`pallet-row ${negative ? 'negative' : ''}`}
                key={type.id}
                data-negative={negative ? 'true' : 'false'}
              >
                <div className="type-accent" />
                <div className="type-copy">
                  <strong>{type.name}</strong>
                  <span>
                    Stapel {type.stackSize} · Heute{' '}
                    {(todayStats.bySort[type.id]?.nettoBestandsaenderung ?? 0) > 0 ? '+' : ''}
                    {todayStats.bySort[type.id]?.nettoBestandsaenderung ?? 0}
                  </span>
                </div>
                <div className="row-stock">
                  <span>{negative ? 'NEGATIV' : 'Bestand'}</span>
                  <strong>{stock}</strong>
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
              );
            })}
          </div>

          <div
            className={`last-action ${lastAction?.warning !== 'NONE' ? 'warning' : ''}`}
            style={blockStyle('LAST_ACTION')}
          >
            <div>
              <span>LETZTER VORGANG</span>
              <strong>
                {lastAction
                  ? `${lastAction.palletName} · ${lastAction.mode} · ${lastAction.delta > 0 ? '+' : ''}${lastAction.delta}${lastAction.warning === 'ZERO_NET' ? ' · NETTO 0 PRÜFEN' : lastAction.warning === 'WRONG_SIGN' ? ' · VORZEICHEN PRÜFEN' : ''}`
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

          <div className="stock-chart-card">
            <div className="chart-head">
              <div>
                <span>BESTANDSVERLAUF</span>
                <strong>
                  {scrubIndex === null
                    ? (stockPoints.at(-1)?.bestand ?? 0)
                    : (stockPoints[scrubIndex]?.bestand ?? 0)}
                </strong>
              </div>
              <small>
                {scrubIndex === null
                  ? `Spanne ${stockChart.min}–${stockChart.max}`
                  : new Date(
                      stockPoints[scrubIndex]?.at ?? '',
                    ).toLocaleString('de-DE', {
                      day: '2-digit',
                      month: '2-digit',
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
              </small>
            </div>

            <svg
              className="stock-chart"
              viewBox={`0 0 ${stockChart.width} ${stockChart.height}`}
              preserveAspectRatio="none"
              aria-label="Bestandsverlauf"
              onPointerDown={updateScrubFromPointer}
              onPointerMove={(event) => {
                if (event.buttons > 0 || event.pointerType === 'touch') {
                  updateScrubFromPointer(event);
                }
              }}
              onPointerLeave={() => setScrubIndex(null)}
            >
              <path
                className="stock-chart-line"
                d={stockChart.path}
                fill="none"
              />
              {scrubIndex !== null
                && stockChart.coords[scrubIndex] && (
                  <>
                    <line
                      className="stock-chart-guide"
                      x1={stockChart.coords[scrubIndex]!.x}
                      x2={stockChart.coords[scrubIndex]!.x}
                      y1="0"
                      y2={stockChart.height}
                    />
                    <circle
                      className="stock-chart-dot"
                      cx={stockChart.coords[scrubIndex]!.x}
                      cy={stockChart.coords[scrubIndex]!.y}
                      r="8"
                    />
                  </>
                )}
            </svg>
          </div>

          <div className="bar-chart">
            <div className="bar-chart-head">
              <span>BEWEGUNG JE SORTE</span>
              <div role="group" aria-label="Balkenmetrik">
                <button
                  className={barMetric === 'OUT' ? 'active' : ''}
                  onClick={() => setBarMetric('OUT')}
                >
                  WEG
                </button>
                <button
                  className={barMetric === 'IN' ? 'active' : ''}
                  onClick={() => setBarMetric('IN')}
                >
                  DAZU
                </button>
              </div>
            </div>

            {PALLET_TYPES.filter(
              (type) => sortFilter === 'ALL' || type.id === sortFilter,
            ).map((type) => {
              const value =
                barMetric === 'OUT'
                  ? (stats.bySort[type.id]?.weggekommen ?? 0)
                  : (stats.bySort[type.id]?.dazugekommen ?? 0);

              return (
                <div className="bar-row" key={type.id}>
                  <span>{type.name}</span>
                  <div className="bar-track">
                    <div
                      className={`bar-fill ${barMetric === 'IN' ? 'incoming' : ''}`}
                      style={{
                        width: `${(value / maxBarValue) * 100}%`,
                      }}
                    />
                  </div>
                  <strong>{value}</strong>
                </div>
              );
            })}
          </div>

          <div className="stock-strip" aria-label="Bestand je Sorte">
            {PALLET_TYPES.map((type) => (
              <div key={type.id}>
                <span>{type.name}</span>
                <strong>{stocks[type.id] ?? 0}</strong>
              </div>
            ))}
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
