/**
 * AI 供应商配置（OpenAI 兼容协议）。
 *
 * 目前支持：
 *   · deepseek —— DEEPSEEK_API_KEY / DEEPSEEK_BASE_URL / DEEPSEEK_MODEL
 *   · mimo     —— MIMO_API_KEY / MIMO_BASE_URL / MIMO_MODEL
 * 未配置 AI_PROVIDER 时按存在的 Key 自动选。
 */

export interface AiConfig {
  provider: 'deepseek' | 'mimo' | 'custom';
  apiKey: string;
  baseUrl: string;
  model: string;
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

/** OpenAI 兼容的 chat completions 地址。base 可以是 .../v1，也可以是不带版本号的根地址。 */
export function chatCompletionsUrl(baseUrl: string): string {
  const base = trimSlash(baseUrl);
  if (base.endsWith('/chat/completions')) return base;
  return `${base}/chat/completions`;
}

export function getAiConfig(): AiConfig | null {
  const provider = (process.env.AI_PROVIDER ?? '').trim().toLowerCase();

  if (provider === 'deepseek' || (!provider && process.env.DEEPSEEK_API_KEY)) {
    const apiKey = process.env.DEEPSEEK_API_KEY?.trim();
    if (!apiKey) return null;
    return {
      provider: 'deepseek',
      apiKey,
      baseUrl: trimSlash(process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com'),
      model: process.env.DEEPSEEK_MODEL?.trim() || 'deepseek-v4-pro',
    };
  }

  if (provider === 'mimo' || (!provider && process.env.MIMO_API_KEY)) {
    const apiKey = process.env.MIMO_API_KEY?.trim();
    if (!apiKey) return null;
    return {
      provider: 'mimo',
      apiKey,
      baseUrl: trimSlash(process.env.MIMO_BASE_URL || 'https://api.openai.com/v1'),
      model: process.env.MIMO_MODEL?.trim() || 'gpt-4o-mini',
    };
  }

  // 自定义 OpenAI 兼容供应商（可选）
  if (process.env.AI_API_KEY) {
    return {
      provider: 'custom',
      apiKey: process.env.AI_API_KEY.trim(),
      baseUrl: trimSlash(process.env.AI_BASE_URL || 'https://api.openai.com/v1'),
      model: process.env.AI_MODEL?.trim() || 'gpt-4o-mini',
    };
  }

  return null;
}
