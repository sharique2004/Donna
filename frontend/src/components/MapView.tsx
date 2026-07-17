import React, { useEffect, useMemo, useState } from 'react';
import { MapContainer, TileLayer, CircleMarker, Marker, Polyline, Popup, ZoomControl, useMap } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { useDonna } from '../state';
import type { Recipient, ScoreBreakdown } from '../types';
import type { DemoRoute } from '../demoBus';
import { useDemoBus } from '../demoBus';
import {
  scoreColor, HARDFAIL_LABELS, fmtMiles, fmtHours,
  FOOD_BANK, routeVia, FLOW_DIRECT, FLOW_STORE, ROUTE_DIM,
} from '../theme';

const SF_CENTER: [number, number] = [37.7749, -122.4194];
const FB: [number, number] = [FOOD_BANK.lat, FOOD_BANK.lng];

const pickupIcon = L.divIcon({
  className: '',
  html: '<div class="pickup-pin"><div class="ring"></div><div class="core"></div></div>',
  iconSize: [14, 14],
  iconAnchor: [7, 7],
});

// Food-bank home base marker (§I.3): a quiet rotated-square diamond + label.
// Rendered ALWAYS, on both tabs, even when the demo bus is idle. Display-only —
// the backend has no depot (see theme.ts FOOD_BANK).
const foodBankIcon = L.divIcon({
  className: '',
  html: `<div class="fb-marker"><div class="fb-diamond"></div><div class="fb-label">${FOOD_BANK.name}</div></div>`,
  iconSize: [12, 12],
  iconAnchor: [6, 6],
});

// Emphasized pulse ring dropped at route endpoints while a demo route is drawn.
const endpointPulseIcon = L.divIcon({
  className: '',
  html: '<div class="rt-pulse"><div class="rt-ring"></div><div class="rt-core"></div></div>',
  iconSize: [12, 12],
  iconAnchor: [6, 6],
});

// Muted-red pulse ring at a pickup that found no takers (failedAtPickup) — no route.
const failedPulseIcon = L.divIcon({
  className: '',
  html: '<div class="rt-pulse fail"><div class="rt-ring"></div><div class="rt-core"></div></div>',
  iconSize: [12, 12],
  iconAnchor: [6, 6],
});

// ---- Arc (§I.3) ----------------------------------------------------------
// A quadratic-bezier arc between two points, sampled to 64 segments with the
// control point pushed perpendicular to the chord by ~15% of the chord length,
// then drawn-in over ~900ms by slicing the sampled points on requestAnimationFrame.
// State-driven only — we never touch leaflet's SVG internals or CSS-animate the
// path (that fights leaflet on pan/zoom).
const ARC_SAMPLES = 64;
const ARC_DRAW_MS = 900;
type ArcKind = DemoRoute['kind'] | 'preview';

function bezierPoints(from: [number, number], to: [number, number]): Array<[number, number]> {
  // Treat lat as y, lng as x; the small-angle distortion is negligible at city scale.
  const [y0, x0] = from;
  const [y1, x1] = to;
  const dx = x1 - x0;
  const dy = y1 - y0;
  const chord = Math.hypot(dx, dy);
  const off = chord * 0.15;
  // Perpendicular unit vector to the chord (−dy, dx)/|chord|.
  const nx = chord === 0 ? 0 : -dy / chord;
  const ny = chord === 0 ? 0 : dx / chord;
  const cx = (x0 + x1) / 2 + nx * off;
  const cy = (y0 + y1) / 2 + ny * off;
  const pts: Array<[number, number]> = [];
  for (let i = 0; i <= ARC_SAMPLES; i++) {
    const t = i / ARC_SAMPLES;
    const mt = 1 - t;
    const x = mt * mt * x0 + 2 * mt * t * cx + t * t * x1;
    const y = mt * mt * y0 + 2 * mt * t * cy + t * t * y1;
    pts.push([y, x]);
  }
  return pts;
}

function arcStyle(kind: ArcKind): L.PathOptions {
  switch (kind) {
    case 'direct':
      return { color: FLOW_DIRECT, weight: 3, opacity: 0.95, lineCap: 'round' };
    case 'store-leg1':
      return { color: FLOW_STORE, weight: 3, opacity: 0.95, lineCap: 'round' };
    case 'store-leg2':
      return { color: FLOW_STORE, weight: 3, opacity: 0.95, lineCap: 'round', dashArray: '6 9' };
    case 'preview':
    default:
      return { color: ROUTE_DIM, weight: 2, opacity: 1, lineCap: 'round', dashArray: '4 7' };
  }
}

