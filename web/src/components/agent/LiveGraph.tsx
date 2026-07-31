import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { Tick } from "@/lib/agent-types";
import { clock } from "@/lib/format";
import { useVariant } from "@/lib/variants";

type Marker = { t: number; eventId: string };
export type Annotation = { t: number; eventId: string; label: string; tone?: string };

const W = 640;
const H = 190;
const AXIS_W = 60; // right price gutter (px)
const AXIS_H = 22; // bottom time strip (px)

/** Measures a container so the chart can fill whatever space the panel gives it. */
function useFillHeight(min: number) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [h, setH] = useState(min);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([entry]) => {
      // Track the real inner height: clamping to `min` here would let the
      // chart overflow its slot and collide with the legend below it.
      if (entry) setH(Math.max(120, Math.round(entry.contentRect.height)));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [min]);
  return [ref, h] as const;
}


/**
 * Keeps the price scale still while ticks stream in: the domain only re-fits
 * when the data actually leaves it (or shrinks far inside it, e.g. on a
 * timeframe change), so the line stops jittering between renders.
 */
function useStickyPriceDomain(ticks: Tick[]): [number, number] {
  const ref = useRef<[number, number] | null>(null);
  if (ticks.length === 0) return [0, 1];
  let lo = Infinity;
  let hi = -Infinity;
  for (const t of ticks) {
    if (t.price < lo) lo = t.price;
    if (t.price > hi) hi = t.price;
  }
  const span = hi - lo || Math.max(hi * 0.002, 1e-6);
  const pad = span * 0.18;
  const fresh: [number, number] = [lo - pad, hi + pad];
  const cur = ref.current;
  const fits = !!cur && lo >= cur[0] && hi <= cur[1] && span > (cur[1] - cur[0]) * 0.4;
  const next = fits ? cur! : fresh;
  ref.current = next;
  return next;
}

/** Pads a single observation so markers / focus lines from the same run still land on-canvas. */
const SINGLE_TICK_PAD_MS = 5 * 60_000;

function usePaths(ticks: Tick[], height: number, domainP: [number, number]) {
  return useMemo(() => {
    if (ticks.length < 1) return null;
    const xs = ticks.map((d) => d.t);
    const rawMin = Math.min(...xs);
    const rawMax = Math.max(...xs);
    const minT = ticks.length === 1 ? rawMin - SINGLE_TICK_PAD_MS : rawMin;
    const maxT = ticks.length === 1 ? rawMax + SINGLE_TICK_PAD_MS : rawMax;
    const minP = domainP[0];
    const maxP = domainP[1];
    const x = (t: number) => ((t - minT) / Math.max(1, maxT - minT)) * W;
    const y = (p: number) => H - ((p - minP) / Math.max(1e-9, maxP - minP)) * (H - 26) - 13;

    // market line, broken where data was a fallback (honest gaps)
    const segments: string[] = [];
    const areas: string[] = [];
    let current = "";
    let startX = 0;
    let lastX = 0;
    const flush = () => {
      if (!current) return;
      segments.push(current);
      areas.push(`${current}L${lastX.toFixed(1)} ${H}L${startX.toFixed(1)} ${H}Z`);
      current = "";
    };
    ticks.forEach((d, i) => {
      if (d.provenance === "fallback") {
        flush();
        return;
      }
      const px = x(d.t);
      if (!current) startX = px;
      lastX = px;
      current += `${current ? "L" : "M"}${px.toFixed(1)} ${y(d.price).toFixed(1)}`;
      if (i === ticks.length - 1) flush();
    });
    flush();

    const gaps = ticks.filter((d) => d.provenance === "fallback").map((d) => x(d.t));

    return { x, y, segments, areas, gaps, minT, maxT, minP, maxP, single: ticks.length === 1 };
  }, [ticks, height, domainP]);
}

