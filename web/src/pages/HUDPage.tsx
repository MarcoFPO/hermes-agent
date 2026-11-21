import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, PlugZap, Radio, Search, Wrench, WifiOff } from "lucide-react";
import { usePageHeader } from "@/contexts/usePageHeader";
import { cn } from "@/lib/utils";

/**
 * HUDPage — JARVIS-style live visualization of agent activity.
 *
 * This page does NOT talk to the Hermes chat PTY WebSocket (`/api/pty`,
 * used by ChatPage). That socket carries raw rendered terminal bytes with
 * no machine-readable event schema. Instead it connects directly to a
 * separate Go relay service that exposes a simplified structured event
 * stream on `ws://<host>:8977/hud`, emitting compact JSON events:
 * speaking_start / speaking_delta / speaking_end / tool_call /
 * search_results / tool_result / turn_end.
 */

// ---------------------------------------------------------------------------
// Relay event types
// ---------------------------------------------------------------------------

interface SpeakingStartEvent {
  type: "speaking_start";
}

interface SpeakingDeltaEvent {
  type: "speaking_delta";
  text?: string;
}

interface SpeakingEndEvent {
  type: "speaking_end";
}

interface ToolCallEvent {
  type: "tool_call";
  id?: string;
  name: string;
  args?: unknown;
}

interface SearchResultItem {
  title: string;
  url: string;
  snippet?: string;
}

interface SearchResultsEvent {
  type: "search_results";
  query?: string;
  results: SearchResultItem[];
}

interface ToolResultEvent {
  type: "tool_result";
  id?: string;
  name?: string;
  ok?: boolean;
  summary?: string;
}

interface TurnEndEvent {
  type: "turn_end";
}

type HudEvent =
  | SpeakingStartEvent
  | SpeakingDeltaEvent
  | SpeakingEndEvent
  | ToolCallEvent
  | SearchResultsEvent
  | ToolResultEvent
  | TurnEndEvent;

function isHudEvent(value: unknown): value is HudEvent {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { type?: unknown }).type === "string"
  );
}

// ---------------------------------------------------------------------------
// Activity feed model
// ---------------------------------------------------------------------------

type ActivityKind = "tool_call" | "tool_result";

interface ActivityEntry {
  key: string;
  kind: ActivityKind;
  name: string;
  detail: string;
  ok?: boolean;
  at: number;
}

const MAX_ACTIVITY_ENTRIES = 40;
const RELAY_PORT = 8977;
const RELAY_PATH = "/hud";
const BASE_RECONNECT_DELAY_MS = 1000;
const MAX_RECONNECT_DELAY_MS = 15000;
const AMPLITUDE_DECAY_PER_TICK = 0.08;
const AMPLITUDE_BOOST_PER_DELTA = 0.22;
const IDLE_AMPLITUDE = 0.12;

function summarizeArgs(args: unknown): string {
  if (args == null) return "";
  if (typeof args === "string") return args.length > 80 ? `${args.slice(0, 80)}…` : args;
  try {
    const s = JSON.stringify(args);
    return s.length > 80 ? `${s.slice(0, 80)}…` : s;
  } catch {
    return String(args);
  }
}

function relayWsUrl(): string {
  // Deliberately independent of api.buildWsUrl: the HUD relay is a
  // separate service on its own port, not proxied under the app's API
  // base path. We only reuse the *host determination* convention used
  // elsewhere in the app (current page's hostname + protocol-derived
  // ws/wss scheme), not the /api-relative path building.
  const scheme = window.location.protocol === "https:" ? "wss" : "ws";
  const host = window.location.hostname;
  return `${scheme}://${host}:${RELAY_PORT}${RELAY_PATH}`;
}

