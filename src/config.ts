import { BASE_CAIP2, USDC_BASE_ADDRESS } from "./domain/money.js";

export interface MarketConfig {
  port: number;
  protocolTreasuryAddress?: string;
  protocolTreasuryLabel: string;
  berthosUrl?: string;
  berthosDoctorPath: string;
  usdcAsset: string;
  network: typeof BASE_CAIP2;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): MarketConfig {
  const port = Number.parseInt(env.PORT ?? "8787", 10);
  return {
    port: Number.isFinite(port) ? port : 8787,
    protocolTreasuryAddress: env.PROTOCOL_TREASURY_ADDRESS || undefined,
    protocolTreasuryLabel: env.PROTOCOL_TREASURY_LABEL ?? "berth-protocol",
    berthosUrl: env.BERTHOS_URL || undefined,
    berthosDoctorPath: env.BERTHOS_DOCTOR_PATH ?? "/doctor",
    usdcAsset: USDC_BASE_ADDRESS,
    network: BASE_CAIP2,
  };
}