function CompositionSteps({
  x,
  weights,
}: {
  markers: Marker[];
  x: (t: number) => number;
  weights?: Array<{ t: number; weight: number }>;
}) {
  // Prefer real HBAR allocation samples from completed runs; never invent a declining demo.
  const samples = weights && weights.length > 0 ? [...weights].sort((a, b) => a.t - b.t) : null;
  if (!samples || samples.length === 0) {
    return null;
  }
  const lo = Math.min(...samples.map((s) => s.weight));
  const hi = Math.max(...samples.map((s) => s.weight));
  const pad = Math.max(2, (hi - lo) * 0.2);
  const minW = lo - pad;
  const maxW = hi + pad;
  const yy = (w: number) => H - ((w - minW) / Math.max(1e-9, maxW - minW)) * (H - 30) - 15;
  const pts = samples.map((s) => ({ px: x(s.t), w: s.weight }));
  if (pts.length === 1) {
    pts.unshift({ px: 0, w: pts[0]!.w });
    pts.push({ px: W, w: pts[0]!.w });
  }
  const d = pts.map((p, i) => `${i ? "L" : "M"}${p.px.toFixed(1)} ${yy(p.w).toFixed(1)}`).join("");
  return <path d={d} fill="none" stroke="var(--ink)" strokeWidth="1.6" strokeLinejoin="miter" />;
}

