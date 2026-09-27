import { useEffect, useRef, useState } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";

/**
 * /flow — full-screen 4-node energy flowchart for the wall kiosk.
 * Nothing but four boxes (Solar / Home / Battery / Grid) filling the
 * viewport, each with a giant auto-fit value, a faint 2-hour power
 * sparkline behind the number, animated flow wires between them driven
 * by live telemetry, and the dashboard's normal login gate
 * (inherited from _authed: session required, temp-password enforced).
 * Tapping a box opens its metric graphs page.
 */

type Pt = { x: number; y: number };
type LivePoint = {
  ts?: number;
  solarW?: number | null;
  homeW?: number | null;
  batteryW?: number | null;
  gridW?: number | null;
  batterySoc?: number | null;
} | null;

const IDLE_W = 50;
const POLL_MS = 5000;

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
 * Binary-search the largest font size that lets `textRef` fit inside
 * `boxRef` on one line. Re-runs on resize and when the text changes.
 */
function useFitFont(
  boxRef: React.RefObject<HTMLElement | null>,
  text: string
): { size: number; textRef: React.RefObject<HTMLSpanElement | null> } {
  const textRef = useRef<HTMLSpanElement | null>(null);
  const [size, setSize] = useState(96);
  useEffect(() => {
    const box = boxRef.current;
    const el = textRef.current;
    if (!box || !el) return;
    const fit = () => {
      const maxW = box.clientWidth * 0.92;
      const maxH = box.clientHeight * 0.62;
      let lo = 8;
      let hi = Math.max(16, Math.min(maxW, maxH * 1.6));
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

function FlowBox(props: {
  label: string;
  metric: "solar" | "home" | "battery" | "grid";
  value: string;
  sub: string;
  color: string;
  dim: string;
  glow: boolean;
  spark: (number | null)[];
  onOpen: (metric: "solar" | "home" | "battery" | "grid") => void;
  boxRef: (el: HTMLDivElement | null) => void;
}) {
  const innerRef = useRef<HTMLDivElement | null>(null);
  const fit = useFitFont(innerRef, props.value);
  const open = () => props.onOpen(props.metric);
  return (
    <div
      ref={props.boxRef}
      className="flow-box"
      role="button"
      tabIndex={0}
      aria-label={`Open ${props.label.toLowerCase()} graphs`}
      onClick={open}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          open();
        }
      }}
      style={{ borderColor: props.color, boxShadow: props.glow ? `0 0 42px ${props.dim}, inset 0 0 60px ${props.dim}` : `inset 0 0 60px ${props.dim}` }}
    >
      <Sparkline values={props.spark} color={props.color} />
      <div className="flow-label" style={{ color: props.color }}>{props.label}</div>
      <div className="flow-value-wrap" ref={innerRef}>
        <span
          ref={fit.textRef}
          className="flow-value"
          style={{ fontSize: fit.size, color: props.color, textShadow: `0 0 24px ${props.dim}, 0 2px 12px rgb(0 0 0 / 0.8)` }}
        >
          {props.value}
        </span>
      </div>
      <div className="flow-sub">{props.sub}</div>
    </div>
  );
}

/** Faint area sparkline drawn behind a box's number. Purely decorative. */
function Sparkline(props: { values: (number | null)[]; color: string }) {
  const pts = props.values.map((v) => v ?? 0);
  if (pts.length < 2) return null;
  let min = pts[0];
  let max = pts[0];
  for (const v of pts) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const span = max - min || 1;
  const step = 100 / (pts.length - 1);
  const line = pts
    .map((v, i) => {
      const x = (i * step).toFixed(2);
      const y = (37 - ((v - min) / span) * 34).toFixed(2);
      return `${i === 0 ? "M" : "L"}${x},${y}`;
    })
    .join(" ");
  return (
    <svg className="flow-spark" viewBox="0 0 100 40" preserveAspectRatio="none" aria-hidden="true">
      <path d={`${line} L100,40 L0,40 Z`} fill={props.color} opacity={0.13} />
      <path
        d={line}
        fill="none"
        stroke={props.color}
        strokeWidth={1.5}
        opacity={0.45}
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
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
  const [point, setPoint] = useState<LivePoint>(null);
  const [error, setError] = useState(false);
  const [notConfigured, setNotConfigured] = useState(false);
  const [spark, setSpark] = useState<{
    solar: (number | null)[];
    home: (number | null)[];
    battery: (number | null)[];
    grid: (number | null)[];
  }>({ solar: [], home: [], battery: [], grid: [] });
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

  // 2-hour power history behind each number. Refreshes every minute —
  // no need to hammer it on the 5s live cadence.
  useEffect(() => {
    let dead = false;
    const load = async () => {
      try {
        const r = await fetch("/api/series?minutes=120", { cache: "no-store" });
        if (!r.ok) return;
        const j = await r.json();
        if (dead || !Array.isArray(j.points)) return;
        setSpark({
          solar: j.points.map((p: any) => (p.solarW ?? null) as number | null),
          home: j.points.map((p: any) => (p.homeW ?? null) as number | null),
          battery: j.points.map((p: any) => (p.batteryW ?? null) as number | null),
          grid: j.points.map((p: any) => (p.gridW ?? null) as number | null),
        });
      } catch {
        /* sparkline stays empty — the live number is what matters */
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
  const openMetric = (metric: "solar" | "home" | "battery" | "grid") =>
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
          background: #141816; display: flex; flex-direction: column; align-items: center;
          justify-content: center; overflow: hidden; transition: box-shadow 0.8s ease;
          cursor: pointer; }
        .flow-box:focus-visible { outline: 3px solid #e8ede9; outline-offset: -6px; }
        .flow-box:active { transform: scale(0.995); }
        .flow-spark { position: absolute; left: 3%; right: 3%; top: 50%; transform: translateY(-50%);
          width: 94%; height: 52%; z-index: 0; pointer-events: none; }
        .flow-label { position: absolute; z-index: 1; top: 4%; font-size: clamp(14px, 2.6vmin, 30px);
          font-weight: 800; letter-spacing: 0.35em; text-indent: 0.35em; opacity: 0.95; }
        .flow-value-wrap { position: relative; z-index: 1; width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; }
        .flow-value { font-weight: 900; line-height: 1; white-space: nowrap; font-variant-numeric: tabular-nums;
          font-family: ui-sans-serif, system-ui, "Segoe UI", Roboto, sans-serif; }
        .flow-sub { position: absolute; z-index: 1; bottom: 4.5%; font-size: clamp(13px, 2.4vmin, 28px);
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
          color="#e0a04a"
          dim="rgb(224 160 74 / 0.16)"
          glow={(solarW ?? 0) > 500}
          spark={spark.solar}
          onOpen={openMetric}
          boxRef={(el) => { boxRefs.current[0] = el; }}
        />
        <FlowBox
          label="HOME"
          metric="home"
          value={tHome == null ? "—" : fmtKw(tHome)}
          sub="consuming · kW"
          color="#e8ede9"
          dim="rgb(232 237 233 / 0.1)"
          glow={false}
          spark={spark.home}
          onOpen={openMetric}
          boxRef={(el) => { boxRefs.current[1] = el; }}
        />
        <FlowBox
          label="BATTERY"
          metric="battery"
          value={tSoc == null ? "—" : `${Math.round(tSoc)}%`}
          sub={batterySub}
          color="#3aae9a"
          dim="rgb(58 174 154 / 0.16)"
          glow={charging || discharging}
          spark={spark.battery}
          onOpen={openMetric}
          boxRef={(el) => { boxRefs.current[2] = el; }}
        />
        <FlowBox
          label="GRID"
          metric="grid"
          value={tGrid == null ? "—" : fmtKw(tGrid)}
          sub={`${gridSub} · kW`}
          color="#6d93c2"
          dim="rgb(109 147 194 / 0.16)"
          glow={importing || exporting}
          spark={spark.grid}
          onOpen={openMetric}
          boxRef={(el) => { boxRefs.current[3] = el; }}
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
  component: FlowPage,
});
