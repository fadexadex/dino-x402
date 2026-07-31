import type { DurableEvent } from "../store/types.js";

/** Store/SSE types that should never become activity-stream cards. */
const INTERNAL_TYPE = /^(profile\.|account\.|mandate\.|schedule\.|spending\.|scheduler\.|store\.|log\.|run\.(created|updated)$)/;

/** Lifecycle kinds the workspace is allowed to show. */
const USER_FACING_KIND =
  /^(portfolio\.|payment\.|data\.|analysis\.|agent\.thinking|user\.message|trade\.|run\.(completed|failed|no_action|triggered)|system\.(halted|resumed))/;

export function eventForUi(event: DurableEvent) {
  const payload = event.payload as Record<string, unknown> | undefined;
  const nested = payload?.event && typeof payload.event === "object" ? payload.event as Record<string, unknown> : undefined;
  return {
    id: event.id,
    sequence: event.sequence,
    runId: event.runId ?? payload?.runId,
    kind: typeof nested?.kind === "string" ? nested.kind : event.type,
    occurredAt: typeof nested?.at === "string" ? nested.at : event.occurredAt,
    title: typeof nested?.title === "string"
      ? nested.title
      : typeof payload?.title === "string"
        ? payload.title
        : event.type.replace(/[._]/g, " "),
    detail: typeof nested?.detail === "string"
      ? nested.detail
      : typeof payload?.detail === "string"
        ? payload.detail
        : undefined,
    provenance: event.provenance ?? (nested?.metadata as Record<string, unknown> | undefined)?.provenance,
    payload: nested?.metadata ?? event.payload,
  };
}

export function isUserFacingEvent(event: DurableEvent): boolean {
  if (INTERNAL_TYPE.test(event.type)) return false;
  const ui = eventForUi(event);
  if (INTERNAL_TYPE.test(ui.kind)) return false;
  const payload = event.payload as Record<string, unknown> | undefined;
  const nested = payload?.event && typeof payload.event === "object" ? payload.event as Record<string, unknown> : undefined;
  const nestedMeta = nested?.metadata && typeof nested.metadata === "object" ? nested.metadata as Record<string, unknown> : undefined;
  // Agents can keep an audit event while staying quiet in the chat stream.
  if (payload?.presentInUi === false || nestedMeta?.presentInUi === false) return false;
  // Store proposal status transitions are persisted for audit, but they flood the
  // activity rail (especially repeated trade.rejected). Only show curated cards.
  if (/^trade\.(approved|rejected|expired)$/.test(ui.kind)) {
    return Boolean(payload?.presentInUi || nested?.title);
  }
  return USER_FACING_KIND.test(ui.kind);
}
