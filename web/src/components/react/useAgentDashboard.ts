import { useCallback, useEffect, useRef, useState } from "react";
import { type DashboardSnapshot, type RunEvent, loadDashboard } from "../../lib/agent-api";

type State = { data: DashboardSnapshot | null; loading: boolean; error: string | null };

const REFRESH_KINDS =
  /^(payment\.settled|trade\.(verified|submitted|proposed)|run\.(completed|failed)|analysis\.completed|portfolio\.(read|updated)|session\.(cleared|removed|activated))$/;

export function useAgentDashboard() {
  const [state, setState] = useState<State>({ data: null, loading: true, error: null });
  const sequence = useRef(0);
  const refreshTimer = useRef<number | null>(null);
  const refresh = useCallback(async () => {
    setState((current) => ({ ...current, loading: current.data === null, error: null }));
    try {
      const data = await loadDashboard();
      sequence.current = Math.max(0, ...(data.events ?? []).map((event) => Number(event.sequence ?? 0)));
      setState({ data, loading: false, error: null });
    }
    catch (error) { setState((current) => ({ ...current, loading: false, error: error instanceof Error ? error.message : "Could not load agent state." })); }
  }, []);

  const scheduleRefresh = useCallback(() => {
    if (refreshTimer.current !== null) window.clearTimeout(refreshTimer.current);
    refreshTimer.current = window.setTimeout(() => { void refresh(); }, 400);
  }, [refresh]);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    const profileId = state.data?.profile?.id;
    if (!profileId) return;
    const BASE_URL = import.meta.env?.PUBLIC_API_URL || "";
    const stream = new EventSource(`${BASE_URL}/api/v1/profiles/${encodeURIComponent(profileId)}/stream`, { withCredentials: true });
    stream.onmessage = (message) => {
      try {
        const event = JSON.parse(message.data) as RunEvent;
        const next = Number(event.sequence ?? message.lastEventId ?? sequence.current + 1);
        if (next <= sequence.current) return;
        sequence.current = next;
        setState((current) => {
          if (!current.data || (current.data.events ?? []).some((existing) => existing.id === event.id)) return current;
          return { ...current, data: { ...current.data, events: [...(current.data.events ?? []), event] } };
        });
        if (REFRESH_KINDS.test(event.kind)) scheduleRefresh();
      } catch { /* A malformed stream event is ignored; server state remains authoritative. */ }
    };
    stream.addEventListener("snapshot", () => { void refresh(); });
    stream.addEventListener("agent.completed", () => { scheduleRefresh(); });
    stream.onerror = () => setState((current) => ({ ...current, error: current.error ?? "Live updates disconnected. Reconnecting…" }));
    return () => {
      stream.close();
      if (refreshTimer.current !== null) window.clearTimeout(refreshTimer.current);
    };
  }, [state.data?.profile?.id, refresh, scheduleRefresh]);
  return { ...state, refresh };
}
