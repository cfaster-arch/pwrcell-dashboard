import { useEffect, useMemo, useRef, useState } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import {
  Area,
  AreaChart,
  ReferenceLine,
  ResponsiveContainer,
} from "recharts";

/**
 * /flow — full-screen 4-node energy flowchart for the wall kiosk.
 * Four boxes (Solar / Home / Battery / Grid) fill the viewport. Each box
 * shows its live value plus a REAL chart of the last 2 hours (proper kW
 * and time axes — not a decorative sparkline), with animated flow wires
 * between the boxes driven by live telemetry. Tapping a box opens its
 * detailed metric screen. No back button here: this is the main screen.
 */

type Pt = { x: number; y: number };
type Metric = "solar" | "home" | "battery" | "grid";
type SeriesPoint = {
  ts: number;
  solarW?: number | null;
  homeW?: number | null;
  batteryW?: number | null;
  gridW?: number | null;
};
type LivePoint = {
  ts?: number;
  solarW?: number | null;
  homeW?: number | null;
  batteryW?: number | null;
  gridW?: number | null;
  batterySoc?: number | null;
  timezone?: string | null;
} | null;

const IDLE_W = 50;
const POLL_MS = 5000;

const COLORS: Record<Metric, string> = {
  solar: "#e0a04a",
  home: "#e8ede9",
  battery: "#3aae9a",
  grid: "#6d93c2",
};
const DIMS: Record<Metric, string> = {
  solar: "rgb(224 160 74 / 0.16)",
  home: "rgb(232 237 233 / 0.1)",
  battery: "rgb(58 174 154 / 0.16)",
  grid: "rgb(109 147 194 / 0.16)",
};
/** Battery and grid power are signed (charge/discharge, import/export). */
const SIGNED: Record<Metric, boolean> = {
  solar: false,
  home: false,
  battery: true,
  grid: true,
};

function num(v: number | null | undefined): number | null {
  return v == null || Number.isNaN(v) ? null : v;
}
function fmtKw(w: number | null): string {
  if (w == null) return "—";
  const kw = Math.abs(w) / 1000;
  return kw >= 10 ? kw.toFixed(1) : kw.toFixed(2);
}

