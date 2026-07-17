import React from 'react';

/**
 * The Pitch tab — the finalized deck, embedded verbatim.
 *
 * The deck (public/pitch-deck.html) is a standalone document: it owns
 * html/body (overflow:hidden, position:fixed), scales a fixed 1280x720 stage
 * off window dimensions, and binds window-level keydown/resize handlers for
 * slide navigation. Inlining it as JSX would mean rewriting all of that and
 * would collide with the console's own global styles and key handling.
 *
 * An iframe gives it the isolated document it already assumes, so the deck
 * ships byte-for-byte unmodified and its arrow-key nav and resize-fit work
 * unchanged. Keyboard focus lands inside the frame on click.
 */
export function PitchStage(): React.JSX.Element {
  return (
    <div className="pitch-stage">
      <iframe className="pitch-frame" src="/pitch-deck.html" title="Donna — Pitch Deck" />
    </div>
  );
}
