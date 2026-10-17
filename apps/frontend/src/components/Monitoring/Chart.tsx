import { useEffect, useRef } from 'react'
import type uPlot from 'uplot'
import 'uplot/dist/uPlot.min.css'
import type { Marker } from '../../api/monitoring'
import { formatValue, type ChartUnit } from './shared'

const HEIGHT = 150
const NO_MARKERS: Marker[] = []

function markerPlugin(markers: Marker[]): uPlot.Plugin {
  return {
    hooks: {
      draw: (u) => {
        const ctx = u.ctx
        ctx.save()
        ctx.strokeStyle = 'rgba(148, 163, 184, 0.6)'
        ctx.setLineDash([4, 4])
        ctx.lineWidth = 1
        for (const marker of markers) {
          const x = u.valToPos(Date.parse(marker.at) / 1000, 'x', true)
          if (x < u.bbox.left || x > u.bbox.left + u.bbox.width) continue
          ctx.beginPath()
          ctx.moveTo(x, u.bbox.top)
          ctx.lineTo(x, u.bbox.top + u.bbox.height)
          ctx.stroke()
        }
        ctx.restore()
      },
    },
  }
}

export function Chart({ title, unit, points, markers = NO_MARKERS }: { title: string; unit: ChartUnit; points: Array<[number, number]>; markers?: Marker[] }) {
  const box = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const element = box.current
    if (!element) return
    let plot: uPlot | undefined
    let resize: ResizeObserver | undefined
    let gone = false
    void import('uplot').then(({ default: UPlot }) => {
      if (gone) return
      const data: uPlot.AlignedData = [points.map(([at]) => at), points.map(([, value]) => value)]
      plot = new UPlot({
        width: Math.max(200, element.clientWidth),
        height: HEIGHT,
        legend: { show: false },
        cursor: { drag: { x: false, y: false } },
        scales: { y: unit === 'share' || unit === 'up' ? { range: [0, unit === 'up' ? 1.05 : Math.max(1, ...points.map(([, value]) => value))] } : {} },
        axes: [
          { stroke: '#94a3b8', grid: { stroke: 'rgba(148,163,184,0.08)' }, ticks: { stroke: 'rgba(148,163,184,0.2)' } },
          { stroke: '#94a3b8', grid: { stroke: 'rgba(148,163,184,0.08)' }, ticks: { stroke: 'rgba(148,163,184,0.2)' }, size: 56, values: (_u, splits) => splits.map((value) => formatValue(unit, value)) },
        ],
        series: [
          {},
          { label: title, stroke: '#7dd3a8', width: 1.5, fill: 'rgba(125, 211, 168, 0.08)', value: (_u, value) => (value === null ? '—' : formatValue(unit, value)) },
        ],
        plugins: [markerPlugin(markers)],
      }, data, element)
      resize = new ResizeObserver(() => plot?.setSize({ width: Math.max(200, element.clientWidth), height: HEIGHT }))
      resize.observe(element)
    })
    return () => { gone = true; resize?.disconnect(); plot?.destroy() }
  }, [points, markers, unit, title])

  const latest = points.at(-1)?.[1]
  return (
    <figure className="rounded-md border border-[var(--bark-700)] bg-[var(--bark-900)]/40 p-3" data-testid="monitoring-chart">
      <figcaption className="mb-1 flex items-baseline justify-between text-[12px]">
        <span className="font-semibold text-slate-200">{title}</span>
        {latest !== undefined && <span className="text-slate-400">now {formatValue(unit, latest)}</span>}
      </figcaption>
      <div ref={box} className="w-full" role="img" aria-label={`${title} over time`} />
    </figure>
  )
}

export default Chart
