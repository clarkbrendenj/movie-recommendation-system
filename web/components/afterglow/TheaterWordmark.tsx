"use client";

import { useId } from "react";
import { APP_NAME, APP_TAGLINE } from "../../lib/app-brand.mjs";
import "./theater-wordmark.css";

/** Scalable live lettering, with warm bulbs printed inside the marquee letters. */
export function TheaterWordmark({ compact = false }: { compact?: boolean }) {
  const id = `midnight-sign-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const bulbs = `${id}-bulbs`, title = `${id}-title`;
  const lettering = { x: 200, y: 104, textAnchor: "middle" as const, textLength: 366, lengthAdjust: "spacingAndGlyphs" as const };

  return <span className={`brand-placard theater-wordmark${compact ? " theater-wordmark-compact" : ""}`}>
    <svg className="theater-wordmark-art" viewBox="0 0 400 134" role="img" aria-labelledby={title} focusable="false">
      <title id={title}>{APP_NAME}</title>
      <defs>
        <pattern id={bulbs} width="9" height="9" patternUnits="userSpaceOnUse">
          <circle cx="4.5" cy="4.5" r="2" fill="#7c3e14" />
          <circle cx="4.5" cy="4.5" r="1.5" fill="#f6cb64" />
          <circle cx="4.5" cy="4.5" r=".8" fill="#fff8c6" />
        </pattern>
      </defs>
      <g aria-hidden="true">
        <path className="theater-wordmark-rule" d="M18 20H55M345 20H382" />
        <path className="theater-wordmark-diamond" d="m64 17 3 3-3 3-3-3Zm272 0 3 3-3 3-3-3Z" />
        <text className="theater-wordmark-kicker" x="200" y="29" textAnchor="middle" textLength="260" lengthAdjust="spacingAndGlyphs">THE MIDNIGHT</text>
        <text {...lettering} className="theater-wordmark-letter theater-wordmark-outline">THEATER</text>
        <text {...lettering} className="theater-wordmark-letter theater-wordmark-face">THEATER</text>
        <text {...lettering} className="theater-wordmark-letter theater-wordmark-bulbs" fill={`url(#${bulbs})`}>THEATER</text>
        <path className="theater-wordmark-rule theater-wordmark-bottom-rule" d="M24 122H179M221 122H376" />
        <path className="theater-wordmark-diamond" d="m194 118 4 4-4 4-4-4Zm12 0 4 4-4 4-4-4Z" />
      </g>
    </svg>
    {!compact && <small className="theater-wordmark-tagline">{APP_TAGLINE}</small>}
  </span>;
}
