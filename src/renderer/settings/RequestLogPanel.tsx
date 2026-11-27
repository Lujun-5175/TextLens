import { useCallback, useEffect, useState, type JSX } from 'react'
import { RefreshCw, Trash2 } from 'lucide-react'

import type { RequestLogEntry } from '../../shared/schemas'
import { Dialog } from '../components/Dialog'
import { getErrorMessage } from '../lib/errors'

const STATUS_LABELS: Record<RequestLogEntry['status'], string> = {
  completed: '成功',
  failed: '失败',
  cancelled: '已取消'
}

/** Stored timestamps are UTC; show the local clock, like the result history. */
function localTimestamp(value: string): string {
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return value
  const pad = (part: number): string => String(part).padStart(2, '0')
  // The year is not decoration: an audit log that outlives New Year would show
  // "12-31 23:50" above "01-01 00:10" and read as if time ran backwards.
  return `${parsed.getFullYear()}-${pad(parsed.getMonth() + 1)}-${pad(parsed.getDate())} ${
    pad(parsed.getHours())}:${pad(parsed.getMinutes())}`
}

function formatCount(value: number): string {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/gu, ',')
}

/**
 * Audit trail for the provider calls this app makes with the user's own key.
 * Metadata only: no prompt text and no answer text ever appear here.
 */
