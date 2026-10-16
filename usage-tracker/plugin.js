/**
 * Usage tracker: subscription usage % of every AI account connected to Hermes
 * (Claude, ChatGPT/Codex, Grok, GitHub Copilot), plus Hermes' own token usage.
 *
 * Data comes from ~/.hermes/usage-tracker/collect.py (stdlib Python) through
 * shell.exec. shell.exec returns only the last 4000 chars of stdout, so the
 * collector writes a compact file and the plugin reads it back in chunks.
 */
import {
  Button,
  Codicon,
  cn,
  host,
  PALETTE_AREA,
  ROUTES_AREA,
  SegmentedControl,
  SIDEBAR_NAV_AREA,
  STATUSBAR_AREAS,
  Tip,
  queryClient,
  useQuery
} from '@hermes/plugin-sdk'
import { useState } from 'react'
import { jsx, jsxs } from 'react/jsx-runtime'

const ID = 'usage-tracker'
const PATH = '/usage'
const PY = '/usr/bin/python3'
const SCRIPT = '~/.hermes/usage-tracker/collect.py'
const QUERY_KEY = [ID, 'snapshot']
const POLL_MS = 5 * 60 * 1000

const PROVIDER_NAMES = {
  anthropic: 'Claude',
  'openai-codex': 'ChatGPT',
  'xai-oauth': 'Grok',
  copilot: 'GitHub Copilot'
}
const PROVIDER_COLORS = {
  anthropic: 'var(--ui-orange, var(--ui-accent))',
  'openai-codex': 'var(--ui-green, var(--ui-accent))',
  'xai-oauth': 'var(--ui-accent)',
  copilot: 'var(--ui-yellow, var(--ui-accent))'
}

// ---------------------------------------------------------------- data
async function exec(command) {
  const res = await host.request('shell.exec', { command })
  if (!res || res.code !== 0) throw new Error((res && (res.stderr || res.stdout)) || 'collector failed')
  return res.stdout || ''
}

async function loadSnapshot() {
  const head = await exec(`${PY} ${SCRIPT} --refresh`)
  const { chunks } = JSON.parse(head.trim().split('\n').pop())
  let text = ''
  for (let i = 0; i < chunks; i++) text += await exec(`${PY} ${SCRIPT} --chunk ${i}`)
  return JSON.parse(text)
}

// One line per load in ~/.hermes/usage-tracker/plugin.log so a silent failure can be traced.
async function trace(event, detail = '') {
  try {
    const line = btoa(unescape(encodeURIComponent(JSON.stringify({ at: new Date().toISOString(), event, detail: String(detail).slice(0, 300) }))))
    await host.request('shell.exec', { command: `echo ${line} | base64 -d >> ~/.hermes/usage-tracker/plugin.log; echo >> ~/.hermes/usage-tracker/plugin.log` })
  } catch {}
}

async function loadAndTrace() {
  try {
    const doc = await loadSnapshot()
    trace('ok', `${doc.accounts.length} accounts`)
    return doc
  } catch (err) {
    trace('error', err?.message || err)
    throw err
  }
}

function useSnapshot() {
  return useQuery({
    queryKey: QUERY_KEY,
    queryFn: loadAndTrace,
    refetchInterval: POLL_MS,
    staleTime: 60 * 1000,
    retry: 1
  })
}

// ---------------------------------------------------------------- formatting
function pctColor(p) {
  if (p >= 85) return 'var(--ui-red)'
  if (p >= 60) return 'var(--ui-yellow)'
  return 'var(--ui-accent)'
}

function fmtPct(p) {
  return `${Math.round(p)}%`
}

function fmtReset(iso) {
  if (!iso) return ''
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return ''
  const diff = t - Date.now()
  if (diff <= 0) return 'resetting now'
  const h = Math.floor(diff / 3600000)
  const m = Math.floor((diff % 3600000) / 60000)
  if (h < 24) return `resets in ${h ? `${h}h ` : ''}${m}m`
  const d = new Date(t)
  return `resets ${d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })}, ${d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`
}

function fmtNum(n) {
  if (!n) return '0'
  if (n >= 1e9) return `${(n / 1e9).toFixed(n >= 1e10 ? 0 : 1)}B`
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M`
  if (n >= 1e3) return `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}K`
  return String(n)
}

function fmtAgo(iso) {
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000))
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.round(s / 60)} min ago`
  return `${Math.round(s / 3600)} h ago`
}

function topWindow(acct) {
  const ws = (acct.windows || []).filter(w => w.used_percent != null)
  if (!ws.length) return null
  return ws.reduce((a, b) => (b.used_percent > a.used_percent ? b : a))
}

