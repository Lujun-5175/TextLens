import type { JSX } from 'react'
import { X } from 'lucide-react'

import { PROVIDER_PRESETS, type ProviderPreset } from '../../shared/providers'
import { Dialog } from '../components/Dialog'

interface ProviderPresetDialogProps {
  onSelect: (preset: ProviderPreset) => void
  onCancel: () => void
}

/**
 * Preset picker shown before creating a provider.
 *
 * Filling protocol and base URL by hand is the step where first-time users
 * stall, so the dialog turns it into one choice; only the API key is left.
 */
export function ProviderPresetDialog({ onSelect, onCancel }: ProviderPresetDialogProps): JSX.Element {
  return (
    <Dialog className="provider-preset-dialog" labelledBy="provider-preset-title" onClose={onCancel}>
      <header className="dialog-header">
        <div>
          <h2 id="provider-preset-title">添加服务商</h2>
          <p>选一个服务商，协议和 API 地址会自动填好，你只需要粘贴 Key。</p>
        </div>
        <button className="icon-button" type="button" aria-label="关闭" onClick={onCancel}>
          <X size={18} aria-hidden="true" />
        </button>
      </header>
      <div className="provider-preset-list">
        {PROVIDER_PRESETS.map((preset) => (
          <button
            key={preset.id}
            className="provider-preset"
            type="button"
            onClick={() => onSelect(preset)}
          >
            <span className="provider-preset__name">{preset.name}</span>
            <span className="provider-preset__hint">{preset.hint}</span>
            <span className="provider-preset__url">{preset.baseUrl}</span>
          </button>
        ))}
      </div>
      <footer className="dialog-actions provider-preset-dialog__actions">
        <button className="button" type="button" data-dialog-initial-focus onClick={onCancel}>
          取消
        </button>
      </footer>
    </Dialog>
  )
}