/** Smoothly tween a displayed number toward its target. */
function useTweened(target: number | null, ms = 600): number | null {
  const [val, setVal] = useState<number | null>(target);
  const fromRef = useRef<number | null>(target);
  const rafRef = useRef(0);
  useEffect(() => {
    if (target == null) {
      setVal(null);
      fromRef.current = null;
      return;
    }
    const from = fromRef.current ?? target;
    if (from === target) {
      setVal(target);
      return;
    }
    const t0 = performance.now();
    cancelAnimationFrame(rafRef.current);
    const tick = (t: number) => {
      const k = Math.min(1, (t - t0) / ms);
      const e = 1 - Math.pow(1 - k, 3);
      const v = from + (target - from) * e;
      setVal(v);
      fromRef.current = v;
      if (k < 1) rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [target, ms]);
  return val;
}

/**
 * Fit a font size so that `text` nearly fills the box on one line — this is
 * the wall-display sizing: as large as the box allows, label and caption
 * overlaid as small chrome top and bottom. Re-runs on resize and when the
 * text changes.
 */
function useFillFont(
  boxRef: React.RefObject<HTMLElement | null>,
  text: string
): { size: number; textRef: React.RefObject<HTMLSpanElement | null> } {
  const textRef = useRef<HTMLSpanElement | null>(null);
  const [size, setSize] = useState(72);
  useEffect(() => {
    const box = boxRef.current;
    const el = textRef.current;
    if (!box || !el) return;
    const fit = () => {
      const maxW = box.clientWidth * 0.96;
      const maxH = box.clientHeight * 0.8;
      let lo = 8;
      let hi = Math.max(16, maxW * 1.5);
      for (let i = 0; i < 14; i++) {
        const mid = (lo + hi) / 2;
        el.style.fontSize = `${mid}px`;
        if (el.scrollWidth <= maxW && el.scrollHeight <= maxH) lo = mid;
        else hi = mid;
      }
      setSize(Math.floor(lo));
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(box);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boxRef, text]);
  return { size, textRef };
}

/** Preview fonts selectable via ?font=bebas|anton|oswald (no param = system). */
const FONT_FAMILIES: Record<string, string> = {
  bebas: '"Bebas Neue", sans-serif',
  anton: '"Anton", sans-serif',
  oswald: '"Oswald", sans-serif',
};

/**
 * A real chart as the background layer of each box: 2-hour power history,
 * correctly scaled — no axes, no grid, just the data behind the number.
 */
function FlowBgChart({
  metric,
  points,
}: {
  metric: Metric;
  points: SeriesPoint[];
}) {
  const color = COLORS[metric];
  const data = useMemo(
    () =>
      points.map((p) => {
        const w = p[`${metric}W` as const];
        return {
          ts: p.ts,
          kw: w == null ? null : Math.round((w / 1000) * 100) / 100,
        };
      }),
    [points, metric]
  );
  if (data.length < 2) return null;
  const gid = `flowbg-${metric}`;
  return (
    <ResponsiveContainer width="100%" height="100%" debounce={50}>
      <AreaChart data={data} margin={{ top: 4, right: 4, left: 4, bottom: 4 }}>
        <defs>
          <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity={0.55} />
            <stop offset="100%" stopColor={color} stopOpacity={0.06} />
          </linearGradient>
        </defs>
        {SIGNED[metric] && (
          <ReferenceLine y={0} stroke="rgb(232 237 233 / 0.3)" strokeDasharray="4 4" />
        )}
        <Area
          type="monotone"
          dataKey="kw"
          stroke={color}
          strokeWidth={2.5}
          fill={`url(#${gid})`}
          dot={false}
          connectNulls={false}
          isAnimationActive={false}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}

function FlowBox(props: {
  label: string;
  metric: Metric;
  value: string;
  sub: string;
  glow: boolean;
  points: SeriesPoint[];
  onOpen: (metric: Metric) => void;
  boxRef: (el: HTMLDivElement | null) => void;
  fontFamily?: string;
}) {
  const color = COLORS[props.metric];
  const dim = DIMS[props.metric];
  const innerRef = useRef<HTMLDivElement | null>(null);
  const { size, textRef } = useFillFont(innerRef, props.value);
  const open = () => props.onOpen(props.metric);
  return (
    <div
      ref={(el) => {
        innerRef.current = el;
        props.boxRef(el);
      }}
      className="flow-box"
      role="button"
      tabIndex={0}
      aria-label={`Open ${props.label.toLowerCase()} charts`}
      onClick={open}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          open();
        }
      }}
      style={{
        borderColor: color,
        boxShadow: props.glow
          ? `0 0 42px ${dim}, inset 0 0 60px ${dim}`
          : `inset 0 0 60px ${dim}`,
      }}
    >
      <div className="flow-chart-bg">
        <FlowBgChart metric={props.metric} points={props.points} />
      </div>
      <div className="flow-head">
        <div className="flow-label" style={{ color }}>
          {props.label}
        </div>
        <div
          className="flow-value"
          style={{
            color,
            fontSize: size,
            fontFamily: props.fontFamily,
            whiteSpace: "nowrap",
            textShadow: `0 0 26px rgb(0 0 0 / 0.95), 0 2px 10px rgb(0 0 0 / 0.95)`,
          }}
        >
          <span ref={textRef} style={{ display: "inline-block" }}>{props.value}</span>
        </div>
        <div className="flow-sub">{props.sub}</div>
      </div>
    </div>
  );
}

function Wire(props: { from: Pt; to: Pt; watts: number | null; reverse?: boolean; color: string }) {
  const w = Math.abs(props.watts ?? 0);
  const active = w > IDLE_W;
  const speed = Math.max(0.3, Math.min(2.4, 2.4 - w / 3500));
  return (
    <line
      x1={props.from.x}
      y1={props.from.y}
      x2={props.to.x}
      y2={props.to.y}
      className={active ? (props.reverse ? "flow-wire flow-wire-rev" : "flow-wire") : "flow-wire-idle"}
      style={{
        stroke: props.color,
        opacity: active ? Math.min(1, 0.35 + w / 2500) : 0.12,
        animationDuration: `${speed}s`,
      }}
    />
  );
}

function FlowPage() {
  const { font } = Route.useSearch();
  const fontFamily = font ? FONT_FAMILIES[font] : FONT_FAMILIES.anton;
  const [point, setPoint] = useState<LivePoint>(null);
  const [error, setError] = useState(false);
  const [notConfigured, setNotConfigured] = useState(false);
  const [series, setSeries] = useState<SeriesPoint[]>([]);
  const navigate = useNavigate();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const boxRefs = useRef<(HTMLDivElement | null)[]>([]);
  const [centers, setCenters] = useState<Pt[]>([]);

  useEffect(() => {
    document.title = "Energy Flow";
  }, []);

  useEffect(() => {
    let dead = false;
    const poll = async () => {
      try {
        const r = await fetch("/api/live", { cache: "no-store" });
        if (!r.ok) throw new Error(String(r.status));
        const j = await r.json();
        if (dead) return;
        setError(false);
        setNotConfigured(j.configured === false);
        setPoint(j.point ?? null);
      } catch {
        if (!dead) setError(true);
      }
    };
    void poll();
    const id = window.setInterval(() => void poll(), POLL_MS);
    return () => {
      dead = true;
      window.clearInterval(id);
    };
  }, []);

  // 2-hour power history charted inside each box. Refreshes every minute —
  // no need to hammer it on the 5s live cadence.
  useEffect(() => {
    let dead = false;
    const load = async () => {
      try {
        const r = await fetch("/api/series?minutes=120", { cache: "no-store" });
        if (!r.ok) return;
        const j = await r.json();
        if (dead || !Array.isArray(j.points)) return;
        setSeries(j.points as SeriesPoint[]);
      } catch {
        /* charts stay empty — the live number is what matters */
      }
    };
    void load();
    const id = window.setInterval(() => void load(), 60_000);
    return () => {
      dead = true;
      window.clearInterval(id);
    };
  }, []);

  // Measure box centers for the wires (SVG sits behind the boxes).
  useEffect(() => {
    const measure = () => {
      const c = containerRef.current;
      if (!c) return;
      const cr = c.getBoundingClientRect();
      setCenters(
        boxRefs.current.map((b) => {
          if (!b) return { x: 0, y: 0 };
          const r = b.getBoundingClientRect();
          return { x: r.left - cr.left + r.width / 2, y: r.top - cr.top + r.height / 2 };
        })
      );
    };
    measure();
    const ro = new ResizeObserver(measure);
    if (containerRef.current) ro.observe(containerRef.current);
    window.addEventListener("orientationchange", measure);
    return () => {
      ro.disconnect();
      window.removeEventListener("orientationchange", measure);
    };
  }, []);

  const solarW = num(point?.solarW);
  const homeW = num(point?.homeW);
  const batteryW = num(point?.batteryW);
  const gridW = num(point?.gridW);
  const soc = num(point?.batterySoc);

  const tSolar = useTweened(solarW);
  const tHome = useTweened(homeW);
  const tGrid = useTweened(gridW);
  const tSoc = useTweened(soc);

  const charging = (batteryW ?? 0) < -IDLE_W;
  const discharging = (batteryW ?? 0) > IDLE_W;
  const importing = (gridW ?? 0) > IDLE_W;
  const exporting = (gridW ?? 0) < -IDLE_W;

  const batterySub = charging
    ? `charging · ${fmtKw(batteryW)} kW`
    : discharging
      ? `discharging · ${fmtKw(batteryW)} kW`
      : "idle";
  const gridSub = importing ? "importing" : exporting ? "exporting" : "idle";
  const solarSub = (solarW ?? 0) > IDLE_W ? "producing" : "idle";

  const ready = centers.length === 4;
  // indices: 0 solar TL, 1 home TR, 2 battery BL, 3 grid BR
  const openMetric = (metric: Metric) =>
    navigate({ to: "/graphs/$metric", params: { metric } });

  return (
    <div className="flow-root" ref={containerRef}>
      <style>{`
        .flow-root { position: fixed; inset: 0; background: #0b0d0c; overflow: hidden; }
        .flow-wires { position: absolute; inset: 0; width: 100%; height: 100%; z-index: 0; }
        .flow-wire { stroke-width: 10; stroke-linecap: round; stroke-dasharray: 26 30;
          animation: flowdash linear infinite; filter: drop-shadow(0 0 8px currentColor); }
        .flow-wire-rev { animation-direction: reverse; }
        .flow-wire-idle { stroke-width: 6; stroke-dasharray: 4 18; }
        @keyframes flowdash { to { stroke-dashoffset: -112; } }
        .flow-grid { position: relative; z-index: 1; display: grid; height: 100dvh;
          grid-template-columns: 1fr 1fr; grid-template-rows: 1fr 1fr;
          gap: clamp(10px, 2vmin, 26px); padding: clamp(10px, 2vmin, 26px); box-sizing: border-box; }
        .flow-box { position: relative; border: 3px solid; border-radius: 22px;
          background: #141816; overflow: hidden; transition: box-shadow 0.8s ease;
          cursor: pointer; }
        .flow-box:focus-visible { outline: 3px solid #e8ede9; outline-offset: -6px; }
        .flow-box:active { transform: scale(0.995); }
        .flow-chart-bg { position: absolute; left: 2%; right: 2%; top: 6%; bottom: 6%;
          z-index: 0; pointer-events: none; opacity: 0.85; }
        .flow-head { position: absolute; z-index: 1; inset: 0;
          display: flex; flex-direction: column; align-items: center; justify-content: center;
          pointer-events: none; }
        .flow-label { position: absolute; top: 3%; font-size: clamp(12px, 2vmin, 26px);
          font-weight: 800; letter-spacing: 0.35em; text-indent: 0.35em; opacity: 0.95; }
        .flow-value { font-weight: 900; line-height: 1;
          white-space: nowrap; font-variant-numeric: tabular-nums;
          font-family: ui-sans-serif, system-ui, "Segoe UI", Roboto, sans-serif; }
        .flow-sub { position: absolute; bottom: 3.5%; font-size: clamp(11px, 1.9vmin, 24px);
          font-weight: 600; letter-spacing: 0.12em; color: #8b958e; text-transform: uppercase; }
        .flow-banner { position: absolute; inset: 0; z-index: 2; display: flex; flex-direction: column;
          align-items: center; justify-content: center; gap: 18px; background: rgb(11 13 12 / 0.92);
          color: #e8ede9; text-align: center; padding: 32px; }
        .flow-banner a { color: #e0a04a; font-size: 20px; }
        .flow-offline { position: absolute; top: 12px; left: 50%; transform: translateX(-50%); z-index: 2;
          background: #d4675a; color: #0b0d0c; font-weight: 800; letter-spacing: 0.2em;
          padding: 8px 22px; border-radius: 999px; font-size: 14px; }
      `}</style>

      {ready && (
        <svg className="flow-wires" aria-hidden>
          {/* solar -> home (top row) */}
          <Wire from={centers[0]} to={centers[1]} watts={solarW} color="#e0a04a" />
          {/* solar -> battery (left column) */}
          <Wire from={centers[0]} to={centers[2]} watts={charging ? batteryW : 0} color="#e0a04a" />
          {/* battery -> home (diagonal) */}
          <Wire from={centers[2]} to={centers[1]} watts={discharging ? batteryW : 0} color="#3aae9a" />
          {/* grid <-> home (right column) */}
          <Wire from={centers[3]} to={centers[1]} watts={importing ? gridW : 0} color="#6d93c2" />
          <Wire from={centers[1]} to={centers[3]} watts={exporting ? gridW : 0} color="#6d93c2" />
        </svg>
      )}

      <div className="flow-grid">
        <FlowBox
          label="SOLAR"
          metric="solar"
          value={tSolar == null ? "—" : fmtKw(tSolar)}
          sub={`${solarSub} · kW`}
          glow={(solarW ?? 0) > 500}
          points={series}
          onOpen={openMetric}
          boxRef={(el) => { boxRefs.current[0] = el; }}
          fontFamily={fontFamily}
        />
        <FlowBox
          label="HOME"
          metric="home"
          value={tHome == null ? "—" : fmtKw(tHome)}
          sub="consuming · kW"
          glow={false}
          points={series}
          onOpen={openMetric}
          boxRef={(el) => { boxRefs.current[1] = el; }}
          fontFamily={fontFamily}
        />
        <FlowBox
          label="BATTERY"
          metric="battery"
          value={tSoc == null ? "—" : `${Math.round(tSoc)}%`}
          sub={batterySub}
          glow={charging || discharging}
          points={series}
          onOpen={openMetric}
          boxRef={(el) => { boxRefs.current[2] = el; }}
          fontFamily={fontFamily}
        />
        <FlowBox
          label="GRID"
          metric="grid"
          value={tGrid == null ? "—" : fmtKw(tGrid)}
          sub={`${gridSub} · kW`}
          glow={importing || exporting}
          points={series}
          onOpen={openMetric}
          boxRef={(el) => { boxRefs.current[3] = el; }}
          fontFamily={fontFamily}
        />
      </div>

      {error && !point && <div className="flow-offline">OFFLINE</div>}
      {error && point && <div className="flow-offline">STALE</div>}
      {notConfigured && (
        <div className="flow-banner">
          <div style={{ fontSize: 28, fontWeight: 800 }}>No system connected</div>
          <div style={{ color: "#8b958e", maxWidth: 520 }}>
            Enter the PWRview login on the main dashboard to start live telemetry.
          </div>
          <a href="/dashboard">Open dashboard</a>
        </div>
      )}
    </div>
  );
}

export const Route = createFileRoute("/_authed/flow")({
  validateSearch: (search: Record<string, unknown>) => ({
    font: typeof search.font === "string" ? search.font : undefined,
  }),
  component: FlowPage,
});