function Arc({ from, to, kind }: { from: [number, number]; to: [number, number]; kind: ArcKind }) {
  const full = useMemo(
    () => bezierPoints(from, to),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [from[0], from[1], to[0], to[1]],
  );
  // Preview arcs (dispatch-tab hover) render whole; narrative arcs draw in.
  const [n, setN] = useState(kind === 'preview' ? full.length : 2);
  useEffect(() => {
    if (kind === 'preview') { setN(full.length); return; }
    let raf = 0;
    const start = performance.now();
    const tick = (now: number) => {
      const p = Math.min(1, (now - start) / ARC_DRAW_MS);
      setN(Math.max(2, Math.round(p * full.length)));
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [full, kind]);
  return <Polyline positions={full.slice(0, n)} pathOptions={arcStyle(kind)} />;
}

// ---- DemoLayer (§I.3) ----------------------------------------------------
// Subscribes to the demo bus and paints the routing narrative over the tiles:
// the food-bank diamond (always), the bus route arcs, an emphasized pulse ring
// at each route endpoint, and a muted-red pulse at the pickup on failure. It
// imports nothing from DemoStage — the bus is the only shared surface, so a
// crash in the stage can never take the map down.
function DemoLayer() {
  const bus = useDemoBus();
  return (
    <>
      <Marker position={FB} icon={foodBankIcon} zIndexOffset={800}>
        <Popup>
          <div className="pop">
            <h4>{FOOD_BANK.name}</h4>
            <div className="sub">Home base · allocation warehouse</div>
          </div>
        </Popup>
      </Marker>

      {bus.routes.map((r) => (
        <Arc key={r.id} from={r.from} to={r.to} kind={r.kind} />
      ))}

      {bus.routes.map((r) => (
        <Marker key={`ep-${r.id}`} position={r.to} icon={endpointPulseIcon} zIndexOffset={700} />
      ))}

      {bus.failedAtPickup && bus.pickup && (
        <Marker
          position={[bus.pickup.lat, bus.pickup.lng]}
          icon={failedPulseIcon}
          zIndexOffset={900}
        />
      )}
    </>
  );
}

// FitBounds: fits to the supplied points on change. During a demo the bus owns
// the frame (route endpoints + food bank), so MapView feeds those points here
// instead of the recipient/pickup set.
function FitBounds({ pts }: { pts: Array<[number, number]> }) {
  const map = useMap();
  useEffect(() => {
    if (pts.length === 0) return;
    if (pts.length === 1) { map.setView(pts[0], 13, { animate: true }); return; }
    const bounds = L.latLngBounds(pts);
    map.fitBounds(bounds, { padding: [90, 90], maxZoom: 14, animate: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, JSON.stringify(pts)]);
  return null;
}

export function MapView() {
  const {
    current, recipients, recipientsById, activeRankings,
    selectedItemId, selectedRecipientId, selectRecipient,
  } = useDonna();
  const bus = useDemoBus();

  const donation = current?.donation ?? null;
  const pickup: [number, number] | null =
    donation && donation.pickupLat != null && donation.pickupLng != null
      ? [donation.pickupLat, donation.pickupLng] : null;

  const scoreById = useMemo(() => {
    const m: Record<string, ScoreBreakdown> = {};
    for (const r of activeRankings) m[r.recipient.id] = r.score;
    return m;
  }, [activeRankings]);

  const focusSet = useMemo(() => new Set(bus.focusRecipientIds), [bus.focusRecipientIds]);

  // Dispatch-tab routes (§I.3) derived from useDonna state directly — NOT the
  // bus. The bus (demo tab) takes over the map when active, so we suppress these
  // then. Guard: pickupLat/pickupLng are optional; without them this is a no-op.
  const dispatchRoutes = useMemo<Array<{ id: string; from: [number, number]; to: [number, number]; kind: ArcKind }>>(() => {
    if (bus.active || !pickup) return [];
    const item = selectedItemId ? donation?.items.find((i) => i.id === selectedItemId) : null;
    if (!item) return [];
    if (item.status === 'matched' && item.matchedRecipientId) {
      const rec = recipientsById[item.matchedRecipientId];
      if (!rec) return [];
      const dest: [number, number] = [rec.lat, rec.lng];
      if (routeVia(item.hoursToSpoil) === 'store') {
        return [
          { id: `disp-${item.id}-leg1`, from: pickup, to: FB, kind: 'store-leg1' },
          { id: `disp-${item.id}-leg2`, from: FB, to: dest, kind: 'store-leg2' },
        ];
      }
      return [{ id: `disp-${item.id}-direct`, from: pickup, to: dest, kind: 'direct' }];
    }
    if (item.status === 'pending' && selectedRecipientId) {
      const rec = recipientsById[selectedRecipientId];
      if (!rec) return [];
      return [{ id: `disp-preview-${item.id}-${rec.id}`, from: pickup, to: [rec.lat, rec.lng], kind: 'preview' }];
    }
    return [];
  }, [bus.active, pickup, selectedItemId, donation, recipientsById, selectedRecipientId]);

  // Bus owns the frame while routes exist; otherwise fit to recipients + pickup.
  const fitPts = useMemo<Array<[number, number]>>(() => {
    if (bus.active && bus.routes.length > 0) {
      const arr: Array<[number, number]> = [FB];
      for (const r of bus.routes) { arr.push(r.from); arr.push(r.to); }
      if (bus.pickup) arr.push([bus.pickup.lat, bus.pickup.lng]);
      return arr;
    }
    const arr: Array<[number, number]> = recipients.map((r) => [r.lat, r.lng]);
    if (pickup) arr.push(pickup);
    return arr;
  }, [bus.active, bus.routes, bus.pickup, recipients, pickup]);

  return (
    <div className="map-hero">
      <MapContainer center={pickup || SF_CENTER} zoom={12} zoomControl={false} scrollWheelZoom style={{ height: '100%', width: '100%' }}>
        <ZoomControl position="bottomright" />
        <TileLayer
          url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>'
          subdomains="abcd"
          maxZoom={20}
        />
        <FitBounds pts={fitPts} />

        {recipients.map((r) => {
          const score = scoreById[r.id];
          const color = scoreColor(score);
          const selected = selectedRecipientId === r.id;
          const rank = activeRankings.findIndex((x) => x.recipient.id === r.id);
          // While a demo plays, recipients that aren't the focus recede to ~25%.
          const dimmed = bus.active && !focusSet.has(r.id);
          const fillOpacity = dimmed ? 0.25 : (score?.hardFail ? 0.35 : 0.82);
          return (
            <CircleMarker
              key={r.id}
              center={[r.lat, r.lng]}
              radius={selected ? 12 : 8}
              pathOptions={{
                color: selected ? '#ffffff' : color,
                weight: selected ? 2.5 : 1.5,
                fillColor: color,
                fillOpacity,
                opacity: dimmed ? 0.4 : 1,
              }}
              eventHandlers={{ click: () => selectRecipient(r.id) }}
            >
              <Popup>
                <RecipientPopup r={r} score={score} rank={rank >= 0 ? rank + 1 : undefined} />
              </Popup>
            </CircleMarker>
          );
        })}

        {pickup && (
          <Marker position={pickup} icon={pickupIcon} zIndexOffset={1000}>
            <Popup>
              <div className="pop">
                <h4>{donation?.donorName || 'Pickup'}</h4>
                <div className="sub">{donation?.pickupLocation}</div>
              </div>
            </Popup>
          </Marker>
        )}

        {dispatchRoutes.map((r) => (
          <Arc key={r.id} from={r.from} to={r.to} kind={r.kind} />
        ))}

        <DemoLayer />
      </MapContainer>

      {/* Non-interactive vignette (§I.1) so floating panels read against tiles.
          NOT backdrop-blur (§H ban) — a plain radial darkening of the edges. */}
      <div className="map-vignette" />

      <div className="map-legend">
        <div className="ramp-bar" />
        <div className="ramp-scale"><span>low</span><span>match</span><span>high</span></div>
        <div className="lg-row"><span className="swx grey" /> not feasible</div>
        <div className="lg-row"><span className="swx pickup" /> pickup</div>
        <div className="lg-row"><span className="swx route direct" /> direct route</div>
        <div className="lg-row"><span className="swx route store" /> via warehouse</div>
      </div>
    </div>
  );
}

function RecipientPopup({ r, score, rank }: { r: Recipient; score?: ScoreBreakdown; rank?: number }) {
  return (
    <div className="pop">
      <h4>{rank ? `#${rank} · ` : ''}{r.name}</h4>
      <div className="sub">{r.type === 'pantry' ? 'Pantry' : 'Community agency'} · {r.leadContact}</div>
      {!score ? (
        <div className="sub">No ranking for this item.</div>
      ) : score.hardFail ? (
        <div className="pop-fail">✕ {HARDFAIL_LABELS[score.hardFail]}</div>
      ) : (
        <>
          <div className="pop-total">{score.total.toFixed(2)}</div>
          <div className="pop-meta">
            <span>{fmtMiles(score.distanceMiles)}</span>
            <span>{fmtHours(score.driveTimeHours)} drive</span>
          </div>
        </>
      )}
    </div>
  );
}