export default function HUDPage() {
  const { setTitle } = usePageHeader();

  useEffect(() => {
    setTitle("HUD");
    return () => setTitle(null);
  }, [setTitle]);

  const [connected, setConnected] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [amplitude, setAmplitude] = useState(IDLE_AMPLITUDE);
  const [activity, setActivity] = useState<ActivityEntry[]>([]);
  const [searchPanel, setSearchPanel] = useState<{
    query?: string;
    results: SearchResultItem[];
  } | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectAttemptRef = useRef(0);
  const unmountedRef = useRef(false);
  const searchPanelTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const targetAmplitudeRef = useRef(IDLE_AMPLITUDE);

  // Idle-decay / render loop for the voice core amplitude. Deltas bump the
  // target amplitude (via bumpAmplitude); this loop eases the displayed
  // value toward the target and lets it settle back to idle once no more
  // deltas arrive.
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      setAmplitude((prev) => {
        const target = targetAmplitudeRef.current;
        const next = prev + (target - prev) * 0.15;
        // Slowly relax the target itself back toward idle so bursts of
        // deltas decay rather than staying pinned at their peak forever.
        targetAmplitudeRef.current = Math.max(
          IDLE_AMPLITUDE,
          target - AMPLITUDE_DECAY_PER_TICK * 0.05,
        );
        return next;
      });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  const bumpAmplitude = useCallback((text?: string) => {
    const len = text?.length ?? 8;
    const boost = Math.min(1, AMPLITUDE_BOOST_PER_DELTA + len * 0.01);
    targetAmplitudeRef.current = Math.min(1, targetAmplitudeRef.current + boost);
  }, []);

  const pushActivity = useCallback((entry: ActivityEntry) => {
    setActivity((prev) => [entry, ...prev].slice(0, MAX_ACTIVITY_ENTRIES));
  }, []);

  const showSearchPanel = useCallback((query: string | undefined, results: SearchResultItem[]) => {
    if (searchPanelTimerRef.current) {
      clearTimeout(searchPanelTimerRef.current);
      searchPanelTimerRef.current = null;
    }
    setSearchPanel({ query, results });
    searchPanelTimerRef.current = setTimeout(() => {
      setSearchPanel(null);
      searchPanelTimerRef.current = null;
    }, 12000);
  }, []);

  const handleEvent = useCallback(
    (evt: HudEvent) => {
      switch (evt.type) {
        case "speaking_start":
          setSpeaking(true);
          targetAmplitudeRef.current = Math.max(targetAmplitudeRef.current, 0.35);
          break;
        case "speaking_delta":
          setSpeaking(true);
          bumpAmplitude(evt.text);
          break;
        case "speaking_end":
          setSpeaking(false);
          targetAmplitudeRef.current = IDLE_AMPLITUDE;
          break;
        case "tool_call":
          pushActivity({
            key: `call-${evt.id ?? evt.name}-${Date.now()}`,
            kind: "tool_call",
            name: evt.name,
            detail: summarizeArgs(evt.args),
            at: Date.now(),
          });
          break;
        case "tool_result":
          pushActivity({
            key: `result-${evt.id ?? evt.name}-${Date.now()}`,
            kind: "tool_result",
            name: evt.name ?? "tool",
            detail: evt.summary ?? "",
            ok: evt.ok,
            at: Date.now(),
          });
          break;
        case "search_results":
          showSearchPanel(evt.query, evt.results ?? []);
          break;
        case "turn_end":
          setSpeaking(false);
          targetAmplitudeRef.current = IDLE_AMPLITUDE;
          break;
        default:
          break;
      }
    },
    [bumpAmplitude, pushActivity, showSearchPanel],
  );

  useEffect(() => {
    unmountedRef.current = false;

    const connect = () => {
      if (unmountedRef.current) return;
      let ws: WebSocket;
      try {
        ws = new WebSocket(relayWsUrl());
      } catch {
        scheduleReconnect();
        return;
      }
      wsRef.current = ws;
      setReconnecting(reconnectAttemptRef.current > 0);

      ws.onopen = () => {
        if (unmountedRef.current) return;
        reconnectAttemptRef.current = 0;
        setConnected(true);
        setReconnecting(false);
      };

      ws.onmessage = (ev) => {
        if (typeof ev.data !== "string") return;
        let parsed: unknown;
        try {
          parsed = JSON.parse(ev.data);
        } catch {
          return;
        }
        if (isHudEvent(parsed)) handleEvent(parsed);
      };

      ws.onclose = () => {
        if (wsRef.current === ws) wsRef.current = null;
        if (unmountedRef.current) return;
        setConnected(false);
        setSpeaking(false);
        targetAmplitudeRef.current = IDLE_AMPLITUDE;
        scheduleReconnect();
      };

      ws.onerror = () => {
        try {
          ws.close();
        } catch {
          /* already closing */
        }
      };
    };

    const scheduleReconnect = () => {
      if (unmountedRef.current) return;
      if (reconnectTimerRef.current) return;
      setReconnecting(true);
      const attempt = reconnectAttemptRef.current;
      const delay = Math.min(
        MAX_RECONNECT_DELAY_MS,
        BASE_RECONNECT_DELAY_MS * 2 ** attempt,
      );
      reconnectAttemptRef.current = attempt + 1;
      reconnectTimerRef.current = setTimeout(() => {
        reconnectTimerRef.current = null;
        connect();
      }, delay);
    };

    connect();

    return () => {
      unmountedRef.current = true;
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      if (searchPanelTimerRef.current) {
        clearTimeout(searchPanelTimerRef.current);
        searchPanelTimerRef.current = null;
      }
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, [handleEvent]);

  // Equalizer bar heights derived from the current amplitude, staggered
  // via a fixed per-bar phase so the whole ring doesn't pulse in lockstep.
  const bars = useMemo(() => {
    const count = 24;
    return Array.from({ length: count }, (_, i) => {
      const phase = (i / count) * Math.PI * 2;
      const wobble = 0.5 + 0.5 * Math.sin(phase * 3 + amplitude * 6);
      const h = 6 + amplitude * 34 * wobble;
      return { angle: (360 / count) * i, height: h };
    });
  }, [amplitude]);

  return (
    <div className="hud-root relative flex h-full min-h-0 flex-col overflow-hidden bg-[var(--color-background,#05070a)] text-cyan-100">
      <HudGridBackground />

      {/* Status header */}
      <div className="relative z-10 flex items-center justify-between border-b border-cyan-500/20 bg-black/30 px-4 py-2 backdrop-blur-sm">
        <div className="flex items-center gap-2 text-xs uppercase tracking-[0.2em] text-cyan-300/80">
          <Radio className="h-4 w-4" aria-hidden />
          <span>Hermes HUD</span>
        </div>
        <ConnectionStatus connected={connected} reconnecting={reconnecting} />
      </div>

      <div className="relative z-10 grid min-h-0 flex-1 grid-cols-1 gap-4 overflow-hidden p-4 lg:grid-cols-[1fr_360px]">
        {/* Voice core */}
        <div className="relative flex min-h-0 flex-col items-center justify-center overflow-hidden rounded-lg border border-cyan-500/15 bg-black/20">
          <RadarSweep />
          <VoiceCore speaking={speaking} amplitude={amplitude} bars={bars} />
          {searchPanel && (
            <SearchResultsPanel
              query={searchPanel.query}
              results={searchPanel.results}
              onDismiss={() => setSearchPanel(null)}
            />
          )}
        </div>

        {/* Activity feed */}
        <div className="flex min-h-0 flex-col overflow-hidden rounded-lg border border-orange-500/15 bg-black/20">
          <div className="border-b border-orange-500/15 px-3 py-2 text-xs uppercase tracking-[0.2em] text-orange-300/80">
            Activity
          </div>
          <div className="flex-1 space-y-2 overflow-y-auto p-2">
            {activity.length === 0 && (
              <div className="px-2 py-6 text-center text-xs text-cyan-300/40">
                Waiting for tool activity…
              </div>
            )}
            {activity.map((entry) => (
              <ActivityCard key={entry.key} entry={entry} />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Subcomponents
// ---------------------------------------------------------------------------

function ConnectionStatus({
  connected,
  reconnecting,
}: {
  connected: boolean;
  reconnecting: boolean;
}) {
  if (connected) {
    return (
      <div className="flex items-center gap-1.5 text-xs text-emerald-400">
        <PlugZap className="h-3.5 w-3.5" aria-hidden />
        <span>Relay connected</span>
      </div>
    );
  }
  if (reconnecting) {
    return (
      <div className="flex items-center gap-1.5 text-xs text-orange-400">
        <AlertTriangle className="h-3.5 w-3.5 animate-pulse" aria-hidden />
        <span>Reconnecting…</span>
      </div>
    );
  }
  return (
    <div className="flex items-center gap-1.5 text-xs text-red-400">
      <WifiOff className="h-3.5 w-3.5" aria-hidden />
      <span>Disconnected</span>
    </div>
  );
}

function HudGridBackground() {
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-0 z-0 opacity-40"
      style={{
        backgroundImage:
          "linear-gradient(rgba(34,211,238,0.08) 1px, transparent 1px), linear-gradient(90deg, rgba(34,211,238,0.08) 1px, transparent 1px)",
        backgroundSize: "32px 32px",
        maskImage:
          "radial-gradient(ellipse at center, black 0%, transparent 75%)",
      }}
    />
  );
}

function RadarSweep() {
  return (
    <svg
      aria-hidden
      className="pointer-events-none absolute inset-0 h-full w-full opacity-30"
      viewBox="0 0 100 100"
      preserveAspectRatio="xMidYMid slice"
    >
      <circle cx="50" cy="50" r="46" fill="none" stroke="rgba(34,211,238,0.25)" strokeWidth="0.3" />
      <circle cx="50" cy="50" r="32" fill="none" stroke="rgba(34,211,238,0.18)" strokeWidth="0.3" />
      <circle cx="50" cy="50" r="18" fill="none" stroke="rgba(34,211,238,0.12)" strokeWidth="0.3" />
      <g style={{ transformOrigin: "50px 50px", animation: "hud-radar-spin 6s linear infinite" }}>
        <path d="M50 50 L50 4 A46 46 0 0 1 88 27 Z" fill="url(#hud-radar-gradient)" />
      </g>
      <defs>
        <linearGradient id="hud-radar-gradient" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="rgba(34,211,238,0.35)" />
          <stop offset="100%" stopColor="rgba(34,211,238,0)" />
        </linearGradient>
      </defs>
    </svg>
  );
}

function VoiceCore({
  speaking,
  amplitude,
  bars,
}: {
  speaking: boolean;
  amplitude: number;
  bars: { angle: number; height: number }[];
}) {
  return (
    <div className="relative z-10 flex h-64 w-64 items-center justify-center">
      <div
        className={cn(
          "absolute inset-0 rounded-full border transition-colors duration-300",
          speaking ? "border-cyan-400/60" : "border-cyan-500/25",
        )}
        style={{
          boxShadow: speaking
            ? `0 0 ${20 + amplitude * 40}px rgba(34,211,238,${0.25 + amplitude * 0.35})`
            : "0 0 12px rgba(34,211,238,0.12)",
        }}
      />
      <div
        className="absolute inset-6 rounded-full border border-cyan-400/20"
        style={{ animation: "hud-core-pulse 2.6s ease-in-out infinite" }}
      />

      {/* Equalizer ring */}
      <div className="absolute inset-0">
        {bars.map((bar, i) => (
          <div
            key={i}
            className="absolute left-1/2 top-1/2 origin-bottom rounded-full bg-gradient-to-t from-cyan-500/80 to-orange-400/80"
            style={{
              width: 2,
              height: bar.height,
              transform: `rotate(${bar.angle}deg) translateY(-108px)`,
              transition: "height 90ms linear",
            }}
          />
        ))}
      </div>

      <div className="relative z-10 flex flex-col items-center gap-1 text-center">
        <div
          className={cn(
            "h-3 w-3 rounded-full",
            speaking ? "bg-cyan-300 animate-pulse" : "bg-cyan-600/50",
          )}
          style={{
            boxShadow: speaking
              ? "0 0 16px 4px rgba(34,211,238,0.7)"
              : "0 0 6px 1px rgba(34,211,238,0.25)",
          }}
        />
        <span className="text-[10px] uppercase tracking-[0.3em] text-cyan-300/70">
          {speaking ? "Speaking" : "Idle"}
        </span>
      </div>
    </div>
  );
}

function ActivityCard({ entry }: { entry: ActivityEntry }) {
  const isResult = entry.kind === "tool_result";
  return (
    <div
      className={cn(
        "rounded-md border px-3 py-2 text-xs",
        isResult
          ? entry.ok === false
            ? "border-red-500/30 bg-red-500/5"
            : "border-emerald-500/25 bg-emerald-500/5"
          : "border-orange-500/25 bg-orange-500/5",
      )}
      style={{ animation: "hud-slide-in 220ms ease-out" }}
    >
      <div className="flex items-center gap-1.5 font-medium text-orange-200">
        <Wrench className="h-3 w-3 shrink-0" aria-hidden />
        <span className="truncate">{entry.name}</span>
        {isResult && (
          <span
            className={cn(
              "ml-auto rounded px-1 text-[10px] uppercase tracking-wide",
              entry.ok === false ? "text-red-300" : "text-emerald-300",
            )}
          >
            {entry.ok === false ? "error" : "done"}
          </span>
        )}
      </div>
      {entry.detail && (
        <div className="mt-1 truncate text-cyan-200/60">{entry.detail}</div>
      )}
    </div>
  );
}

function SearchResultsPanel({
  query,
  results,
  onDismiss,
}: {
  query?: string;
  results: SearchResultItem[];
  onDismiss: () => void;
}) {
  return (
    <div
      className="absolute inset-x-4 bottom-4 z-20 max-h-[45%] overflow-y-auto rounded-lg border border-cyan-400/30 bg-black/70 p-3 backdrop-blur-md"
      style={{
        animation: "hud-panel-in 260ms ease-out",
        boxShadow: "0 0 30px rgba(34,211,238,0.15)",
      }}
    >
      <div className="mb-2 flex items-center justify-between text-[10px] uppercase tracking-[0.2em] text-cyan-300/70">
        <div className="flex items-center gap-1.5">
          <Search className="h-3 w-3" aria-hidden />
          <span>{query ? `Results — ${query}` : "Search Results"}</span>
        </div>
        <button
          type="button"
          onClick={onDismiss}
          className="text-cyan-300/50 hover:text-cyan-200"
        >
          ×
        </button>
      </div>
      <div className="space-y-1.5">
        {results.map((r, i) => (
          <a
            key={`${r.url}-${i}`}
            href={r.url}
            target="_blank"
            rel="noreferrer"
            className="block rounded border border-cyan-500/15 bg-cyan-500/5 px-2 py-1.5 text-xs hover:border-cyan-400/40"
            style={{
              animation: `hud-card-fade-in 300ms ease-out ${i * 60}ms both`,
            }}
          >
            <div className="truncate font-medium text-cyan-200">{r.title}</div>
            <div className="truncate text-[10px] text-cyan-400/50">{r.url}</div>
            {r.snippet && (
              <div className="mt-0.5 line-clamp-2 text-cyan-100/60">{r.snippet}</div>
            )}
          </a>
        ))}
      </div>
    </div>
  );
}

// Keyframes are injected once via a plain <style> tag scoped by the
// `hud-root` class prefix used above, matching the pattern of other
// pages that ship a small amount of page-local CSS alongside Tailwind
// utility classes rather than a separate stylesheet import.
const HUD_KEYFRAMES = `
@keyframes hud-radar-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
@keyframes hud-core-pulse {
  0%, 100% { transform: scale(1); opacity: 0.6; }
  50% { transform: scale(1.04); opacity: 1; }
}
@keyframes hud-slide-in {
  from { opacity: 0; transform: translateX(16px); }
  to { opacity: 1; transform: translateX(0); }
}
@keyframes hud-panel-in {
  from { opacity: 0; transform: translateY(12px); }
  to { opacity: 1; transform: translateY(0); }
}
@keyframes hud-card-fade-in {
  from { opacity: 0; transform: translateY(6px); }
  to { opacity: 1; transform: translateY(0); }
}
`;

if (typeof document !== "undefined" && !document.getElementById("hud-page-keyframes")) {
  const style = document.createElement("style");
  style.id = "hud-page-keyframes";
  style.textContent = HUD_KEYFRAMES;
  document.head.appendChild(style);
}
