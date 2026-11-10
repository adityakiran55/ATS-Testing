/**
 * Provider adapters.
 *
 * The twelve providers specified in Part 11.A do not share a wire format. Rather
 * than pretending they do, each adapter declares the protocol family it speaks
 * and only the genuinely provider-specific parts are overridden.
 *
 *   openai family     : openai, xai, deepseek, mistral, groq, perplexity,
 *                       openrouter, azure
 *   anthropic family  : anthropic
 *   google family     : google (Gemini)
 *   cohere family     : cohere
 *   ollama family     : ollama (local, OpenAI-ish but its own /api endpoints)
 *
 * Endpoints and payloads follow each vendor's published API. No model names are
 * hardcoded — discovery is always dynamic where the vendor exposes it.
 */
import type {
  ChatRequest, ChatResult, DiscoveredModel, ProviderAdapter, ProviderContext,
  ProviderSlug, Usage
} from '../types'
import { ProviderError } from '../types'

const TIMEOUT_MS = 45_000

const jsonFetch = async (
  url: string,
  init: RequestInit & { timeoutMs?: number } = {}
): Promise<Response> => {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), init.timeoutMs ?? TIMEOUT_MS)
  try {
    return await fetch(url, { ...init, signal: ctrl.signal })
  } catch (err: any) {
    if (err?.name === 'AbortError') {
      throw new ProviderError('timeout', `Provider did not respond within ${init.timeoutMs ?? TIMEOUT_MS}ms`, { retryable: true })
    }
    throw new ProviderError('network_error', `Cannot reach provider: ${err?.message || 'network failure'}`, { retryable: true })
  } finally {
    clearTimeout(t)
  }
}

/** Turn a non-2xx response into a typed, non-retryable-or-retryable error. */
const raiseForStatus = async (res: Response, label: string): Promise<void> => {
  if (res.ok) return
  let detail = ''
  try {
    const body = await res.text()
    detail = body.slice(0, 400)
  } catch { /* ignore */ }
  const retryable = res.status === 429 || res.status >= 500
  const map: Record<number, string> = {
    401: 'invalid_api_key', 403: 'forbidden', 404: 'not_found',
    422: 'invalid_request', 429: 'rate_limited'
  }
  const code = map[res.status] || (res.status >= 500 ? 'provider_error' : 'bad_request')
  throw new ProviderError(code, `${label} returned ${res.status}${detail ? `: ${detail}` : ''}`, {
    retryable, status: res.status
  })
}

const usage = (i: number, o: number): Usage => ({
  inputTokens: i || 0,
  outputTokens: o || 0,
  totalTokens: (i || 0) + (o || 0)
})

/* =============================================================== openai family */
interface OpenAiOpts {
  /** Header style for the credential. */
  auth: (key: string, ctx: ProviderContext) => Record<string, string>
  /** Azure needs deployment-scoped paths and api-version query. */
  path?: (model: string) => string
  modelsPath?: string
  /** Perplexity has no /models endpoint. */
  discover?: 'standard' | 'none' | 'openrouter'
}

const openAiChat = async (
  label: string, ctx: ProviderContext, req: ChatRequest, opts: OpenAiOpts
): Promise<ChatResult> => {
  if (!ctx.apiKey && label !== 'Ollama') throw new ProviderError('missing_api_key', `${label}: no API key configured`)
  const url = `${ctx.baseUrl.replace(/\/$/, '')}${opts.path ? opts.path(req.model) : '/chat/completions'}`
  const res = await jsonFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...opts.auth(ctx.apiKey || '', ctx) },
    body: JSON.stringify({
      model: req.model,
      messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
      temperature: req.temperature ?? 0.3,
      max_tokens: req.maxTokens ?? 1200,
      stream: false
    })
  })
  await raiseForStatus(res, label)
  const body: any = await res.json()
  const choice = body?.choices?.[0]
  const text = choice?.message?.content ?? choice?.text ?? ''
  if (!text) throw new ProviderError('empty_response', `${label} returned an empty completion`)
  return {
    text: String(text).trim(),
    usage: usage(body?.usage?.prompt_tokens, body?.usage?.completion_tokens),
    model: body?.model || req.model,
    raw: body
  }
}

