import { afterEach, describe, expect, it, vi } from "vitest";
import { AppStore } from "../src/store/index.js";
import { findUserWalletForAccount, resolveActiveProfile, userWalletProfileId } from "../src/store/sessions.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

describe("session helpers", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("builds stable per-wallet profile ids and resolves the active session", () => {
    expect(userWalletProfileId("0.0.42")).toBe("user-wallet-0.0.42");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dino-session-"));
    dirs.push(dir);
    const store = new AppStore({ databasePath: path.join(dir, "agent.sqlite") });
    const now = new Date().toISOString();
    store.upsertProfile({
      id: "user-wallet-0.0.1",
      name: "One",
      kind: "user_wallet",
      accountId: "0.0.1",
      network: "hedera:testnet",
      status: "paused",
      createdAt: now,
      updatedAt: now,
    });
    store.upsertProfile({
      id: "user-wallet-0.0.2",
      name: "Two",
      kind: "user_wallet",
      accountId: "0.0.2",
      network: "hedera:testnet",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    store.setActiveProfileId("user-wallet-0.0.2");
    expect(resolveActiveProfile(store.getState())?.accountId).toBe("0.0.2");
    expect(findUserWalletForAccount(store.getState(), "0.0.1")?.id).toBe("user-wallet-0.0.1");
  });
});