function Frame({
  ticks,
  markers,
  annotations = [],
  onMarker,
  showComposition = true,
  showMarket = true,
  height = H,
  selected = null,
  focusT = null,
  onPick,
  onZoom,
  label,
  unit = "",
  digits = 5,
  weights,
}: {
  ticks: Tick[];
  markers: Marker[];
  annotations?: Annotation[];
  onMarker?: ((id: string) => void) | undefined;
  showComposition?: boolean;
  showMarket?: boolean;
  height?: number;
  selected?: Tick | null;
  focusT?: number | null;
  onPick?: (tick: Tick) => void;
  onZoom?: (t0: number, t1: number) => void;
  label?: string;
  unit?: string;
  digits?: number;
  weights?: Array<{ t: number; weight: number }>;
}) {
  const domainP = useStickyPriceDomain(ticks);
  const p = usePaths(ticks.length === 1 ? [ticks[0]!, { ...ticks[0]!, t: ticks[0]!.t + 1 }] : ticks, height, domainP);
  const gid = useId();
  const [hover, setHover] = useState<Tick | null>(null);
  const [brush, setBrush] = useState<{ a: number; b: number } | null>(null);
  const down = useRef<number | null>(null);
  if (!p) return null;

  const toLocalX = (e: React.PointerEvent<SVGSVGElement> | React.MouseEvent<SVGSVGElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    return ((e.clientX - box.left) / box.width) * W;
  };
  const nearest = (fx: number) => {
    let best = ticks[0]!;
    let bestD = Infinity;
    ticks.forEach((t) => {
      const d = Math.abs(p.x(t.t) - fx);
      if (d < bestD) {
        bestD = d;
        best = t;
      }
    });
    return best;
  };
  const tAt = (fx: number) => p.minT + (Math.min(W, Math.max(0, fx)) / W) * (p.maxT - p.minT);

  const plotH = Math.max(40, height - AXIS_H);
  const last = ticks[ticks.length - 1]!;
  const gridRows = [0.06, 0.32, 0.58, 0.84];
  const timeTicks = [0, 0.25, 0.5, 0.75, 1].map((f) => p.minT + f * (p.maxT - p.minT));
  const active = hover ?? selected;
  const fmt = (v: number) => (showMarket ? v.toFixed(digits) : `${v.toFixed(1)}%`);

  return (
    <div className="relative select-none" style={{ height }}>
      {label && (
        <span className="absolute top-0 left-0 z-10 text-[10.5px] tracking-[0.09em] text-ink-3 uppercase">
          {label}
        </span>
      )}

      {/* price gutter */}
      <div
        className="pointer-events-none absolute top-0 right-0"
        style={{ width: AXIS_W, height: plotH }}
      >
        {gridRows.map((f) => {
          const v = showMarket
            ? p.maxP - f * (p.maxP - p.minP)
            : 80 - f * 35;
          return (
            <span
              key={f}
              className="absolute left-2 font-mono text-[10.5px] text-ink-3 tabular-nums"
              style={{ top: `${f * 100}%`, transform: "translateY(-50%)" }}
            >
              {fmt(v)}
            </span>
          );
        })}
      </div>

      {/* time strip */}
      <div
        className="pointer-events-none absolute bottom-0 left-0 flex justify-between"
        style={{ right: AXIS_W, height: AXIS_H }}
      >
        {timeTicks.map((t, i) => (
          <span
            key={t}
            className="font-mono text-[10.5px] text-ink-3 tabular-nums"
            style={{ transform: i === 0 ? "none" : i === 4 ? "translateX(0)" : "none" }}
          >
            {clock(t).slice(0, 5)}
          </span>
        ))}
      </div>

      <div className="absolute top-0 left-0" style={{ right: AXIS_W, height: plotH }}>
        <svg
          viewBox={`0 0 ${W} ${H}`}
          width="100%"
          height={plotH}
          preserveAspectRatio="none"
          className={onPick ? "cursor-crosshair touch-none" : undefined}
          onPointerDown={(e) => {
            if (!onPick && !onZoom) return;
            down.current = toLocalX(e);
            setBrush(null);
          }}
          onPointerMove={(e) => {
            const fx = toLocalX(e);
            setHover(nearest(fx));
            if (down.current != null) setBrush({ a: down.current, b: fx });
          }}
          onPointerLeave={() => {
            setHover(null);
            down.current = null;
            setBrush(null);
          }}
          onPointerUp={(e) => {
            const fx = toLocalX(e);
            const start = down.current;
            down.current = null;
            setBrush(null);
            if (start != null && Math.abs(fx - start) > 10) {
              onZoom?.(tAt(Math.min(start, fx)), tAt(Math.max(start, fx)));
              return;
            }
            onPick?.(nearest(fx));
          }}
        >
          <defs>
            <linearGradient id={`${gid}-fill`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--signal)" stopOpacity="0.22" />
              <stop offset="100%" stopColor="var(--signal)" stopOpacity="0.01" />
            </linearGradient>
          </defs>

          {gridRows.map((f) => (
            <line
              key={f}
              x1={0}
              x2={W}
              y1={H * f}
              y2={H * f}
              stroke="var(--line)"
              strokeWidth="1"
              vectorEffect="non-scaling-stroke"
            />
          ))}
          {p.gaps.map((gx, i) => (
            <rect
              key={i}
              x={gx - 3}
              y={0}
              width={6}
              height={H}
              fill="var(--orange-soft)"
              opacity={0.7}
            />
          ))}
          {showMarket && (
            <>
              {p.areas.map((d, i) => (
                <path key={`a${i}`} d={d} fill={`url(#${gid}-fill)`} stroke="none" />
              ))}
              {p.segments.map((d, i) => (
                <path
                  key={i}
                  d={d}
                  fill="none"
                  stroke="var(--signal)"
                  strokeWidth="1.6"
                  vectorEffect="non-scaling-stroke"
                />
              ))}
              {p.single && ticks[0] && (
                <circle
                  cx={p.x(ticks[0].t)}
                  cy={p.y(ticks[0].price)}
                  r={5}
                  fill="var(--signal)"
                  stroke="var(--card)"
                  strokeWidth="2"
                  vectorEffect="non-scaling-stroke"
                />
              )}
            </>
          )}
          {showComposition && <CompositionSteps markers={markers} x={p.x} weights={weights} />}

          {focusT != null && focusT >= p.minT && focusT <= p.maxT && (
            <g pointerEvents="none">
              <rect x={p.x(focusT) - 1.5} y={0} width={3} height={H} fill="var(--signal-soft)" />
              <line
                x1={p.x(focusT)}
                x2={p.x(focusT)}
                y1={0}
                y2={H}
                stroke="var(--signal)"
                strokeWidth="1"
                vectorEffect="non-scaling-stroke"
              />
            </g>
          )}

          {active && (
            <g pointerEvents="none">
              <line
                x1={p.x(active.t)}
                x2={p.x(active.t)}
                y1={0}
                y2={H}
                stroke="var(--signal)"
                strokeDasharray="3 3"
                strokeWidth="1"
                vectorEffect="non-scaling-stroke"
              />
            </g>
          )}

          {brush && (
            <rect
              pointerEvents="none"
              x={Math.min(brush.a, brush.b)}
              y={0}
              width={Math.abs(brush.b - brush.a)}
              height={H}
              fill="var(--signal)"
              opacity={0.12}
            />
          )}

          {annotations
            .filter((a) => a.t >= p.minT && a.t <= p.maxT)
            .map((a) => (
              <g
                key={a.eventId}
                className="cursor-pointer"
                onPointerUp={(e) => {
                  e.stopPropagation();
                  down.current = null;
                  onMarker?.(a.eventId);
                }}
              >
                <title>{a.label}</title>
                <rect x={p.x(a.t) - 5} y={0} width={10} height={14} fill="transparent" />
                <line
                  x1={p.x(a.t)}
                  x2={p.x(a.t)}
                  y1={0}
                  y2={10}
                  stroke="var(--ink-3)"
                  strokeWidth="1"
                  vectorEffect="non-scaling-stroke"
                />
              </g>
            ))}

          {markers.map((m) => (
            <g
              key={m.eventId}
              className="cursor-pointer"
              onPointerUp={(e) => {
                e.stopPropagation();
                down.current = null;
                onMarker?.(m.eventId);
              }}
            >
              <rect x={p.x(m.t) - 7} y={0} width={14} height={H} fill="transparent" />
              <line
                x1={p.x(m.t)}
                x2={p.x(m.t)}
                y1={6}
                y2={H - 6}
                stroke="var(--green)"
                strokeWidth="1"
                vectorEffect="non-scaling-stroke"
                strokeDasharray="2 3"
              />
              <rect
                x={p.x(m.t) - 4}
                y={2}
                width={8}
                height={8}
                fill="var(--green)"
                transform={`rotate(45 ${p.x(m.t)} 6)`}
              />
            </g>
          ))}
        </svg>

        {/* dot on the line + tooltip card */}
        {active && showMarket && (
          <span
            className="pointer-events-none absolute z-10 block size-2.5 rounded-full bg-signal ring-2 ring-card"
            style={{
              left: `${(p.x(active.t) / W) * 100}%`,
              top: `${(p.y(active.price) / H) * 100}%`,
              transform: "translate(-50%,-50%)",
            }}
          />
        )}
        {active && (
          <div
            className="pointer-events-none absolute z-20 min-w-[124px] rounded-lg border border-line bg-card px-2.5 py-2 shadow-lg"
            style={{
              left: `${(p.x(active.t) / W) * 100}%`,
              top: 6,
              transform: `translateX(${p.x(active.t) > W * 0.6 ? "-104%" : "4%"})`,
            }}
          >
            <p className="font-mono text-[10px] text-ink-3 tabular-nums">{clock(active.t)}</p>
            <p className="mt-0.5 font-mono text-[12px] font-medium text-ink tabular-nums">
              {active.price.toFixed(digits)}
              {unit}
            </p>
            <p
              className={`mt-0.5 text-[10px] ${
                active.provenance === "fallback"
                  ? "text-orange"
                  : active.provenance === "live"
                    ? "text-signal"
                    : "text-ink-3"
              }`}
            >
              {active.provenance === "fallback"
                ? "no paid data"
                : active.provenance === "live"
                  ? "live paid read"
                  : "cached paid read"}
            </p>
          </div>
        )}

        {/* last value badge */}
        {showMarket && (
          <span
            className="pointer-events-none absolute z-10 rounded-md bg-signal px-1.5 py-0.5 font-mono text-[10.5px] text-card tabular-nums"
            style={{
              left: "100%",
              top: `${(p.y(last.price) / H) * 100}%`,
              transform: "translate(2px,-50%)",
            }}
          >
            {last.price.toFixed(digits)}
          </span>
        )}
      </div>
    </div>
  );
}


