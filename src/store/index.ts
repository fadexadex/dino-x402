import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import type {
  StoreState, ScheduleConfig, AgentMultiRunRecord, PendingTrade, ConnectedAccount,
  DurableEvent, PortfolioProfile, PortfolioMandate, SchedulerLease,
} from "./types.js";

const DEFAULT_SCHEDULE: ScheduleConfig = {
  enabled: false, intervalMinutes: 5, autonomousTrading: false, dataBudgetHbar: 0.1,
  maxTradeHbar: 10, dailyBudgetCapHbar: 2, watchedSymbols: ["HBAR", "USDC", "USDT", "SAUCE", "KARATE"],
};

const defaults = (): StoreState => ({
  account: null, schedule: { ...DEFAULT_SCHEDULE }, runs: [], pendingTrades: [],
  spending: { todayDataHbar: 0, todayTradeHbar: 0, totalDataHbar: 0, totalTradeHbar: 0, lastResetDate: today() },
  logs: [], profiles: [], mandates: [], events: [], schedulerLeases: [], system: { halted: false },
});

function today(): string { return new Date().toISOString().slice(0, 10); }
// Hedera SDK values can contain bigint.  Persist them losslessly rather than allowing
// JSON.stringify to throw halfway through a financial state transition.
function stringify(value: unknown): string {
  return JSON.stringify(value, (_key, item) => typeof item === "bigint" ? { __storeBigInt: item.toString() } : item);
}
function parse<T>(value: string): T {
  return JSON.parse(value, (_key, item) => item && typeof item === "object" && typeof item.__storeBigInt === "string"
    ? BigInt(item.__storeBigInt) : item) as T;
}

export interface AppStoreOptions { databasePath?: string; now?: () => Date; }

/**
 * Small single-host repository backed by SQLite WAL.  A state projection remains
 * available for old callers, while event rows are the authoritative replay stream.
 */
export class AppStore {
  private state: StoreState;
  private readonly db: Database.Database;
  private readonly now: () => Date;
  private listeners = new Set<(state: StoreState) => void>();

