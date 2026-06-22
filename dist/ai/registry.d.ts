import type { ProviderKind } from '../control/schema';
import type { ProviderAdapter } from './types';
export declare const ADAPTERS: Record<ProviderKind, ProviderAdapter>;
export declare function getAdapter(kind: ProviderKind): ProviderAdapter;