function Legend() {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 text-[11px] text-ink-3">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
        <span className="flex items-center gap-2">
          <span className="inline-block h-px w-5 bg-signal" /> paid feed
        </span>
        <span className="flex items-center gap-2">
          <span className="inline-block size-2.5 rotate-45 bg-green" /> settled trade
        </span>
        <span className="flex items-center gap-2">
          <span className="inline-block size-2.5 rounded-[1px] bg-orange-soft ring-1 ring-orange/40" />{" "}
          no paid data
        </span>
      </div>
      <span className="hidden whitespace-nowrap text-ink-3/80 sm:inline">
        drag to zoom · click a marker
      </span>
    </div>
  );
}


/** CoinGecko-style header: the number leads, the controls sit opposite it. */
function GraphHeader({
  ticks,
  selected,
  children,
}: {
  ticks: Tick[];
  selected: Tick | null;
  children?: React.ReactNode;
}) {
  const last = ticks[ticks.length - 1];
  const shown = selected ?? last;
  const first = ticks[0];
  if (!shown || !first) return null;
  const single = ticks.length === 1;
  const delta = single ? 0 : ((shown.price - first.price) / first.price) * 100;
  const up = delta >= 0;
  return (
    <div className="px-5 pt-4">
      <div className="min-w-0">
        <p className="text-[10.5px] tracking-[0.09em] text-ink-3 uppercase">
          HBAR / USDC · paid CoinGecko feed
        </p>
        <div className="mt-1.5 flex items-baseline gap-2.5">
          <span className="font-mono text-[26px] leading-none font-medium text-ink tabular-nums">
            {shown.price.toFixed(5)}
          </span>
          {single ? (
            <span className="font-mono text-[12px] text-ink-3 tabular-nums">first observation</span>
          ) : (
            <span
              className={`inline-block min-w-[62px] font-mono text-[12px] tabular-nums ${up ? "text-green" : "text-orange"}`}
            >
              {up ? "+" : ""}
              {delta.toFixed(2)}%
            </span>
          )}
        </div>
        <p className="mt-1 font-mono text-[11px] text-ink-3 tabular-nums">
          {single
            ? `${clock(shown.t)} · verified tick · run again to draw the feed`
            : selected
              ? `${clock(selected.t)} · selected`
              : `${clock(shown.t)} · latest`}
        </p>
      </div>
      {children && <div className="mt-3">{children}</div>}
    </div>
  );
}



