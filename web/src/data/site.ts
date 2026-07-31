export const site = {
  apiBase: "http://localhost:4021",
  network: "hedera:testnet",
  asset: "0.0.0",
  payTo: "0.0.4515756",
  feePayer: "0.0.7162784",
  x402Version: 2,
  repoUrl: "https://github.com/fadexadex/marketrail-x402",
  x402DocsUrl: "https://docs.x402.org",
  faucetUrl: "https://portal.hedera.com",
  nav: [
    { label: "Live demo", href: "#demo" },
    { label: "Architecture", href: "#architecture" },
    { label: "Pricing", href: "#pricing" },
    { label: "Docs", href: "#docs" },
  ],
} as const;
