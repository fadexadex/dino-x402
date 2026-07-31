import type { PortfolioProfile, StoreState } from "./types.js";

/** Stable per-wallet session id so multiple Hedera accounts can coexist. */
export function userWalletProfileId(accountId: string): string {
  return `user-wallet-${accountId}`;
}

/** Prefer the explicit active session, then any active profile, then legacy ids. */
export function resolveActiveProfile(state: StoreState): PortfolioProfile | null {
  const profiles = state.profiles ?? [];
  if (state.activeProfileId) {
    const preferred = profiles.find((profile) => profile.id === state.activeProfileId);
    if (preferred) return preferred;
  }
  return (
    profiles.find((profile) => profile.status === "active") ??
    profiles.find((profile) => profile.id === "connected-wallet") ??
    profiles.find((profile) => profile.kind === "agent_managed") ??
    profiles[0] ??
    null
  );
}

export function findUserWalletForAccount(
  state: StoreState,
  accountId?: string | null,
): PortfolioProfile | null {
  const profiles = state.profiles ?? [];
  if (accountId) {
    return (
      profiles.find((profile) => profile.id === userWalletProfileId(accountId)) ??
      profiles.find((profile) => profile.kind === "user_wallet" && profile.accountId === accountId) ??
      (profiles.find((profile) => profile.id === "connected-wallet" && profile.accountId === accountId) ?? null)
    );
  }
  if (state.activeProfileId) {
    const active = profiles.find((profile) => profile.id === state.activeProfileId);
    if (active?.kind === "user_wallet") return active;
  }
  return (
    profiles.find((profile) => profile.kind === "user_wallet" && profile.status === "active") ??
    profiles.find((profile) => profile.id === "connected-wallet") ??
    profiles.find((profile) => profile.kind === "user_wallet") ??
    null
  );
}
