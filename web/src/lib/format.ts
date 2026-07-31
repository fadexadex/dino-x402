export const usd = (n: number, digits = 2) =>
  `$${n.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;

export const tinybarToHbar = (tinybar: string | number | bigint) => (Number(tinybar) / 100_000_000).toFixed(8).replace(/\.?0+$/, "");

export const micro = (n: number) => `$${n.toFixed(n < 0.01 ? 4 : 3)}`;

export const num = (n: number, digits = 2) =>
  n.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });

export const clock = (t: number) =>
  new Date(t).toLocaleTimeString("en-US", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

export const shortHash = (h: string) => `${h.slice(0, 12)}…${h.slice(-6)}`;

export const hashscan = (h: string) =>
  `https://hashscan.io/testnet/transaction/${encodeURIComponent(h)}`;

export function countdown(msLeft: number) {
  const s = Math.max(0, Math.floor(msLeft / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