  constructor(options: AppStoreOptions = {}) {
    this.now = options.now ?? (() => new Date());
    const databasePath = options.databasePath ?? path.join(process.env.DATA_DIR ?? path.join(process.cwd(), "data"), "agent.sqlite");
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    this.db = new Database(databasePath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = FULL");
    this.db.pragma("foreign_keys = ON");
    this.migrate();
    this.state = this.load();
    this.recoverInterruptedRuns();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, type TEXT NOT NULL,
        occurred_at TEXT NOT NULL, profile_id TEXT, run_id TEXT, provenance TEXT, payload TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS events_profile_sequence ON events(profile_id, sequence);
      CREATE TABLE IF NOT EXISTS profiles (id TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS mandates (id TEXT PRIMARY KEY, profile_id TEXT NOT NULL, version INTEGER NOT NULL, value TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS schedules (id TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, account_id TEXT NOT NULL, status TEXT NOT NULL, value TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS proposals (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, account_id TEXT NOT NULL, status TEXT NOT NULL, value TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS spending (id TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS system_state (id TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS scheduler_leases (key TEXT PRIMARY KEY, holder_id TEXT NOT NULL, acquired_at TEXT NOT NULL, expires_at TEXT NOT NULL);
    `);
  }

  private load(): StoreState {
    const row = this.db.prepare("SELECT value FROM state WHERE key = 'projection'").get() as { value: string } | undefined;
    if (!row) return defaults();
    const stored = parse<Partial<StoreState>>(row.value);
    return { ...defaults(), ...stored, schedule: { ...DEFAULT_SCHEDULE, ...(stored.schedule ?? {}) },
      spending: { ...defaults().spending, ...(stored.spending ?? {}) }, profiles: stored.profiles ?? [],
      mandates: stored.mandates ?? [], events: [], schedulerLeases: stored.schedulerLeases ?? [], system: { halted: false, ...(stored.system ?? {}) } };
  }

  private writeProjection(): void {
    this.db.prepare("INSERT INTO state(key, value) VALUES ('projection', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .run(stringify({ ...this.state, events: [] }));
  }

  private emit(type: string, payload: unknown, options: Pick<DurableEvent, "profileId" | "runId" | "provenance"> = {}): DurableEvent {
    const event: DurableEvent = { id: randomUUID(), sequence: 0, type, occurredAt: this.now().toISOString(), payload, ...options };
    const result = this.db.prepare("INSERT INTO events(id,type,occurred_at,profile_id,run_id,provenance,payload) VALUES(?,?,?,?,?,?,?)")
      .run(event.id, event.type, event.occurredAt, event.profileId ?? null, event.runId ?? null, event.provenance ?? null, stringify(event.payload));
    event.sequence = Number(result.lastInsertRowid);
    return event;
  }

  private commit(type: string, payload: unknown, mutate: () => void, options?: Pick<DurableEvent, "profileId" | "runId" | "provenance">): DurableEvent {
    let event!: DurableEvent;
    this.db.transaction(() => { mutate(); event = this.emit(type, payload, options); this.writeProjection(); })();
    for (const listener of this.listeners) { try { listener(this.getState()); } catch { /* observers are isolated */ } }
    return event;
  }

  /** External systems can record a durable lifecycle event without changing state. */
  appendEvent(type: string, payload: unknown, options?: Pick<DurableEvent, "profileId" | "runId" | "provenance">): DurableEvent {
    return this.commit(type, payload, () => undefined, options);
  }

  subscribe(listener: (state: StoreState) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  getState(): StoreState { return structuredClone(this.state); }
  close(): void { this.db.close(); }

  replayEvents(afterId?: string, profileId?: string): DurableEvent[] {
    let afterSequence = 0;
    if (afterId) afterSequence = Number((this.db.prepare("SELECT sequence FROM events WHERE id=?").get(afterId) as { sequence?: number } | undefined)?.sequence ?? 0);
    const rows = profileId
      ? this.db.prepare("SELECT * FROM events WHERE sequence>? AND profile_id=? ORDER BY sequence").all(afterSequence, profileId)
      : this.db.prepare("SELECT * FROM events WHERE sequence>? ORDER BY sequence").all(afterSequence);
    return (rows as Array<Record<string, unknown>>).map((row) => ({ id: String(row.id), sequence: Number(row.sequence), type: String(row.type), occurredAt: String(row.occurred_at), profileId: row.profile_id ? String(row.profile_id) : undefined, runId: row.run_id ? String(row.run_id) : undefined, provenance: row.provenance as DurableEvent["provenance"], payload: parse(String(row.payload)) }));
  }

  setAccount(account: ConnectedAccount): void { this.commit("account.connected", account, () => { this.state.account = account; }); }
  updateSchedule(update: Partial<ScheduleConfig>): ScheduleConfig {
    const next = { ...this.state.schedule, ...update };
    this.commit("schedule.updated", next, () => { this.state.schedule = next; this.db.prepare("INSERT INTO schedules(id,value,updated_at) VALUES('default',?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at").run(stringify(next), this.now().toISOString()); });
    return this.getState().schedule;
  }
  addRun(run: AgentMultiRunRecord, profileId?: string): void { this.commit("run.created", run, () => { this.state.runs.unshift(run); this.state.runs = this.state.runs.slice(0, 500); this.db.prepare("INSERT OR REPLACE INTO runs(id,account_id,status,value,updated_at) VALUES(?,?,?,?,?)").run(run.id, run.accountId, run.status, stringify(run), this.now().toISOString()); }, { runId: run.id, profileId }); }
  updateRun(runId: string, update: Partial<AgentMultiRunRecord>, profileId?: string): void { const index = this.state.runs.findIndex((run) => run.id === runId); if (index < 0) return; const next = { ...this.state.runs[index]!, ...update }; this.commit("run.updated", next, () => { this.state.runs[index] = next; this.db.prepare("INSERT OR REPLACE INTO runs(id,account_id,status,value,updated_at) VALUES(?,?,?,?,?)").run(next.id, next.accountId, next.status, stringify(next), this.now().toISOString()); }, { runId, profileId }); }
  addPendingTrade(trade: PendingTrade, profileId?: string): void { this.commit("trade.awaiting_approval", trade, () => { this.state.pendingTrades.unshift(trade); this.db.prepare("INSERT OR REPLACE INTO proposals(id,run_id,account_id,status,value,updated_at) VALUES(?,?,?,?,?,?)").run(trade.id, trade.runId, trade.accountId, trade.status, stringify(trade), this.now().toISOString()); }, { runId: trade.runId, profileId }); }
  updatePendingTrade(tradeId: string, update: Partial<PendingTrade>, profileId?: string): PendingTrade | null { const index = this.state.pendingTrades.findIndex((trade) => trade.id === tradeId); if (index < 0) return null; const next = { ...this.state.pendingTrades[index]!, ...update, evaluatedAt: this.now().toISOString() }; this.commit(`trade.${next.status}`, next, () => { this.state.pendingTrades[index] = next; this.db.prepare("INSERT OR REPLACE INTO proposals(id,run_id,account_id,status,value,updated_at) VALUES(?,?,?,?,?,?)").run(next.id, next.runId, next.accountId, next.status, stringify(next), this.now().toISOString()); }, { runId: next.runId, profileId }); return next; }
  findRunByIdempotency(accountId: string, idempotencyKey: string): AgentMultiRunRecord | null { return this.state.runs.find((run) => run.accountId === accountId && run.idempotencyKey === idempotencyKey) ?? null; }
  recordSpend(dataHbar: number, tradeHbar: number, profileId?: string): void { const date = this.now().toISOString().slice(0, 10); const next = { ...this.state.spending }; if (next.lastResetDate !== date) { next.todayDataHbar = 0; next.todayTradeHbar = 0; next.lastResetDate = date; } next.todayDataHbar += dataHbar; next.todayTradeHbar += tradeHbar; next.totalDataHbar += dataHbar; next.totalTradeHbar += tradeHbar; this.commit("spending.recorded", { dataHbar, tradeHbar, spending: next }, () => { this.state.spending = next; this.db.prepare("INSERT INTO spending(id,value,updated_at) VALUES('default',?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at").run(stringify(next), this.now().toISOString()); }, { profileId }); }
  log(level: "info" | "warn" | "error", message: string): void { const entry = { id: randomUUID(), level, message, timestamp: this.now().toISOString() }; this.commit("log.recorded", entry, () => { this.state.logs.unshift(entry); this.state.logs = this.state.logs.slice(0, 500); }); }

  upsertProfile(profile: PortfolioProfile): PortfolioProfile { this.commit("profile.updated", profile, () => { const i = this.state.profiles!.findIndex((item) => item.id === profile.id); if (i >= 0) this.state.profiles![i] = profile; else this.state.profiles!.push(profile); this.db.prepare("INSERT INTO profiles(id,value,updated_at) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at").run(profile.id, stringify(profile), profile.updatedAt); }, { profileId: profile.id }); return profile; }
  getProfile(id: string): PortfolioProfile | null { return this.state.profiles?.find((profile) => profile.id === id) ?? null; }
  getLatestMandate(profileId: string): PortfolioMandate | null { return this.state.mandates!.filter((mandate) => mandate.profileId === profileId).sort((a, b) => b.version - a.version)[0] ?? null; }
  saveMandate(mandate: PortfolioMandate): PortfolioMandate { this.commit("mandate.saved", mandate, () => { this.state.mandates!.push(mandate); this.db.prepare("INSERT OR REPLACE INTO mandates(id,profile_id,version,value,created_at) VALUES(?,?,?,?,?)").run(mandate.id, mandate.profileId, mandate.version, stringify(mandate), mandate.createdAt); }, { profileId: mandate.profileId }); return mandate; }
  setSystemHalt(halted: boolean, reason?: string): void { const system = halted ? { halted: true, haltedAt: this.now().toISOString(), reason } : { halted: false }; this.commit(halted ? "system.halted" : "system.resumed", system, () => { this.state.system = system; this.db.prepare("INSERT INTO system_state(id,value,updated_at) VALUES('default',?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at").run(stringify(system), this.now().toISOString()); }); }
  isHalted(): boolean { return Boolean(this.state.system?.halted); }

  acquireLease(key: string, holderId: string, ttlMs = 60_000): SchedulerLease | null {
    const now = this.now(); const expiresAt = new Date(now.getTime() + ttlMs).toISOString(); let lease: SchedulerLease | null = null;
    this.db.transaction(() => { this.db.prepare("DELETE FROM scheduler_leases WHERE expires_at<=?").run(now.toISOString()); const existing = this.db.prepare("SELECT key, holder_id AS holderId, acquired_at AS acquiredAt, expires_at AS expiresAt FROM scheduler_leases WHERE key=?").get(key) as SchedulerLease | undefined; if (existing && existing.holderId !== holderId) return; lease = { key, holderId, acquiredAt: now.toISOString(), expiresAt }; this.db.prepare("INSERT INTO scheduler_leases(key,holder_id,acquired_at,expires_at) VALUES(?,?,?,?) ON CONFLICT(key) DO UPDATE SET holder_id=excluded.holder_id,acquired_at=excluded.acquired_at,expires_at=excluded.expires_at").run(key, holderId, lease.acquiredAt, expiresAt); this.state.schedulerLeases = this.listLeases(); this.emit("scheduler.lease_acquired", lease); this.writeProjection(); })(); return lease;
  }
  releaseLease(key: string, holderId: string): boolean {
    let released = false;
    this.db.transaction(() => {
      released = this.db.prepare("DELETE FROM scheduler_leases WHERE key=? AND holder_id=?").run(key, holderId).changes > 0;
      if (!released) return;
      this.state.schedulerLeases = this.listLeases();
      this.emit("scheduler.lease_released", { key, holderId });
      this.writeProjection();
    })();
    if (released) for (const listener of this.listeners) { try { listener(this.getState()); } catch { /* observer isolation */ } }
    return released;
  }
  private listLeases(): SchedulerLease[] { return (this.db.prepare("SELECT key,holder_id as holderId,acquired_at as acquiredAt,expires_at as expiresAt FROM scheduler_leases ORDER BY key").all() as SchedulerLease[]); }
  recoverInterruptedRuns(): void { const running = this.state.runs.filter((run) => run.status === "running"); if (!running.length) return; this.commit("store.recovered", { runIds: running.map((run) => run.id) }, () => { for (const run of running) { run.status = "failed"; run.completedAt = this.now().toISOString(); run.error = "Interrupted by process restart before a verified outcome"; this.db.prepare("UPDATE runs SET status=?,value=?,updated_at=? WHERE id=?").run(run.status, stringify(run), this.now().toISOString(), run.id); } }); }
}

export const store = new AppStore();
