/**
 * The provider data layers the recorder polls.
 *
 * Only subscription providers: their quota checks are reads. The API-key
 * providers (Mistral, OpenRouter) check health with a real completion request,
 * which is fine on a click but not every few minutes.
 */

import type { TFunction } from 'i18next';
import { ANTIGRAVITY_CONFIG } from '@/features/quota/providers/antigravity/data';
import { CLAUDE_CONFIG } from '@/features/quota/providers/claude/data';
import { CODEX_CONFIG } from '@/features/quota/providers/codex/data';
import { DEVIN_CONFIG } from '@/features/quota/providers/devin/data';
import { KIMI_CONFIG } from '@/features/quota/providers/kimi/data';
import { META_CONFIG } from '@/features/quota/providers/meta/data';
import { PLUGIN_CONFIG } from '@/features/quota/providers/plugin/data';
import { XAI_CONFIG } from '@/features/quota/providers/xai/data';
import type { QuotaProviderType } from '@/features/quota/providers/types';
import type { AuthFileItem } from '@/types';

interface RecorderConfig {
  fetchQuota: (file: AuthFileItem, t: TFunction) => Promise<unknown>;
  buildSuccessState: (data: unknown) => unknown;
}

export const RECORDER_CONFIGS = {
  antigravity: ANTIGRAVITY_CONFIG,
  claude: CLAUDE_CONFIG,
  codex: CODEX_CONFIG,
  devin: DEVIN_CONFIG,
  kimi: KIMI_CONFIG,
  meta: META_CONFIG,
  plugin: PLUGIN_CONFIG,
  xai: XAI_CONFIG,
} as unknown as Record<QuotaProviderType, RecorderConfig>;