const openAiDiscovery = async (
  label: string, ctx: ProviderContext, opts: OpenAiOpts
): Promise<DiscoveredModel[]> => {
  if (opts.discover === 'none') {
    throw new ProviderError(
      'discovery_unsupported',
      `${label} does not expose a model-listing endpoint. Add model IDs manually.`
    )
  }
  const base = ctx.baseUrl.replace(/\/$/, '')
  const url = opts.discover === 'openrouter'
    ? `${base}/models`
    : `${base}${opts.modelsPath || '/models'}`
  const res = await jsonFetch(url, { headers: opts.auth(ctx.apiKey || '', ctx) })
  await raiseForStatus(res, label)
  const body: any = await res.json()
  const rows: any[] = body?.data || body?.models || []
  return rows
    .filter((m) => m && (m.id || m.name))
    .map((m) => ({
      modelId: m.id || m.name,
      name: m.name || m.id,
      // OpenRouter publishes pricing and context in its listing; others do not.
      contextWindow: m.context_length ?? m.context_window ?? null,
      inputPrice: m.pricing?.prompt ? Number(m.pricing.prompt) * 1_000_000 : null,
      outputPrice: m.pricing?.completion ? Number(m.pricing.completion) * 1_000_000 : null,
      streaming: true,
      tools: undefined,
      vision: undefined
    }))
}

const bearer = (key: string) => ({ Authorization: `Bearer ${key}` })

const openAiFamily = (
  slug: ProviderSlug, label: string, opts: OpenAiOpts
): ProviderAdapter => ({
  slug,
  label,
  family: 'openai',
  async testConnection(ctx) {
    try {
      const models = await openAiDiscovery(label, ctx, opts).catch(() => null)
      if (models) return { ok: true, message: `Authenticated. ${models.length} models visible.`, models: models.length }
      // Discovery unsupported: fall back to a 1-token completion probe.
      await openAiChat(label, ctx, {
        model: ctx.extra?.probeModel || 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'ping' }],
        maxTokens: 1
      }, opts)
      return { ok: true, message: 'Authenticated.' }
    } catch (e: any) {
      return { ok: false, message: e?.message || 'Connection failed' }
    }
  },
  listModels: (ctx) => openAiDiscovery(label, ctx, opts),
  chat: (ctx, req) => openAiChat(label, ctx, req, opts)
})

