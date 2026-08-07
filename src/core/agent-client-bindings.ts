import type { SqlQuery } from './sql-query.ts';
import type { GBrainConfig } from './config.ts';
import { assertValidSourceId } from './source-id.ts';
import { BRAIN_TOOL_ALLOWLIST } from './minions/tools/brain-allowlist.ts';
import {
  evaluateGovernedModelPolicy,
  knownProviderIds,
  parseGovernedModelList,
} from './ai/model-resolver.ts';

export const AGENT_CONTROL_CAPABILITIES = [
  'whoami',
  'submit_agent',
  'get_owned_job',
  'list_owned_jobs',
  'cancel_owned_job',
  'message_owned_job',
  'get_owned_job_events',
] as const;

export type AgentControlCapability = typeof AGENT_CONTROL_CAPABILITIES[number];

export interface AgentClientBindings {
  controlCapabilities?: string[];
  boundTools?: string[];
  boundSourceId?: string;
  boundBrainId?: string;
  boundSlugPrefixes?: string[];
  boundMaxConcurrent?: number;
  budgetUsdPerDay?: string | number;
  allowedProviders?: string[];
  allowedModels?: string[];
}

export interface NormalizedAgentClientBindings {
  controlCapabilities: AgentControlCapability[];
  boundTools: string[];
  boundSourceId: string | null;
  boundBrainId: string | null;
  boundSlugPrefixes: string[];
  boundMaxConcurrent: number;
  budgetUsdPerDay: string | null;
  allowedProviders: string[];
  allowedModels: string[];
}

function uniqueSorted(values: readonly string[] | undefined): string[] {
  return [...new Set((values ?? []).map(value => value.trim()))].sort();
}

function normalizeBudget(value: string | number | undefined): string | null {
  if (value === undefined) return null;
  const parsed = typeof value === 'number' ? value : Number(value.trim());
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error('budget_usd_per_day must be a finite non-negative number');
  }
  return parsed.toString();
}

async function readConfig(sql: SqlQuery, key: string): Promise<string | null> {
  const rows = await sql`SELECT value FROM config WHERE key = ${key} LIMIT 1`;
  return typeof rows[0]?.value === 'string' ? rows[0].value : null;
}

export async function validateAgentClientBindings(
  sql: SqlQuery,
  input: AgentClientBindings,
  defaultSourceId = 'default',
  operatorConfig?: Pick<GBrainConfig, 'chat_model' | 'chat_fallback_chain'>,
): Promise<NormalizedAgentClientBindings> {
  const governed = input.controlCapabilities !== undefined ||
    input.allowedProviders !== undefined || input.allowedModels !== undefined;
  const controlCapabilities = uniqueSorted(input.controlCapabilities);
  const allowedCapabilities = new Set<string>(AGENT_CONTROL_CAPABILITIES);
  for (const capability of controlCapabilities) {
    if (!allowedCapabilities.has(capability)) {
      throw new Error(`unknown agent control capability: ${capability}`);
    }
  }

  const boundTools = uniqueSorted(input.boundTools);
  for (const tool of boundTools) {
    if (!BRAIN_TOOL_ALLOWLIST.has(tool)) {
      throw new Error(`unknown or non-inheritable agent tool: ${tool}`);
    }
  }

  const boundSourceId = input.boundSourceId?.trim() || null;
  if (boundSourceId) {
    assertValidSourceId(boundSourceId);
    if (governed) {
      const rows = await sql`SELECT 1 FROM sources WHERE id = ${boundSourceId} LIMIT 1`;
      if (rows.length === 0) throw new Error(`unknown source id: ${boundSourceId}`);
    }
  }

  const boundSlugPrefixes = uniqueSorted(input.boundSlugPrefixes);
  if (input.boundSlugPrefixes && boundSlugPrefixes.length === 0) {
    throw new Error('bound_slug_prefixes cannot be empty when supplied');
  }
  for (const prefix of boundSlugPrefixes) {
    if (prefix === '') throw new Error('bound_slug_prefixes entries must be non-empty');
    if (!/^[a-z0-9][a-z0-9._/-]*\/$/.test(prefix) || prefix.length > 256) {
      throw new Error(`invalid slash-based slug prefix: ${prefix}`);
    }
    const effectiveSourceId = boundSourceId ?? defaultSourceId;
    if (governed) {
      const rows = await sql`
        SELECT 1 FROM pages WHERE source_id = ${effectiveSourceId} AND slug LIKE ${`${prefix}%`} LIMIT 1
      `;
      if (rows.length === 0) throw new Error(`unknown slug prefix for source ${effectiveSourceId}: ${prefix}`);
    }
  }

  const boundMaxConcurrent = input.boundMaxConcurrent ?? 1;
  if (!Number.isInteger(boundMaxConcurrent) || boundMaxConcurrent < 1 || boundMaxConcurrent > 1000) {
    throw new Error('bound_max_concurrent must be an integer between 1 and 1000');
  }

  const knownProviders = new Set(knownProviderIds());
  const allowedProviders = uniqueSorted(input.allowedProviders).map(provider => provider.toLowerCase());
  for (const provider of allowedProviders) {
    if (!knownProviders.has(provider)) throw new Error(`unknown provider: ${provider}`);
  }

  const requestedModels = uniqueSorted(input.allowedModels);
  let allowedModels: string[] = [];
  if (requestedModels.length > 0) {
    const dbChatModel = operatorConfig?.chat_model === undefined
      ? await readConfig(sql, 'chat_model')
      : null;
    const approvedModels = parseGovernedModelList(await readConfig(sql, 'agent.approved_models'));
    const operatorModels = [
      operatorConfig?.chat_model ?? dbChatModel,
      ...(operatorConfig?.chat_fallback_chain ?? []),
      ...approvedModels,
    ];
    allowedModels = requestedModels
      .map(model => evaluateGovernedModelPolicy(model, operatorModels).model)
      .sort();
  }
  for (const model of allowedModels) {
    const provider = model.slice(0, model.indexOf(':'));
    if (allowedProviders.length > 0 && !allowedProviders.includes(provider)) {
      throw new Error(`model ${model} is outside the provider allowlist`);
    }
  }

  return {
    controlCapabilities: controlCapabilities as AgentControlCapability[],
    boundTools,
    boundSourceId,
    boundBrainId: input.boundBrainId?.trim() || null,
    boundSlugPrefixes,
    boundMaxConcurrent,
    budgetUsdPerDay: normalizeBudget(input.budgetUsdPerDay),
    allowedProviders,
    allowedModels,
  };
}
