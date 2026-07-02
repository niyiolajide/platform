import type { AiSettings, CascadeStep } from '../control/schema'
import { getAdapter } from './registry'

function normalized(value: string | null | undefined): string {
  return (value ?? '').trim().toLowerCase()
}

function routeForApp(settings: AiSettings, app: string): AiSettings['dataPolicy']['domainRouting'][number] | null {
  const appKey = normalized(app)
  if (appKey === '') {return null}
  return settings.dataPolicy.domainRouting.find((route) => route.apps.some((candidate) => normalized(candidate) === appKey)) ?? null
}

export function applyDataPolicy(settings: AiSettings, steps: CascadeStep[], app: string): CascadeStep[] {
  const route = routeForApp(settings, app)
  if (route?.mode === 'local-only') {return steps.filter((step) => getAdapter(step.provider).local === true)}
  const allowedExternal = new Set(settings.dataPolicy.externalProviders)
  return steps.filter((step) => getAdapter(step.provider).local === true || allowedExternal.has(step.provider))
}
