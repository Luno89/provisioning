import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import SettingsFields from './SettingsFields'
import { builtInCatalogue } from '@koala/agent-engine/procedure'

const show = (schema: Parameters<typeof SettingsFields>[0]['schema'], value: unknown = {}) => {
  const onChange = vi.fn()
  render(<SettingsFields schema={schema} value={value} disabled={false} onChange={onChange} />)
  return onChange
}

describe('the form a node settles its settings in', () => {
  it('offers a checkbox for a true or false setting, and reports it ticked', async () => {
    const onChange = show({
      type: 'object',
      properties: {
        shared: { type: 'boolean', title: 'The model may also choose this', describe: 'Tick to offer it to the model as well.' },
      },
    } as never)

    const box = screen.getByRole('checkbox', { name: 'The model may also choose this' })
    expect(box).not.toBeChecked()
    expect(screen.getByText('Tick to offer it to the model as well.')).toBeInTheDocument()

    await userEvent.click(box)

    expect(onChange).toHaveBeenCalledWith({ shared: true })
  })

  it('shows a setting that is already on as on', () => {
    show({ type: 'object', properties: { shared: { type: 'boolean', title: 'Shared' } } } as never, { shared: true })

    expect(screen.getByRole('checkbox', { name: 'Shared' })).toBeChecked()
  })

  it('says so plainly when a node has nothing to set', () => {
    show({ type: 'object', properties: {} } as never)

    expect(screen.getByText('This node has nothing to set.')).toBeInTheDocument()
  })
})

describe('what a Call Tool step actually offers in the inspector', () => {
  it('renders the real node’s settings, including whether the model may also choose it', () => {
    const definition = builtInCatalogue().get('call-tool')
    show(definition!.settings as never, { tool: 'mark_done' })

    expect(screen.getByRole('checkbox', { name: 'The model may also choose this' })).toBeInTheDocument()
    expect(screen.getByLabelText('Tool')).toHaveValue('mark_done')
  })
})