// ---------------------------------------------------------------- pieces
function Bar({ pct }) {
  return jsx('div', {
    className: 'h-1.5 w-full overflow-hidden rounded-full',
    style: { background: 'color-mix(in srgb, var(--ui-stroke-secondary) 45%, transparent)' },
    children: jsx('div', {
      className: 'h-full rounded-full transition-all',
      style: { width: `${Math.min(100, Math.max(0, pct))}%`, background: pctColor(pct) }
    })
  })
}

function WindowRow({ w }) {
  const pct = w.used_percent ?? 0
  return jsxs('div', {
    className: 'flex flex-col gap-1',
    children: [
      jsxs('div', {
        className: 'flex items-baseline justify-between gap-2 text-xs',
        children: [
          jsx('span', { className: 'text-(--ui-text-secondary)', children: w.label }),
          jsxs('span', {
            className: 'flex items-baseline gap-2',
            children: [
              jsx('span', { className: 'text-(--ui-text-quaternary)', children: fmtReset(w.resets_at) }),
              jsx('span', { className: 'font-semibold tabular-nums', style: { color: pctColor(pct) }, children: fmtPct(pct) })
            ]
          })
        ]
      }),
      jsx(Bar, { pct })
    ]
  })
}

function Sparkline({ points }) {
  if (!points || points.length < 2) return null
  const W = 240
  const H = 32
  const now = Date.now() / 1000
  const t0 = now - 7 * 86400
  const xy = points
    .filter(([t]) => t >= t0)
    .map(([t, v]) => `${(((t - t0) / (now - t0)) * W).toFixed(1)},${(H - (Math.min(100, v) / 100) * (H - 2) - 1).toFixed(1)}`)
  if (xy.length < 2) return null
  return jsxs('div', {
    className: 'flex flex-col gap-0.5',
    children: [
      jsx('span', { className: 'text-[0.6875rem] text-(--ui-text-quaternary)', children: 'Weekly use, last 7 days' }),
      jsx('svg', {
        viewBox: `0 0 ${W} ${H}`,
        preserveAspectRatio: 'none',
        className: 'h-8 w-full',
        children: jsx('polyline', {
          points: xy.join(' '),
          fill: 'none',
          stroke: 'var(--ui-accent)',
          strokeWidth: 1.5,
          vectorEffect: 'non-scaling-stroke'
        })
      })
    ]
  })
}

function AccountCard({ acct, series, hermes7d }) {
  const windows = (acct.windows || []).filter(w => w.used_percent != null)
  const weekly = series?.[acct.id]?.Weekly || series?.[acct.id]?.[windows[0]?.label]
  const local = hermes7d?.[acct.provider]
  return jsxs('div', {
    className: 'flex flex-col gap-3 rounded-md p-4',
    style: { boxShadow: 'inset 0 0 0 1px color-mix(in srgb, var(--ui-stroke-secondary) 60%, transparent)' },
    children: [
      jsxs('div', {
        className: 'flex items-start justify-between gap-2',
        children: [
          jsxs('div', {
            className: 'flex min-w-0 flex-col',
            children: [
              jsx('span', { className: 'text-sm font-semibold', children: acct.service }),
              jsx('span', { className: 'truncate text-xs text-(--ui-text-tertiary)', children: acct.account || 'Unknown account' })
            ]
          }),
          acct.plan &&
            jsx('span', {
              className: 'shrink-0 rounded px-1.5 py-0.5 text-[0.6875rem] font-medium text-(--ui-text-secondary)',
              style: { background: 'color-mix(in srgb, var(--ui-stroke-secondary) 35%, transparent)' },
              children: acct.plan
            })
        ]
      }),
      windows.length
        ? jsx('div', { className: 'flex flex-col gap-2.5', children: windows.map(w => jsx(WindowRow, { w }, w.label)) })
        : null,
      jsx(Sparkline, { points: weekly }),
      acct.note &&
        jsx('div', {
          className: 'text-xs',
          style: { color: acct.status === 'error' ? 'var(--ui-red)' : 'var(--ui-text-tertiary)' },
          children: acct.note
        }),
      jsxs('div', {
        className: 'mt-auto flex flex-col gap-0.5 text-[0.6875rem] text-(--ui-text-quaternary)',
        children: [
          acct.connections?.length ? jsx('span', { children: `Signed in on: ${acct.connections.join(', ')}` }) : null,
          local
            ? jsx('span', { children: `Hermes, last 7 days: ${fmtNum(local.api_calls)} calls, ${fmtNum(local.tokens)} tokens` })
            : null
        ]
      })
    ]
  })
}

