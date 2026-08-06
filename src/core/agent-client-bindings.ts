import type { SqlQuery } from './sql-query.ts';
import { assertValidSourceId } from './source-id.ts';
import { BRAIN_TOOL_ALLOWLIST } from './minions/tools/brain-allowlist.ts';
import { assertTouchpoint, knownProviderIds, resolveRecipe } from './ai/model-resolver.ts';

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

function normalizeModel(value: string): string {
  if (!/^[a-z0-9][a-z0-9._-]*:[A-Za-z0-9][A-Za-z0-9._:/-]{0,254}$/.test(value)) {
    throw new Error(`allowed model "${value}" must use a bounded provider:model identifier`);
  }
  const { parsed, recipe } = resolveRecipe(value);
  assertTouchpoint(recipe, 'chat', parsed.modelId);
  return `${parsed.providerId}:${value.slice(value.indexOf(':') + 1)}`;
}

export async function validateAgentClientBindings(
  sql: SqlQuery,
  input: AgentClientBindings,
  defaultSourceId = 'default',
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

  const allowedModels = uniqueSorted(input.allowedModels).map(normalizeModel).sort();
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
