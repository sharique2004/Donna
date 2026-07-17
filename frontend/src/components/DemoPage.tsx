import React from 'react';

// §H.3 — Demo tab. An intentionally EMPTY, themed full-bleed container. It exists
// only to host an externally-built demo page that is ingested later; the pipeline
// for that already exists and its content is mounted into the marked slot below.
//
// INGESTION POINT: the externally-built demo page mounts into `#demo-root`
// (the `data-demo-slot` element). Do NOT add fetches, chrome, or placeholder UI
// here beyond the single mount slot and the one muted "Demo" line. Content
// arrives later through that slot.
export function DemoPage() {
  return (
    <div className="demo-page">
      {/* Mount slot for the externally-built demo page (content arrives later). */}
      <section id="demo-root" data-demo-slot />
      <div className="demo-hint">Demo</div>
    </div>
  );
}