export function LiveGraph({
  ticks,
  markers,
  annotations = [],
  onMarker,
  focusT = null,
  tall = false,
  weights = [],
}: {
  ticks: Tick[];
  markers: Marker[];
  annotations?: Annotation[];
  onMarker?: ((id: string) => void) | undefined;
  focusT?: number | null;
  tall?: boolean;
  weights?: Array<{ t: number; weight: number }>;
}) {
  const variant = useVariant("graph");
  const [selected, setSelected] = useState<Tick | null>(null);
  const [domain, setDomain] = useState<[number, number] | null>(null);
  const [range, setRange] = useState<"all" | number>("all");
  const pick = (t: Tick) => setSelected(t);
  const [fillRef, fillH] = useFillHeight(tall ? 380 : 300);
  const [showWeight, setShowWeight] = useState(false);

  const view = useMemo(() => {
    let out = ticks;
    if (typeof range === "number") {
      const cut = (ticks[ticks.length - 1]?.t ?? Date.now()) - range;
      out = ticks.filter((t) => t.t >= cut);
    }
    if (domain) out = out.filter((t) => t.t >= domain[0] && t.t <= domain[1]);
    return out.length > 2 ? out : ticks;
  }, [ticks, domain, range]);

  const viewMin = view[0]?.t;
  const viewMax = view[view.length - 1]?.t;
  const pad = view.length === 1 ? SINGLE_TICK_PAD_MS : 0;
  const inView = (t: number) =>
    viewMin !== undefined && viewMax !== undefined && t >= viewMin - pad && t <= viewMax + pad;
  const vMarkers = markers.filter((m) => inView(m.t));
  const vAnnotations = annotations.filter((a) => inView(a.t));

  const zoom = (t0: number, t1: number) => setDomain([t0, t1]);
  const zoomed = domain !== null || range !== "all";

  const controls = (
    // Fixed single row: Reset always occupies its slot (just invisible when
    // there is nothing to reset) so clicking a range never reflows the header.
    <div className="flex flex-nowrap items-center gap-1 overflow-x-auto">
      {(
        [
          ["5m", 5 * 60_000],
          ["15m", 15 * 60_000],
          ["All", "all"],
        ] as const
      ).map(([label, v]) => (
        <button
          key={label}
          type="button"
          onClick={() => {
            setDomain(null);
            setRange(v as "all" | number);
          }}
          className={`w-[46px] shrink-0 rounded-control border py-1 text-center text-[11px] transition-colors ${
            range === v && !domain
              ? "border-signal bg-signal-soft text-signal"
              : "border-line text-ink-3 hover:bg-hover"
          }`}
        >
          {label}
        </button>
      ))}
      <button
        type="button"
        onClick={() => setShowWeight((v) => !v)}
        className={`ml-1 w-[58px] shrink-0 rounded-control border py-1 text-center text-[11px] transition-colors ${
          showWeight ? "border-ink bg-inset text-ink" : "border-line text-ink-3 hover:bg-hover"
        }`}
      >
        Weight
      </button>
      <button
        type="button"
        onClick={() => {
          setDomain(null);
          setRange("all");
          setSelected(null);
        }}
        aria-hidden={!zoomed}
        tabIndex={zoomed ? 0 : -1}
        className={`ml-1 w-[52px] shrink-0 rounded-control border border-line py-1 text-center text-[11px] text-ink-2 transition-opacity hover:bg-hover ${
          zoomed ? "opacity-100" : "pointer-events-none opacity-0"
        }`}
      >
        Reset
      </button>
    </div>
  );

  if (ticks.length === 0) {
    return (
      <div className="flex h-full min-h-[440px] flex-col rounded-xl border border-line bg-card">
        <div className="px-5 pt-4">
          <p className="text-[10.5px] tracking-[0.09em] text-ink-3 uppercase">HBAR / USDC · paid CoinGecko feed</p>
          <p className="mt-3 text-[13px] font-medium text-ink">Waiting for a paid CoinGecko read</p>
          <p className="mt-1 max-w-md text-[12px] leading-relaxed text-ink-3">
            After the agent buys HBAR intelligence through x402, this chart draws the CoinGecko OHLC history bundled with that paid spot price. It will not invent ticks.
          </p>
        </div>
        <div className="m-5 flex min-h-0 flex-1 items-center justify-center rounded-lg border border-dashed border-line-strong bg-inset/30 font-mono text-[11px] text-ink-3">
          No verified ticks yet
        </div>
        <div className="shrink-0 border-t border-line px-5 py-3"><Legend /></div>
      </div>
    );
  }



  if (variant === "Sparkline strip") {
    // Compact take on the same chart: header + one line, no stacked panels.
    return (
      <div className="flex h-full min-h-[260px] flex-col rounded-xl border border-line bg-card">
        <GraphHeader ticks={view} selected={selected}>
          {controls}
        </GraphHeader>
        <div ref={fillRef} className="min-h-0 flex-1 overflow-hidden px-2.5 pt-4 pb-2">
          <Frame
            ticks={view}
            markers={vMarkers}
            annotations={vAnnotations}
            onMarker={onMarker}
            selected={selected}
            focusT={focusT}
            onPick={pick}
            onZoom={zoom}
            showComposition={false}
            height={Math.max(140, fillH)}
          />
        </div>
        <div className="shrink-0 border-t border-line px-5 py-3">
          <Legend />
        </div>
      </div>
    );
  }

  if (variant === "Split stacked") {
    // Same refined market chart, with the weight track pinned above it.
    return (
      <div className="flex h-full min-h-[440px] flex-col rounded-xl border border-line bg-card">
        <GraphHeader ticks={view} selected={selected}>
          {controls}
        </GraphHeader>

        <div ref={fillRef} className="flex min-h-0 flex-1 flex-col overflow-hidden px-2.5 pt-4 pb-2">
          <div className="min-h-0 flex-1">
            <Frame
              ticks={view}
              markers={vMarkers}
              annotations={vAnnotations}
              onMarker={onMarker}
              selected={selected}
              focusT={focusT}
              onPick={pick}
              onZoom={zoom}
              showComposition={false}
              height={Math.max(200, Math.round(fillH * 0.68))}
            />
          </div>
          <div className="mt-1 border-t border-line pt-2">
            <p className="px-3.5 text-[10.5px] tracking-[0.09em] text-ink-3 uppercase">
              HBAR weight
            </p>
            <Frame
              ticks={view}
              markers={[]}
              showMarket={false}
              height={Math.max(84, Math.round(fillH * 0.26))}
              selected={selected}
              focusT={focusT}
              onPick={pick}
              onZoom={zoom}
            />
          </div>
        </div>

        <div className="shrink-0 border-t border-line px-5 py-3">
          <Legend />
        </div>
      </div>
    );
  }


  // Overlay
  return (
    <div className="flex h-full min-h-[440px] flex-col rounded-xl border border-line bg-card">
      <GraphHeader ticks={view} selected={selected}>
        {controls}
      </GraphHeader>

      <div ref={fillRef} className="min-h-0 flex-1 overflow-hidden px-2.5 pt-5 pb-2">
        <Frame
          ticks={view}
          markers={vMarkers}
          annotations={vAnnotations}
          onMarker={onMarker}
          selected={selected}
          focusT={focusT}
          onPick={pick}
          onZoom={zoom}
          showComposition={showWeight}
          height={fillH}
          weights={weights}
        />
      </div>

      <div className="shrink-0 border-t border-line px-5 py-3">
        <Legend />
      </div>
    </div>

  );
}