/* ==================================================================== anthropic */
const anthropic: ProviderAdapter = {
  slug: 'anthropic',
  label: 'Anthropic',
  family: 'anthropic',
  async testConnection(ctx) {
    try {
      const models = await this.listModels(ctx)
      return { ok: true, message: `Authenticated. ${models.length} models visible.`, models: models.length }
    } catch (e: any) {
      return { ok: false, message: e?.message || 'Connection failed' }
    }
  },
  async listModels(ctx) {
    // Anthropic publishes a real /v1/models endpoint.
    const res = await jsonFetch(`${ctx.baseUrl.replace(/\/$/, '')}/models?limit=100`, {
      headers: {
        'x-api-key': ctx.apiKey || '',
        'anthropic-version': '2023-06-01'
      }
    })
    await raiseForStatus(res, 'Anthropic')
    const body: any = await res.json()
    return (body?.data || []).map((m: any) => ({
      modelId: m.id,
      name: m.display_name || m.id,
      contextWindow: m.context_window ?? null,
      streaming: true,
      tools: true,
      vision: true
    }))
  },
  async chat(ctx, req) {
    if (!ctx.apiKey) throw new ProviderError('missing_api_key', 'Anthropic: no API key configured')
    // Anthropic takes the system prompt as a top-level field, not a message.
    const system = req.messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n')
    const rest = req.messages.filter((m) => m.role !== 'system')
      .map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content }))
    const res = await jsonFetch(`${ctx.baseUrl.replace(/\/$/, '')}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ctx.apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: req.model,
        max_tokens: req.maxTokens ?? 1200,
        temperature: req.temperature ?? 0.3,
        ...(system ? { system } : {}),
        messages: rest
      })
    })
    await raiseForStatus(res, 'Anthropic')
    const body: any = await res.json()
    const text = (body?.content || []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n')
    if (!text) throw new ProviderError('empty_response', 'Anthropic returned an empty completion')
    return {
      text: text.trim(),
      usage: usage(body?.usage?.input_tokens, body?.usage?.output_tokens),
      model: body?.model || req.model,
      raw: body
    }
  }
}

/* ======================================================================= google */
const google: ProviderAdapter = {
  slug: 'google',
  label: 'Google Gemini',
  family: 'google',
  async testConnection(ctx) {
    try {
      const models = await this.listModels(ctx)
      return { ok: true, message: `Authenticated. ${models.length} models visible.`, models: models.length }
    } catch (e: any) {
      return { ok: false, message: e?.message || 'Connection failed' }
    }
  },
  async listModels(ctx) {
    if (!ctx.apiKey) throw new ProviderError('missing_api_key', 'Google: no API key configured')
    const res = await jsonFetch(
      `${ctx.baseUrl.replace(/\/$/, '')}/models?key=${encodeURIComponent(ctx.apiKey)}&pageSize=200`
    )
    await raiseForStatus(res, 'Google')
    const body: any = await res.json()
    return (body?.models || []).map((m: any) => ({
      modelId: String(m.name || '').replace(/^models\//, ''),
      name: m.displayName || m.name,
      contextWindow: m.inputTokenLimit ?? null,
      streaming: true,
      tools: Array.isArray(m.supportedGenerationMethods) && m.supportedGenerationMethods.includes('generateContent'),
      vision: undefined
    }))
  },
  async chat(ctx, req) {
    if (!ctx.apiKey) throw new ProviderError('missing_api_key', 'Google: no API key configured')
    const system = req.messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n')
    const contents = req.messages.filter((m) => m.role !== 'system').map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }]
    }))
    const res = await jsonFetch(
      `${ctx.baseUrl.replace(/\/$/, '')}/models/${encodeURIComponent(req.model)}:generateContent?key=${encodeURIComponent(ctx.apiKey)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents,
          ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
          generationConfig: {
            temperature: req.temperature ?? 0.3,
            maxOutputTokens: req.maxTokens ?? 1200
          }
        })
      }
    )
    await raiseForStatus(res, 'Google')
    const body: any = await res.json()
    const text = (body?.candidates?.[0]?.content?.parts || []).map((p: any) => p.text || '').join('')
    if (!text) throw new ProviderError('empty_response', 'Google returned an empty completion')
    const md = body?.usageMetadata || {}
    return {
      text: text.trim(),
      usage: usage(md.promptTokenCount, md.candidatesTokenCount),
      model: req.model,
      raw: body
    }
  }
}

