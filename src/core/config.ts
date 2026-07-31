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
    };
};
