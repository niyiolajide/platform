import Anthropic from '@anthropic-ai/sdk';
import type { ProviderAdapter } from './types';
export declare function isAnthropicConfigured(): boolean;
export declare function getAnthropic(): Anthropic;
/** Test helper — reset the memoized client (e.g. after changing the env key). */
export declare function _resetAnthropic(): void;
export declare const anthropicAdapter: ProviderAdapter;
