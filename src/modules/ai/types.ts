/** Shared contracts for the AI gateway. Adapters implement `ProviderAdapter`. */

export type ProviderSlug =
  | 'openai' | 'anthropic' | 'xai' | 'deepseek' | 'ollama' | 'google'
  | 'azure' | 'mistral' | 'groq' | 'perplexity' | 'openrouter' | 'cohere'

export type ChatRole = 'system' | 'user' | 'assistant'

export interface ChatMessage {
  role: ChatRole
  content: string
}

export interface ChatRequest {
  model: string
  messages: ChatMessage[]
  temperature?: number
  maxTokens?: number
  /** Ask the provider to stream. Only used by the SSE path. */
  stream?: boolean
}

export interface Usage {
  inputTokens: number
  outputTokens: number
  totalTokens: number
}

export interface ChatResult {
  text: string
  usage: Usage
  model: string
  raw?: unknown
}

/** Everything an adapter needs to make a call. Decrypted key stays in memory. */
export interface ProviderContext {
  apiKey: string | null
  baseUrl: string
  orgId?: string | null
  /** Azure only: deployment name is carried in `model`. */
  extra?: Record<string, string>
}

export interface DiscoveredModel {
  modelId: string
  name: string
  contextWindow?: number | null
  inputPrice?: number | null
  outputPrice?: number | null
  vision?: boolean
  tools?: boolean
  streaming?: boolean
}

export interface ProviderAdapter {
  slug: ProviderSlug
  /** Human label used in errors. */
  label: string
  /** Which wire protocol the adapter speaks. */
  family: 'openai' | 'anthropic' | 'google' | 'cohere' | 'ollama'
  /** Validate credentials against the real API. */
  testConnection(ctx: ProviderContext): Promise<{ ok: boolean; message: string; models?: number }>
  /** Dynamic model discovery where the provider supports it. */
  listModels(ctx: ProviderContext): Promise<DiscoveredModel[]>
  /** Single non-streaming completion. */
  chat(ctx: ProviderContext, req: ChatRequest): Promise<ChatResult>
}

export class ProviderError extends Error {
  code: string
  retryable: boolean
  status?: number
  constructor(code: string, message: string, opts: { retryable?: boolean; status?: number } = {}) {
    super(message)
    this.code = code
    this.retryable = opts.retryable ?? false
    this.status = opts.status
  }
}

export type FeatureKey =
  | 'resume_screening' | 'resume_parsing' | 'job_description' | 'candidate_matching'
  | 'interview_questions' | 'email_assistant' | 'analytics_insight' | 'chat_assistant'

export const FEATURE_LABELS: Record<FeatureKey, { label: string; hint: string }> = {
  resume_screening:    { label: 'Resume screening',    hint: 'Score a resume against a job description with evidence' },
  resume_parsing:      { label: 'Resume parsing',      hint: 'Extract contact, employment, skills, education' },
  job_description:     { label: 'Job description',     hint: 'Draft responsibilities, skills, inclusive language' },
  candidate_matching:  { label: 'Candidate matching',  hint: 'Rank candidates for a requisition with reasons' },
  interview_questions: { label: 'Interview assistant', hint: 'Generate role-specific interview questions' },
  email_assistant:     { label: 'Email assistant',     hint: 'Draft candidate communications' },
  analytics_insight:   { label: 'Recruitment analytics', hint: 'Narrative summaries over real funnel data' },
  chat_assistant:      { label: 'AI chat assistant',   hint: 'Conversational Q&A over authorised ATS data' }
}
