import type { KoalaNumbers } from '../api/infrastructure'
import { percent, seconds } from '../../monitoring'

export const NOT_MEASURED = 'not measured'

export interface KoalaFigure {
  label: string
  value: string
}

const rate = (value: number, unit: string): string => `${value < 0.1 ? 'under 0.1' : value.toFixed(1)}${unit}`
const whole = (value: number): string => String(Math.round(value))

export function koalaFigures(n: KoalaNumbers): KoalaFigure[] {
  const figure = (label: string, value: number | undefined, show: (value: number) => string): KoalaFigure =>
    ({ label, value: value === undefined ? NOT_MEASURED : show(value) })
  return [
    figure('Requests', n.requestsPerSecond, (value) => rate(value, '/s')),
    figure('Requests failing', n.requestErrorShare, percent),
    figure('Request time (p95)', n.requestSeconds, seconds),
    figure('Model calls', n.modelCallsPerMinute, (value) => rate(value, '/min')),
    figure('Model calls failing', n.modelErrorShare, percent),
    figure('Model time (p95)', n.modelSeconds, seconds),
    figure('Waiting for a model', n.modelQueued, whole),
    figure('Workflows started, last hour', n.workflowsStartedHour, whole),
    figure('Activities failed, last hour', n.activityFailuresHour, whole),
    figure('Work failed, last day', n.workFailuresDay, whole),
  ]
}

export function reportingLine(services: readonly string[]): string {
  if (!services.length) return 'Nothing of Koala reports to its collector.'
  return `${services.length === 1 ? '1 process reports' : `${services.length} processes report`}: ${services.join(', ')}.`
}

export function missingTelemetryLine(telemetry: { collector: boolean; tempo: boolean }): string | undefined {
  if (telemetry.collector && telemetry.tempo) return undefined
  const what = !telemetry.collector && !telemetry.tempo ? 'Its collector and Tempo are' : !telemetry.collector ? 'Its collector is' : 'Tempo is'
  return `${what} not on the system cluster yet; they are installed when the cluster worker starts or an app is deployed.`
}
