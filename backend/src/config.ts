import { fileURLToPath } from 'node:url';
import type { Weights, AgentConfig } from './core/types.js';

export const DEFAULT_WEIGHTS: Weights = {
  feasibility: 0.30,
  coldchain: 0.15,
  capacity: 0.20,
  equity: 0.20,
  prefs: 0.15,
};

export type LlmProvider = 'mock' | 'anthropic' | 'insforge' | 'gemini';
export type DbProvider = 'json' | 'insforge';
export type VoiceProvider = 'sim' | 'vapi';

export interface EnvConfig {
  llmProvider: LlmProvider;
  anthropicApiKey: string;
  insforgeAiBaseUrl: string;
  insforgeAiKey: string;
  insforgeAiModel: string;
  geminiApiKey: string;
  geminiModel: string;
  dbProvider: DbProvider;
  insforgeBaseUrl: string;
  insforgeApiKey: string;
  voiceProvider: VoiceProvider;
  vapiApiKey: string;
  vapiPhoneNumberId: string;
  /**
   * Demo safety valve. When set to an E.164 number, EVERY live outbound call is
   * dialed to it instead of to the ranked recipient's real phone. The pipeline is
   * untouched — intake, scoring, and the agent's choice of pantry all run for
   * real, and the assistant still speaks as if calling the chosen recipient. Only
   * the dial target is redirected, at the last inch.
   *
   * Unset ⇒ recipients' real phones are dialed. Set this for any demo or test
   * run against the seeded network, whose numbers are fake (+1 415 555 01xx) but
   * are NOT guaranteed unrouted.
   */
  liveCallPhoneOverride: string;
  /**
   * Public base URL VAPI posts call reports back to — the origin only, no path;
   * `/api/vapi/webhook` is appended. An ngrok tunnel today, the deployed InsForge
   * function later; swapping between them is an env change, not a code change.
   *
   * Unset ⇒ no `server` block on the assistant, so VAPI falls back to whatever
   * account-level webhook is configured (today: none) and a live call can only
   * ever resolve by hitting its 90s timeout.
   */
  publicWebhookUrl: string;
  /**
   * Shared secret echoed back by VAPI in the `X-Vapi-Secret` header. Set ⇒ the
   * webhook route rejects any request that doesn't carry it. Unset ⇒ the route
   * accepts unauthenticated posts, which is fine on localhost but means anyone
   * who finds a public tunnel URL can forge an "accepted" outcome.
   */
  vapiWebhookSecret: string;
  /**
   * The organisation Donna says she works for, on every call.
   *
   * Must be an organisation the operator actually runs — the assistant states it
   * as fact to donors and pantries. Left unset it degrades to the generic "the
   * food bank", which is honest; what it must never be is a real food bank you
   * are not.
   */
  foodBankName: string;
  port: number;
}

// ---------------------------------------------------------------------------
// §D.2 — load backend/.env at boot via Node's process.loadEnvFile (≥20.12),
// with no new dependency. Real environment variables always win: any var that
// was already present is restored after the file loads, so the file only fills
// in vars that were not already set. An absent/unreadable file is fine — the
// keyless mock default still rules. Skipped under the test runner so vitest
// always sees the mock default regardless of a local .env.
// ---------------------------------------------------------------------------
function loadDotEnv(): void {
  if (process.env.VITEST || process.env.NODE_ENV === 'test') return;
  const loader = (process as unknown as { loadEnvFile?: (path?: string) => void }).loadEnvFile;
  if (typeof loader !== 'function') return;
  try {
    const envPath = fileURLToPath(new URL('../.env', import.meta.url));
    const before: Record<string, string | undefined> = {};
    for (const k of Object.keys(process.env)) before[k] = process.env[k];
    loader(envPath);
    for (const k of Object.keys(before)) {
      const prev = before[k];
      if (prev !== undefined) process.env[k] = prev; // real env wins
    }
  } catch {
    // No .env (or unreadable) — keyless mock default is intended here.
  }
}
loadDotEnv();

function pick<T extends string>(value: string | undefined, allowed: readonly T[], fallback: T): T {
  const v = (value ?? '').trim();
  return (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
}

export function loadEnv(env: NodeJS.ProcessEnv = process.env): EnvConfig {
  return {
    llmProvider: pick(env.LLM_PROVIDER, ['mock', 'anthropic', 'insforge', 'gemini'] as const, 'mock'),
    anthropicApiKey: env.ANTHROPIC_API_KEY ?? '',
    insforgeAiBaseUrl: env.INSFORGE_AI_BASE_URL ?? '',
    insforgeAiKey: env.INSFORGE_AI_KEY ?? '',
    insforgeAiModel: env.INSFORGE_AI_MODEL ?? 'anthropic/claude-sonnet-4.5',
    geminiApiKey: env.GEMINI_API_KEY ?? '',
    geminiModel: env.GEMINI_MODEL ?? 'gemini-2.5-flash',
    dbProvider: pick(env.DB_PROVIDER, ['json', 'insforge'] as const, 'json'),
    insforgeBaseUrl: env.INSFORGE_BASE_URL ?? '',
    insforgeApiKey: env.INSFORGE_API_KEY ?? '',
    voiceProvider: pick(env.VOICE_PROVIDER, ['sim', 'vapi'] as const, 'sim'),
    vapiApiKey: env.VAPI_API_KEY ?? '',
    vapiPhoneNumberId: env.VAPI_PHONE_NUMBER_ID ?? '',
    liveCallPhoneOverride: (env.LIVE_CALL_PHONE_OVERRIDE ?? '').trim(),
    publicWebhookUrl: (env.PUBLIC_WEBHOOK_URL ?? '').trim().replace(/\/+$/, ''),
    vapiWebhookSecret: (env.VAPI_WEBHOOK_SECRET ?? '').trim(),
    foodBankName: (env.FOOD_BANK_NAME ?? '').trim() || 'the food bank',
    port: Number.parseInt(env.PORT ?? '8787', 10) || 8787,
  };
}

export const ENV: EnvConfig = loadEnv();

export const DEFAULT_AGENT_CONFIG: AgentConfig = {
  weights: { ...DEFAULT_WEIGHTS },
  autopilot: false,
  avgSpeedMph: 30,
};