/* ======================================================================= cohere */
const cohere: ProviderAdapter = {
  slug: 'cohere',
  label: 'Cohere',
  family: 'cohere',
  async testConnection(ctx) {
    try {
      const models = await this.listModels(ctx)
      return { ok: true, message: `Authenticated. ${models.length} models visible.`, models: models.length }
    } catch (e: any) {
      return { ok: false, message: e?.message || 'Connection failed' }
    }
  },
  async listModels(ctx) {
    if (!ctx.apiKey) throw new ProviderError('missing_api_key', 'Cohere: no API key configured')
    const res = await jsonFetch(`${ctx.baseUrl.replace(/\/$/, '')}/models?page_size=100`, {
      headers: bearer(ctx.apiKey)
    })
    await raiseForStatus(res, 'Cohere')
    const body: any = await res.json()
    return (body?.models || [])
      .filter((m: any) => !Array.isArray(m.endpoints) || m.endpoints.includes('chat'))
      .map((m: any) => ({
        modelId: m.name,
        name: m.name,
        contextWindow: m.context_length ?? null,
        streaming: true,
        tools: Array.isArray(m.features) ? m.features.includes('tools') : undefined,
        vision: undefined
      }))
  },
  async chat(ctx, req) {
    if (!ctx.apiKey) throw new ProviderError('missing_api_key', 'Cohere: no API key configured')
    const system = req.messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n')
    const rest = req.messages.filter((m) => m.role !== 'system')
    const res = await jsonFetch(`${ctx.baseUrl.replace(/\/$/, '')}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...bearer(ctx.apiKey) },
      body: JSON.stringify({
        model: req.model,
        message: rest.filter((m) => m.role === 'user').map((m) => m.content).join('\n\n'),
        ...(system ? { preamble: system } : {}),
        chat_history: rest.filter((m) => m.role === 'assistant').map((m) => ({ role: 'CHATBOT', message: m.content })),
        temperature: req.temperature ?? 0.3,
        max_tokens: req.maxTokens ?? 1200
      })
    })
    await raiseForStatus(res, 'Cohere')
    const body: any = await res.json()
    const text = body?.text || (body?.message?.content || []).map((c: any) => c.text || '').join('')
    if (!text) throw new ProviderError('empty_response', 'Cohere returned an empty completion')
    const b = body?.usage?.billed_units || body?.usage?.tokens || {}
    return {
      text: String(text).trim(),
      usage: usage(b.input_tokens, b.output_tokens),
      model: req.model,
      raw: body
    }
  }
}

/* ======================================================================= ollama */
const ollama: ProviderAdapter = {
  slug: 'ollama',
  label: 'Ollama',
  family: 'ollama',
  async testConnection(ctx) {
    try {
      const models = await this.listModels(ctx)
      return { ok: true, message: `Local server reachable. ${models.length} model(s) installed.`, models: models.length }
    } catch (e: any) {
      return { ok: false, message: e?.message || 'Cannot reach local Ollama server' }
    }
  },
  async listModels(ctx) {
    // Ollama requires no API key; it is local-only by design.
    const res = await jsonFetch(`${ctx.baseUrl.replace(/\/$/, '')}/api/tags`, {}, )
    await raiseForStatus(res, 'Ollama')
    const body: any = await res.json()
    return (body?.models || []).map((m: any) => ({
      modelId: m.name,
      name: m.name,
      // Ollama exposes byte size, not a token window; do not invent one.
      contextWindow: null,
      streaming: true,
      tools: true,
      vision: undefined
    }))
  },
  async chat(ctx, req) {
    const res = await jsonFetch(`${ctx.baseUrl.replace(/\/$/, '')}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // Local inference can be slow on CPU; allow more headroom.
      timeoutMs: 180_000,
      body: JSON.stringify({
        model: req.model,
        messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
        stream: false,
        options: { temperature: req.temperature ?? 0.3, num_predict: req.maxTokens ?? 1200 }
      })
    })
    await raiseForStatus(res, 'Ollama')
    const body: any = await res.json()
    const text = body?.message?.content || ''
    if (!text) throw new ProviderError('empty_response', 'Ollama returned an empty completion')
    // Ollama reports real token counts; surface them rather than estimating.
    return {
      text: String(text).trim(),
      usage: usage(body?.prompt_eval_count, body?.eval_count),
      model: body?.model || req.model,
      raw: body
    }
  }
}

/* ==================================================================== registry */
export const ADAPTERS: Record<ProviderSlug, ProviderAdapter> = {
  openai: openAiFamily('openai', 'OpenAI', {
    auth: bearer, modelsPath: '/models'
  }),
  xai: openAiFamily('xai', 'xAI', {
    auth: bearer, modelsPath: '/language-models', discover: 'none'
  }),
  deepseek: openAiFamily('deepseek', 'DeepSeek', {
    auth: bearer, modelsPath: '/models'
  }),
  mistral: openAiFamily('mistral', 'Mistral AI', {
    auth: bearer, modelsPath: '/models'
  }),
  groq: openAiFamily('groq', 'Groq', {
    auth: bearer, modelsPath: '/models'
  }),
  perplexity: openAiFamily('perplexity', 'Perplexity', {
    auth: bearer, discover: 'none'
  }),
  openrouter: openAiFamily('openrouter', 'OpenRouter', {
    auth: bearer, discover: 'openrouter'
  }),
  azure: {
    ...openAiFamily('azure', 'Azure OpenAI', {
      auth: (key) => ({ 'api-key': key }),
      // Azure routes by deployment name and pins an api-version.
      path: (model) => `/deployments/${encodeURIComponent(model)}/chat/completions?api-version=2024-10-21`,
      modelsPath: '/models',
      discover: 'none'
    })
  },
  anthropic,
  google,
  cohere,
  ollama
}

export const adapterFor = (slug: string): ProviderAdapter => {
  const a = ADAPTERS[slug as ProviderSlug]
  if (!a) throw new ProviderError('unknown_provider', `No adapter registered for "${slug}"`)
  return a
}
