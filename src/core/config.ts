export interface ServerConfig {
    hederaNetwork: string;
    facilitatorUrl: string;
    payToAccount: string;
    dataProvider: string;
    port: number;
    agentPayerId?: string;
    agentPayerKey?: string;
    agentDataBaseUrl?: string;
    agentMaxSpendAtomic?: string;
    mistralApiKey?: string;
    mistralModel?: string;
    tradeMaxAmountTinybar?: string;
    tradeSlippageBps?: string;
    mirrorNodeBaseUrl?: string;
    saucerRouterId?: string;
    saucerQuoterId?: string;
    saucerWhbarTokenId?: string;
    saucerUsdcTokenId?: string;
    saucerSauceTokenId?: string;
    saucerFeeTier?: string;
}

const required = (name: string): string => {
    const value = process.env[name];
    if (!value) throw new Error(`Missing required env var: ${name}`);
    return value;
};

export const loadConfig = (): ServerConfig => {
    const port = Number(process.env.PORT ?? "4021");
    return {
        hederaNetwork: required("HEDERA_NETWORK"),
        facilitatorUrl: required("FACILITATOR_URL"),
        payToAccount: required("PAY_TO_ACCOUNT"),
        dataProvider: process.env.DATA_PROVIDER ?? "mock",
        port,
        ...(process.env.HEDERA_CLIENT_ID ? { agentPayerId: process.env.HEDERA_CLIENT_ID } : {}),
        ...(process.env.HEDERA_CLIENT_KEY ? { agentPayerKey: process.env.HEDERA_CLIENT_KEY } : {}),
        ...(process.env.AGENT_DATA_BASE_URL ? { agentDataBaseUrl: process.env.AGENT_DATA_BASE_URL } : {}),
        ...(process.env.AGENT_MAX_SPEND_ATOMIC ? { agentMaxSpendAtomic: process.env.AGENT_MAX_SPEND_ATOMIC } : {}),
        ...(process.env.MISTRAL_API_KEY ? { mistralApiKey: process.env.MISTRAL_API_KEY } : {}),
        ...(process.env.MISTRAL_MODEL ? { mistralModel: process.env.MISTRAL_MODEL } : {}),
        ...(process.env.TRADE_MAX_AMOUNT_TINYBAR ? { tradeMaxAmountTinybar: process.env.TRADE_MAX_AMOUNT_TINYBAR } : {}),
        ...(process.env.TRADE_SLIPPAGE_BPS ? { tradeSlippageBps: process.env.TRADE_SLIPPAGE_BPS } : {}),
        ...(process.env.MIRROR_NODE_BASE_URL ? { mirrorNodeBaseUrl: process.env.MIRROR_NODE_BASE_URL } : {}),
        ...(process.env.SAUCERSWAP_ROUTER_ID ? { saucerRouterId: process.env.SAUCERSWAP_ROUTER_ID } : {}),
        ...(process.env.SAUCERSWAP_QUOTER_ID ? { saucerQuoterId: process.env.SAUCERSWAP_QUOTER_ID } : {}),
        ...(process.env.SAUCERSWAP_WHBAR_TOKEN_ID ? { saucerWhbarTokenId: process.env.SAUCERSWAP_WHBAR_TOKEN_ID } : {}),
        ...(process.env.SAUCERSWAP_USDC_TOKEN_ID ? { saucerUsdcTokenId: process.env.SAUCERSWAP_USDC_TOKEN_ID } : {}),
        ...(process.env.SAUCERSWAP_SAUCE_TOKEN_ID ? { saucerSauceTokenId: process.env.SAUCERSWAP_SAUCE_TOKEN_ID } : {}),
        ...(process.env.SAUCERSWAP_FEE_TIER ? { saucerFeeTier: process.env.SAUCERSWAP_FEE_TIER } : {}),
    };
};
