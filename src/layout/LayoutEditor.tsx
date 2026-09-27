import { useEffect, useMemo, useRef, useState, type PointerEvent } from 'react';
import type { UphoffLocalDb } from '../persistence/localDb';
import {
  defaultLayout,
  moveItem,
  resizeItem,
  type LayoutDocument,
  type LayoutItem,
  type LayoutProfile,
} from './layout';
import { loadLayout, saveLayout } from './storage';

interface Props {
  db: UphoffLocalDb;
  profile: LayoutProfile;
  onSaved: (layout: LayoutDocument) => void;
  onClose: () => void;
}

type Gesture =
  | {
      kind: 'MOVE';
      itemId: LayoutItem['id'];
      pointerId: number;
      startX: number;
      startY: number;
      original: LayoutItem;
    }
  | {
      kind: 'RESIZE';
      itemId: LayoutItem['id'];
      pointerId: number;
      startX: number;
      startY: number;
      original: LayoutItem;
    };

const LABELS: Record<LayoutItem['id'], string> = {
  TOTAL: 'Gesamtbestand',
  MODE: 'Eingang / Ausgang',
  PALLETS: '7 Palettenzeilen',
  LAST_ACTION: 'Letzter Vorgang',
};

export function LayoutEditor({
  db,
  profile,
  onSaved,
  onClose,
}: Props) {
  const [confirmed, setConfirmed] = useState(false);
  const [draft, setDraft] = useState<LayoutDocument>(() => defaultLayout(profile));
  const [loaded, setLoaded] = useState(false);
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const gestureRef = useRef<Gesture | null>(null);

  useEffect(() => {
    let cancelled = false;
    void loadLayout(db, profile).then((layout) => {
      if (cancelled) return;
      setDraft(layout);
      setLoaded(true);
    });
    return () => {
      cancelled = true;
    };
  }, [db, profile]);

  const itemMap = useMemo(
    () => Object.fromEntries(draft.items.map((item) => [item.id, item])),
    [draft],
  );

  const updateGesture = (event: PointerEvent<HTMLDivElement>) => {
    const gesture = gestureRef.current;
    const canvas = canvasRef.current;
    if (!gesture || !canvas || gesture.pointerId !== event.pointerId) return;

    const box = canvas.getBoundingClientRect();
    const cellW = box.width / draft.cols;
    const cellH = box.height / draft.rows;
    const dx = (event.clientX - gesture.startX) / cellW;
    const dy = (event.clientY - gesture.startY) / cellH;

    setDraft((current) => {
      if (gesture.kind === 'MOVE') {
        return moveItem(
          current,
          gesture.itemId,
          gesture.original.x + dx,
          gesture.original.y + dy,
        );
      }

      return resizeItem(
        current,
        gesture.itemId,
        gesture.original.w + dx,
        gesture.original.h + dy,
      );
    });
  };

  const endGesture = (event: PointerEvent<HTMLDivElement>) => {
    if (gestureRef.current?.pointerId === event.pointerId) {
      gestureRef.current = null;
    }
  };

  const beginMove = (
    event: PointerEvent<HTMLDivElement>,
    item: LayoutItem,
  ) => {
    if (item.locked) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    gestureRef.current = {
      kind: 'MOVE',
      itemId: item.id,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      original: { ...item },
    };
  };

  const beginResize = (
    event: PointerEvent<HTMLButtonElement>,
    item: LayoutItem,
  ) => {
    if (item.locked) return;
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    gestureRef.current = {
      kind: 'RESIZE',
      itemId: item.id,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      original: { ...item },
    };
  };

  if (!confirmed) {
    return (
      <div className="layout-overlay" role="dialog" aria-modal="true" aria-label="Layout bearbeiten">
        <section className="layout-confirm">
          <span>LAYOUT-EDITOR</span>
          <h2>Layout bearbeiten?</h2>
          <p>
            Während der Bearbeitung sind Buchungen gesperrt. Bestände und Buchungsdaten
            werden dabei nicht verändert.
          </p>
          <div className="layout-confirm-actions">
            <button onClick={onClose}>ABBRECHEN</button>
            <button className="primary" onClick={() => setConfirmed(true)}>
              BEARBEITEN
            </button>
          </div>
        </section>
      </div>
    );
  }

  return (
    <div className="layout-overlay" role="dialog" aria-modal="true" aria-label="Layout Editor">
      <section className="layout-panel">
        <header>
          <div>
            <span>LAYOUT-EDITOR</span>
            <strong>{profile === 'PHONE_PORTRAIT' ? 'iPhone Hochformat' : 'iPad Hochformat'}</strong>
          </div>
          <button onClick={onClose} aria-label="Layout Editor schließen">×</button>
        </header>

        <p className="layout-help">
          Elemente ziehen. Unten rechts skalieren. Die Palettenzeilen bleiben aus Sicherheitsgründen gesperrt.
        </p>

        <div
          ref={canvasRef}
          className="layout-canvas"
          data-loaded={loaded ? 'true' : 'false'}
          onPointerMove={updateGesture}
          onPointerUp={endGesture}
          onPointerCancel={endGesture}
        >
          {draft.items.map((item) => (
            <div
              key={item.id}
              className={`layout-item ${item.locked ? 'locked' : ''}`}
              data-layout-id={item.id}
              style={{
                left: `${(item.x / draft.cols) * 100}%`,
                top: `${(item.y / draft.rows) * 100}%`,
                width: `${(item.w / draft.cols) * 100}%`,
                height: `${(item.h / draft.rows) * 100}%`,
              }}
              onPointerDown={(event) => beginMove(event, item)}
            >
              <span>{LABELS[item.id]}</span>
              {item.locked ? (
                <small>GESPERRT</small>
              ) : (
                <button
                  className="resize-handle"
                  aria-label={`${LABELS[item.id]} Größe ändern`}
                  onPointerDown={(event) => beginResize(event, item)}
                />
              )}
            </div>
          ))}
        </div>

        <div className="layout-profile-readout">
          <span>Raster 12 × 16</span>
          <span>{Object.keys(itemMap).length} Elemente</span>
          <span>Lokal auf diesem Gerät</span>
        </div>

        <footer>
          <button onClick={() => setDraft(defaultLayout(profile))}>STANDARD</button>
          <button onClick={onClose}>ABBRECHEN</button>
          <button
            className="primary"
            onClick={() => {
              void saveLayout(db, draft).then(() => {
                onSaved(draft);
                onClose();
              });
            }}
          >
            SPEICHERN
          </button>
        </footer>
      </section>
    </div>
  );
}
