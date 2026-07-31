import { store } from "../store/index.js";
import type { DurableEvent } from "../store/types.js";
import { eventForUi, isUserFacingEvent } from "./events.js";

type SSEClient = { id: string; send: (data: string) => void; profileId?: string };

/** Durable SSE fan-out.  Events are committed before they are offered to clients,
 * so reconnecting clients can always replay a missed lifecycle transition. */
class SSEBroadcaster {
  private clients = new Map<string, SSEClient>();

  addClient(id: string, send: (data: string) => void, profileId?: string): () => void {
    this.clients.set(id, { id, send, profileId });
    return () => this.clients.delete(id);
  }

  private format(event: DurableEvent): string {
    const ui = eventForUi(event);
    const data = JSON.stringify(
      { ...ui, type: event.type },
      (_key, value) => typeof value === "bigint" ? value.toString() : value,
    );
    return `id: ${event.id}\nevent: message\ndata: ${data}\n\n`;
  }

  broadcast(type: string, payload: unknown, options: Pick<DurableEvent, "profileId" | "runId" | "provenance"> = {}): DurableEvent {
    const event = store.appendEvent(type, payload, options);
    if (!isUserFacingEvent(event)) return event;
    const data = this.format(event);
    for (const client of this.clients.values()) {
      if (client.profileId && client.profileId !== event.profileId) continue;
      try { client.send(data); } catch { this.clients.delete(client.id); }
    }
    return event;
  }

  /** Writes user-facing records after `lastEventId` in strict durable sequence order. */
  replay(send: (data: string) => void, lastEventId?: string, profileId?: string): DurableEvent[] {
    const events = store.replayEvents(lastEventId, profileId).filter(isUserFacingEvent);
    for (const event of events) send(this.format(event));
    return events;
  }

  getClientCount(): number { return this.clients.size; }
}

export const sseBroadcaster = new SSEBroadcaster();