export function RequestLogPanel(): JSX.Element {
  const [entries, setEntries] = useState<RequestLogEntry[]>([])
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [error, setError] = useState('')
  const [clearOpen, setClearOpen] = useState(false)
  const [clearing, setClearing] = useState(false)
  const [statusFilter, setStatusFilter] = useState('')
  const [actionFilter, setActionFilter] = useState('')

  const load = useCallback(async (): Promise<void> => {
    if (!window.textLens.listRequestLog) {
      setStatus('error')
      setError('当前版本不支持请求日志')
      return
    }
    setStatus('loading')
    setError('')
    try {
      // The backend keeps a 500-entry ring. Asking for all of it means the
      // "共 N 条" count is the real total rather than an arbitrary page, which
      // matters in an audit log: a filter that silently ignores older entries
      // is worse than a longer table.
      setEntries(await window.textLens.listRequestLog(500))
      setStatus('ready')
    } catch (loadError) {
      setStatus('error')
      setError(getErrorMessage(loadError, '无法读取请求日志'))
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  // A busy log is useless without a way to narrow it: "find yesterday's
  // failure" used to mean scrolling sixty rows. Filters stay client-side — the
  // whole ring is already in memory.
  const actionNames = Array.from(new Set(entries.map((entry) => entry.actionName).filter(Boolean)))
  const filtered = entries.filter(
    (entry) =>
      (statusFilter === '' || entry.status === statusFilter) &&
      (actionFilter === '' || entry.actionName === actionFilter)
  )

  const clear = useCallback(async (): Promise<void> => {
    if (!window.textLens.clearRequestLog) return
    setClearing(true)
    try {
      await window.textLens.clearRequestLog()
      setEntries([])
      setClearOpen(false)
    } catch (clearError) {
      setError(getErrorMessage(clearError, '无法清空请求日志'))
    } finally {
      setClearing(false)
    }
  }, [])

  return (
    <>
      <div className="settings-tip" role="note">
        <span className="settings-tip__label">只记元数据</span>
        <p className="request-log-note">
          记录每次请求的时间、动作、模型、字数和 token，不保存选中文字或回答正文。日志只存在本机。
        </p>
      </div>
      <div className="history-toolbar request-log-toolbar">
        <button className="button" type="button" disabled={status === 'loading'} onClick={() => void load()}>
          <RefreshCw size={15} className={status === 'loading' ? 'settings-spin' : undefined} />
          刷新
        </button>
        <button
          className="button button--danger"
          type="button"
          disabled={entries.length === 0 || clearing}
          onClick={() => setClearOpen(true)}
        >
          <Trash2 size={15} />
          清空全部
        </button>
      </div>

      {entries.length > 0 && (
        <div className="request-log-filters">
          <select
            className="control compact-control"
            aria-label="按状态筛选"
            value={statusFilter}
            onChange={(event) => setStatusFilter(event.target.value)}
          >
            <option value="">全部状态</option>
            <option value="completed">成功</option>
            <option value="failed">失败</option>
            <option value="cancelled">已取消</option>
          </select>
          <select
            className="control compact-control"
            aria-label="按动作筛选"
            value={actionFilter}
            onChange={(event) => setActionFilter(event.target.value)}
          >
            <option value="">全部动作</option>
            {actionNames.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
          {/* The count is the only feedback that a filter did anything, so it
              has to reach a screen reader too. */}
          <span className="request-log-count" role="status">
            {filtered.length === entries.length
              ? `共 ${entries.length} 条`
              : `${filtered.length} / ${entries.length} 条`}
          </span>
          {(statusFilter !== '' || actionFilter !== '') && (
            <button
              className="button button--quiet"
              type="button"
              onClick={() => {
                setStatusFilter('')
                setActionFilter('')
              }}
            >
              清除筛选
            </button>
          )}
        </div>
      )}

      {error && (
        <div className="notice notice--error" role="alert">
          <span>{error}</span>
        </div>
      )}

      {status === 'ready' && entries.length === 0 && (
        <div className="empty-state">
          <p className="empty-state__title">还没有请求记录</p>
          <p className="empty-state__hint">完成一次 AI 动作后会出现在这里。</p>
        </div>
      )}

      {entries.length > 0 && filtered.length === 0 && (
        <div className="empty-state">
          <p className="empty-state__title">没有符合条件的记录</p>
          <p className="empty-state__hint">换个状态或动作再试，或点「清除筛选」。</p>
        </div>
      )}

      {filtered.length > 0 && (
        // The scroll container keeps a long model id from widening the whole
        // settings page: a bare table contributes its content's min-content
        // width to the page grid, and one long identifier was enough to push
        // every other section out of the window.
        <div className="request-log-scroll">
          {/* A real table, not a stack of per-row grids: browsers share the
              column tracks, so numbers stay aligned no matter how long a model
              id or a token count is in one particular row. */}
          <table className="request-log-table">
          <thead>
            <tr>
              <th scope="col">时间</th>
              <th scope="col">动作</th>
              <th scope="col">模型</th>
              <th scope="col" className="request-log-table__num">字数</th>
              <th scope="col" className="request-log-table__num">Tokens</th>
              <th scope="col">状态</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((entry, index) => (
              <tr className="request-log-row" key={`${entry.createdAt}-${index}`}>
                <td className="request-log-row__time">{localTimestamp(entry.createdAt)}</td>
                <td className="request-log-row__action">{entry.actionName || '—'}</td>
                <td
                  className="request-log-row__model"
                  title={entry.endpointHost || undefined}
                >
                  {entry.modelId || '—'}
                </td>
                <td className="request-log-row__numbers">
                  {formatCount(entry.characterCount)}
                </td>
                <td className="request-log-row__numbers">
                  {entry.totalTokens === undefined ? '—' : formatCount(entry.totalTokens)}
                </td>
                <td
                  className={`request-log-row__status ${entry.status === 'failed' ? 'request-log-row__status--failed' : ''}`}
                  title={entry.errorCode ?? undefined}
                >
                  {STATUS_LABELS[entry.status]}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      )}

      {clearOpen && (
        <Dialog className="provider-delete-dialog" label="清空请求日志？" onClose={() => setClearOpen(false)}>
          <header className="dialog-header">
            <div>
              <h2>清空请求日志？</h2>
              <p>只删除本机的请求记录；已保存的结果历史不受影响。</p>
            </div>
          </header>
          <footer className="dialog-actions provider-delete-dialog__actions">
            <button className="button" type="button" data-dialog-initial-focus onClick={() => setClearOpen(false)}>
              取消
            </button>
            <button className="button button--danger" type="button" disabled={clearing} onClick={() => void clear()}>
              清空
            </button>
          </footer>
        </Dialog>
      )}
    </>
  )
}
