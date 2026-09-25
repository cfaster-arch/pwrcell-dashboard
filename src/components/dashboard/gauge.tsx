import type { CSSProperties } from "react";

export type GaugeZone = {
  fromW: number;
  toW: number;
  color: string;
  opacity?: number;
};

const CX = 110;
const CY = 100;
const A0 = 135; // gauge start angle (bottom-left), degrees, 0 = 3 o'clock, clockwise
const SWEEP = 270;

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function polar(r: number, deg: number): [number, number] {
  const rad = (deg * Math.PI) / 180;
  return [CX + r * Math.cos(rad), CY + r * Math.sin(rad)];
}

function arcPath(r: number, a1: number, a2: number): string {
  const [x1, y1] = polar(r, a1);
  const [x2, y2] = polar(r, a2);
  return (
    `M ${x1.toFixed(2)} ${y1.toFixed(2)} ` +
    `A ${r} ${r} 0 ${a2 - a1 > 180 ? 1 : 0} 1 ${x2.toFixed(2)} ${y2.toFixed(2)}`
  );
}

function angleFor(valueW: number, minW: number, maxW: number): number {
  const t = clamp((valueW - minW) / (maxW - minW || 1), 0, 1);
  return A0 + SWEEP * t;
}

function kwLabel(w: number): string {
  const kw = w / 1000;
  return kw >= 10 || kw <= -10 ? kw.toFixed(0) : kw.toFixed(1);
}

export function Gauge({
  id,
  valueW,
  minW,
  maxW,
  zones,
  accent,
  display,
  unit = "kW",
  socPct = null,
  ariaLabel,
}: {
  id: string;
  valueW: number | null;
  minW: number;
  maxW: number;
  zones: GaugeZone[];
  accent: string;
  display: string;
  unit?: string;
  socPct?: number | null;
  ariaLabel: string;
}) {
  const angle = valueW == null ? null : angleFor(valueW, minW, maxW);
  const zeroAngle = minW < 0 && maxW > 0 ? angleFor(0, minW, maxW) : null;

  const ticks: { major: boolean; x1: number; y1: number; x2: number; y2: number }[] = [];
  for (let i = 0; i <= 45; i++) {
    const a = A0 + (SWEEP / 45) * i;
    const major = i % 5 === 0;
    const [x1, y1] = polar(80, a);
    const [x2, y2] = polar(major ? 68 : 74, a);
    ticks.push({ major, x1, y1, x2, y2 });
  }

  const needleStyle: CSSProperties =
    angle == null
      ? { display: "none" }
      : {
          transform: `rotate(${angle.toFixed(2)}deg)`,
          transformOrigin: `${CX}px ${CY}px`,
          transformBox: "view-box",
          transition: "transform 600ms cubic-bezier(0.22,1,0.36,1)",
        };

  return (
    <svg
      viewBox="0 0 220 178"
      className="h-auto w-full"
      role="img"
      aria-label={ariaLabel}
    >
      <defs>
        <linearGradient id={`${id}-glass`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#ffffff" stopOpacity="0.07" />
          <stop offset="55%" stopColor="#ffffff" stopOpacity="0" />
        </linearGradient>
      </defs>

      {/* bezel */}
      <path
        d={arcPath(98, A0, A0 + SWEEP)}
        fill="none"
        stroke="var(--gauge-track)"
        strokeWidth="2.5"
      />
      {/* glass sheen */}
      <path
        d={arcPath(90, 195, 345)}
        fill="none"
        stroke={`url(#${id}-glass)`}
        strokeWidth="16"
        strokeLinecap="round"
      />

      {/* SoC ring (battery) */}
      {socPct != null ? (
        <g>
          <path
            d={arcPath(92, A0, A0 + SWEEP)}
            fill="none"
            stroke="var(--gauge-hub)"
            strokeWidth="4"
          />
          <path
            d={arcPath(92, A0, A0 + SWEEP * clamp(socPct, 0, 100) / 100)}
            fill="none"
            strokeWidth="4"
            strokeLinecap="round"
            style={{ transition: "d 600ms", stroke: accent }}
          />
        </g>
      ) : null}

      {/* colored zones */}
      {zones.map((z, i) => (
        <path
          key={i}
          d={arcPath(86, angleFor(z.fromW, minW, maxW), angleFor(z.toW, minW, maxW))}
          fill="none"
          stroke={z.color}
          strokeOpacity={z.opacity ?? 1}
          strokeWidth="10"
        />
      ))}

      {/* ticks */}
      {ticks.map((t, i) => (
        <line
          key={i}
          x1={t.x1}
          y1={t.y1}
          x2={t.x2}
          y2={t.y2}
          stroke="var(--gauge-tick)"
          strokeOpacity={t.major ? 0.55 : 0.22}
          strokeWidth={t.major ? 2 : 1}
        />
      ))}
      {/* major labels */}
      {ticks
        .filter((t) => t.major)
        .map((t, i) => {
          const v = minW + ((maxW - minW) / 9) * i;
          const [x, y] = polar(57, A0 + (SWEEP / 9) * i);
          return (
            <text
              key={i}
              x={x}
              y={y}
              textAnchor="middle"
              dominantBaseline="central"
              fontSize="9.5"
              fill="var(--gauge-label)"
              className="font-mono"
            >
              {kwLabel(v)}
            </text>
          );
        })}
      {/* zero marker on bidirectional gauges */}
      {zeroAngle != null ? (
        <line
          x1={polar(80, zeroAngle)[0]}
          y1={polar(80, zeroAngle)[1]}
          x2={polar(64, zeroAngle)[0]}
          y2={polar(64, zeroAngle)[1]}
          strokeWidth="2.5"
          style={{ stroke: accent }}
        />
      ) : null}

      {/* needle */}
      <g style={needleStyle}>
        <polygon
          points={`${CX + 70},${CY} ${CX - 12},${CY - 3.4} ${CX - 12},${CY + 3.4}`}
          opacity="0.95"
          style={{ fill: accent }}
        />
        <circle cx={CX - 15} cy={CY} r="4.5" opacity="0.7" style={{ fill: accent }} />
      </g>
      {/* hub */}
      <circle cx={CX} cy={CY} r="9.5" fill="var(--gauge-hub)" strokeWidth="2" style={{ stroke: accent }} />
      <circle cx={CX} cy={CY} r="3" style={{ fill: accent }} />

      {/* digital readout */}
      <rect
        x="56"
        y="120"
        width="108"
        height="30"
        rx="7"
        fill="var(--gauge-well)"
        stroke="var(--gauge-well-border)"
      />
      <text
        x="102"
        y="141"
        textAnchor="end"
        dominantBaseline="central"
        fontSize="16.5"
        fill="var(--gauge-well-text)"
        className="font-mono"
        style={{ fontVariantNumeric: "tabular-nums" }}
      >
        {display}
      </text>
      <text
        x="106"
        y="142"
        textAnchor="start"
        dominantBaseline="central"
        fontSize="10"
        fill="var(--gauge-label)"
        className="font-mono"
      >
        {unit}
      </text>
      {socPct != null ? (
        <text
          x="110"
          y="164"
          textAnchor="middle"
          fontSize="10.5"
          className="font-mono"
          style={{ fontVariantNumeric: "tabular-nums", fill: accent }}
        >
          {Math.round(socPct)}% SoC
        </text>
      ) : null}
    </svg>
  );
}