const CHART_H = 112

function DailyChart({ daily }) {
  if (!daily?.length) return null
  const days = []
  for (let i = 13; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400000)
    days.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`)
  }
  const providers = [...new Set(daily.map(r => r.provider))].filter(p => p !== 'other')
  const byDay = Object.fromEntries(days.map(d => [d, {}]))
  for (const r of daily) if (byDay[r.day]) byDay[r.day][r.provider] = (byDay[r.day][r.provider] || 0) + r.tokens
  const max = Math.max(1, ...days.map(d => providers.reduce((s, p) => s + (byDay[d][p] || 0), 0)))
  return jsxs('div', {
    className: 'flex flex-col gap-2',
    children: [
      jsx('span', { className: 'text-xs text-(--ui-text-tertiary)', children: 'Tokens per day in Hermes, last 14 days' }),
      jsx('div', {
        className: 'flex items-end gap-1',
        style: { height: `${CHART_H}px` },
        children: days.map(d => {
          const total = providers.reduce((s, p) => s + (byDay[d][p] || 0), 0)
          const title = `${d}: ${providers.map(p => `${PROVIDER_NAMES[p] || p} ${fmtNum(byDay[d][p] || 0)}`).join(', ')}`
          return jsx(
            'div',
            {
              title,
              className: 'flex flex-1 flex-col-reverse overflow-hidden rounded-sm',
              style: { height: `${Math.max(1, Math.round((total / max) * CHART_H))}px`, background: total ? undefined : 'var(--ui-stroke-secondary)' },
              children: providers.map(p =>
                jsx('div', { style: { flex: `${byDay[d][p] || 0} 0 0`, background: PROVIDER_COLORS[p] || 'var(--ui-accent)' } }, p)
              )
            },
            d
          )
        })
      }),
      jsx('div', {
        className: 'flex flex-wrap gap-3 text-[0.6875rem] text-(--ui-text-tertiary)',
        children: providers.map(p =>
          jsxs(
            'span',
            {
              className: 'flex items-center gap-1',
              children: [
                jsx('span', { className: 'inline-block size-2 rounded-sm', style: { background: PROVIDER_COLORS[p] || 'var(--ui-accent)' } }),
                PROVIDER_NAMES[p] || p
              ]
            },
            p
          )
        )
      })
    ]
  })
}

function HermesUsage({ hermes }) {
  const [period, setPeriod] = useState('7d')
  const rows = Object.entries(hermes?.[period] || {}).sort((a, b) => b[1].tokens - a[1].tokens)
  const cell = 'py-1.5 pr-4 text-right tabular-nums'
  return jsxs('div', {
    className: 'flex flex-col gap-3',
    children: [
      jsxs('div', {
        className: 'flex items-center justify-between gap-2',
        children: [
          jsx('span', { className: 'text-sm font-semibold', children: 'Hermes usage' }),
          jsx(SegmentedControl, {
            options: [
              { id: 'today', label: 'Today' },
              { id: '7d', label: '7 days' },
              { id: '30d', label: '30 days' }
            ],
            value: period,
            onChange: setPeriod
          })
        ]
      }),
      rows.length
        ? jsxs('table', {
            className: 'w-full text-xs',
            children: [
              jsx('thead', {
                children: jsxs('tr', {
                  className: 'text-(--ui-text-quaternary)',
                  children: [
                    jsx('th', { className: 'py-1 pr-4 text-left font-normal', children: 'Provider' }),
                    jsx('th', { className: 'py-1 pr-4 text-right font-normal', children: 'Chats' }),
                    jsx('th', { className: 'py-1 pr-4 text-right font-normal', children: 'API calls' }),
                    jsx('th', { className: 'py-1 pr-4 text-right font-normal', children: 'Tokens' }),
                    jsx('th', { className: 'py-1 text-right font-normal', children: 'Same use at API prices' })
                  ]
                })
              }),
              jsx('tbody', {
                children: rows.map(([p, r]) =>
                  jsxs(
                    'tr',
                    {
                      style: { borderTop: '1px solid color-mix(in srgb, var(--ui-stroke-secondary) 40%, transparent)' },
                      children: [
                        jsx('td', { className: 'py-1.5 pr-4', children: PROVIDER_NAMES[p] || p }),
                        jsx('td', { className: cell, children: r.sessions }),
                        jsx('td', { className: cell, children: fmtNum(r.api_calls) }),
                        jsx('td', { className: cell, children: fmtNum(r.tokens) }),
                        jsx('td', { className: 'py-1.5 text-right tabular-nums', children: r.est_cost_usd ? `$${r.est_cost_usd.toLocaleString()}` : 'n/a' })
                      ]
                    },
                    p
                  )
                )
              })
            ]
          })
        : jsx('span', { className: 'text-xs text-(--ui-text-tertiary)', children: 'No Hermes usage in this period' }),
      jsx(DailyChart, { daily: hermes?.daily })
    ]
  })
}

// ---------------------------------------------------------------- page + chip
function UsagePage() {
  const { data, error, isLoading, isFetching, refetch } = useSnapshot()
  return jsx('div', {
    className: 'h-full overflow-auto',
    children: jsxs('div', {
      className: 'flex max-w-5xl flex-col gap-6 p-6',
      children: [
        jsxs('div', {
          className: 'flex items-center justify-between gap-3',
          children: [
            jsxs('div', {
              className: 'flex flex-col',
              children: [
                jsx('span', { className: 'text-base font-semibold', children: 'AI usage' }),
                jsx('span', {
                  className: 'text-xs text-(--ui-text-tertiary)',
                  children: data
                    ? `Subscription use per account, counted across every app on that login. Updated ${fmtAgo(data.fetched_at)}.`
                    : 'Subscription use per account'
                })
              ]
            }),
            jsxs(Button, {
              variant: 'outline',
              size: 'sm',
              disabled: isFetching,
              onClick: () => refetch(),
              children: [jsx(Codicon, { name: 'refresh' }), isFetching ? 'Refreshing' : 'Refresh']
            })
          ]
        }),
        error && !data
          ? jsx('div', { className: 'text-xs', style: { color: 'var(--ui-red)' }, children: String(error.message || error) })
          : null,
        isLoading && !data ? jsx('div', { className: 'text-xs text-(--ui-text-tertiary)', children: 'Checking accounts…' }) : null,
        data
          ? jsx('div', {
              className: 'grid gap-3',
              style: { gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))' },
              children: data.accounts.map(a => jsx(AccountCard, { acct: a, series: data.series, hermes7d: data.hermes?.['7d'] }, a.id))
            })
          : null,
        data ? jsx(HermesUsage, { hermes: data.hermes }) : null
      ]
    })
  })
}

function UsageChip() {
  const { data, error } = useSnapshot()
  const items = (data?.accounts || [])
    .map(a => ({ a, w: topWindow(a) }))
    .filter(x => x.w && x.w.used_percent >= 1)
  const label = error && !data ? 'Usage ?' : items.length ? items.map(({ a, w }) => `${a.service.split(' ')[0]} ${fmtPct(w.used_percent)}`).join(' · ') : 'Usage'
  const worst = items.reduce((m, x) => Math.max(m, x.w.used_percent), 0)
  const tip = (data?.accounts || [])
    .map(a => {
      const w = topWindow(a)
      return w ? `${a.service}: ${fmtPct(w.used_percent)} ${w.label.toLowerCase()}` : `${a.service}: no % available`
    })
    .join('\n')
  return jsx(Tip, {
    label: tip || 'AI usage',
    children: jsxs('button', {
      type: 'button',
      className: cn(
        'inline-flex h-full items-center gap-1 px-1.5 text-[0.6875rem] tabular-nums transition-colors',
        'text-(--ui-text-tertiary) hover:bg-(--chrome-action-hover) hover:text-foreground'
      ),
      style: worst >= 85 ? { color: 'var(--ui-red)' } : worst >= 60 ? { color: 'var(--ui-yellow)' } : undefined,
      onClick: () => host.navigate(PATH),
      children: [jsx(Codicon, { name: 'graph' }), label]
    })
  })
}

export default {
  id: ID,
  name: 'Usage Tracker',
  register(ctx) {
    // Warm the cache at load so the status bar chip and page open with data.
    queryClient.prefetchQuery({ queryKey: QUERY_KEY, queryFn: loadAndTrace, staleTime: 60 * 1000 }).catch(() => {})
    ctx.register({ id: 'page', area: ROUTES_AREA, data: { path: PATH }, render: () => jsx(UsagePage, {}) })
    ctx.register({ id: 'nav', area: SIDEBAR_NAV_AREA, data: { path: PATH, label: 'Usage', codicon: 'graph' } })
    ctx.register({ id: 'chip', area: STATUSBAR_AREAS.right, order: 90, render: () => jsx(UsageChip, {}) })
    ctx.register({
      id: 'open',
      area: PALETTE_AREA,
      data: { id: 'usage-tracker.open', label: 'Open AI usage tracker', run: () => host.navigate(PATH) }
    })
  }
}
