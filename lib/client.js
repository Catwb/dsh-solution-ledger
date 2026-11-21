/**
 * Solution ledger settings page.
 *
 * The store lives in a Host-side JSON file, so this page is a thin client over
 * the three routes the Host half registers: list, update, delete. Everything it
 * renders comes from those responses, and every control writes back through
 * them, which keeps one source of truth on disk.
 */
window.__ModuleLoader__.load({
  id: 'dsh-solution-ledger',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'solutionLedger'
    /** Sidebar panel id; also the `main` panel key it pairs with. */
    const PANEL_ID = 'solution-ledger'
    const LIST_URL = '/solution-ledger/list'
    const UPDATE_URL = '/solution-ledger/update'
    const DELETE_URL = '/solution-ledger/delete'

    const KINDS = ['troubleshoot', 'decision']
    const DOMAINS = ['environment', 'tooling', 'code', 'config', 'process', 'other']
    const STATUSES = ['draft', 'confirmed', 'deprecated']

    const zh = {
      nav: '问题账本',
      close: '关闭',
      intro: '跨会话积累的问题与取舍。确认过的条目才会在工具报错时自动带出。',
      search: '搜索标题、解法或标签',
      all: '全部',
      kind: '类型',
      status: '状态',
      total: '总条数',
      draftCount: '待确认',
      confirmedCount: '已确认',
      archivedCount: '已归档',
      empty: '账本还是空的。遇到问题并解决后，让我用 solution_log 记一条。',
      noMatch: '没有匹配的条目。',
      loading: '读取中…',
      loadFailed: '读取失败',
      saveFailed: '保存失败',
      confirm: '确认',
      unconfirm: '退回草稿',
      deprecate: '弃用',
      restore: '恢复',
      archive: '归档',
      unarchive: '取消归档',
      remove: '删除',
      removeAsk: '确定删除这条记录？删除后无法恢复。',
      expand: '展开',
      collapse: '收起',
      fields: {
        title: '标题',
        problem: '问题 / 症状',
        resolution: '解法 / 选择',
        rejected: '否决的方案',
        verify: '怎么验证',
        tags: '标签（逗号分隔）',
      },
      kindLabel: { troubleshoot: '踩坑', decision: '取舍' },
      statusLabel: { draft: '草稿', confirmed: '已确认', deprecated: '已弃用' },
      domainLabel: {
        environment: '环境',
        tooling: '工具',
        code: '代码',
        config: '配置',
        process: '流程',
        other: '其他',
      },
      hits: '命中',
      store: '存储位置',
    }

    const en = {
      nav: 'Solution ledger',
      close: 'Close',
      intro: 'Problems and decisions accumulated across sessions. Only confirmed entries are surfaced automatically when a tool fails.',
      search: 'Search titles, resolutions, or tags',
      all: 'All',
      kind: 'Kind',
      status: 'Status',
      total: 'Total',
      draftCount: 'Awaiting',
      confirmedCount: 'Confirmed',
      archivedCount: 'Archived',
      empty: 'The ledger is empty. After solving a problem, ask me to record it with solution_log.',
      noMatch: 'No matching entries.',
      loading: 'Loading…',
      loadFailed: 'Load failed',
      saveFailed: 'Save failed',
      confirm: 'Confirm',
      unconfirm: 'Back to draft',
      deprecate: 'Deprecate',
      restore: 'Restore',
      archive: 'Archive',
      unarchive: 'Unarchive',
      remove: 'Delete',
      removeAsk: 'Delete this entry? This cannot be undone.',
      expand: 'Expand',
      collapse: 'Collapse',
      fields: {
        title: 'Title',
        problem: 'Problem',
        resolution: 'Resolution',
        rejected: 'Rejected approach',
        verify: 'How to verify',
        tags: 'Tags (comma separated)',
      },
      kindLabel: { troubleshoot: 'Troubleshoot', decision: 'Decision' },
      statusLabel: { draft: 'Draft', confirmed: 'Confirmed', deprecated: 'Deprecated' },
      domainLabel: {
        environment: 'Environment',
        tooling: 'Tooling',
        code: 'Code',
        config: 'Config',
        process: 'Process',
        other: 'Other',
      },
      hits: 'Hits',
      store: 'Store',
    }

    const CSS = [
      // A `main` panel owns its own scroll box: the frame gives it a bounded
      // height and does not scroll it. The two clearance variables keep the
      // first row out from under the frame's floating top/leading controls.
      '.dsl-page{display:flex;flex-direction:column;gap:12px;box-sizing:border-box;height:100%;min-height:0;overflow-y:auto;overscroll-behavior:contain;padding:calc(24px + var(--dsh-frame-top-clearance,0px)) 28px 24px max(28px,var(--dsh-frame-leading-clearance,0px))}',
      '.dsl-intro{color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px;margin:0}',
      '.dsl-bar{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
      '.dsl-input{box-sizing:border-box;flex:1;min-width:180px;height:32px;padding:0 10px;border-radius:var(--dsw-radius-md);border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-family:inherit;font-size:13px}',
      '.dsl-input:focus{outline:none;border-color:var(--dsw-alias-brand-primary)}',
      '.dsl-select{box-sizing:border-box;height:32px;padding:0 8px;border-radius:var(--dsw-radius-md);border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-family:inherit;font-size:13px;cursor:pointer}',
      '.dsl-stats{display:flex;align-items:center;gap:10px;flex-wrap:wrap;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}',
      '.dsl-dot{width:4px;height:4px;border-radius:50%;background:var(--dsw-alias-label-secondary);opacity:.5}',
      '.dsl-list{display:flex;flex-direction:column;gap:8px}',
      '.dsl-item{background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-md);box-sizing:border-box;overflow:hidden}',
      '.dsl-itemArchived{opacity:.62}',
      '.dsl-itemHead{display:flex;align-items:flex-start;gap:10px;padding:12px 14px;cursor:pointer}',
      '.dsl-itemHead:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.dsl-itemMain{flex:1;min-width:0}',
      '.dsl-title{color:var(--dsw-alias-label-primary);font-size:13px;font-weight:500;line-height:20px;word-break:break-word}',
      '.dsl-meta{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-top:5px}',
      '.dsl-badge{box-sizing:border-box;display:inline-flex;align-items:center;height:19px;padding:0 6px;border-radius:4px;font-size:11px;line-height:1;border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);white-space:nowrap}',
      '.dsl-badgeDraft{border-color:var(--dsw-alias-state-warning-primary,#c08a1e);color:var(--dsw-alias-state-warning-primary,#c08a1e)}',
      '.dsl-badgeConfirmed{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}',
      '.dsl-badgeDeprecated{opacity:.7}',
      '.dsl-tags{color:var(--dsw-alias-label-secondary);font-size:11px;line-height:18px}',
      '.dsl-chevron{flex:none;color:var(--dsw-alias-label-secondary);font-size:11px;padding-top:2px;user-select:none}',
      '.dsl-body{display:flex;flex-direction:column;gap:10px;padding:0 14px 14px;border-top:1px solid var(--dsw-alias-border-l1)}',
      '.dsl-field{display:flex;flex-direction:column;gap:4px;margin-top:10px}',
      '.dsl-label{color:var(--dsw-alias-label-secondary);font-size:11px;line-height:16px}',
      '.dsl-textarea{box-sizing:border-box;width:100%;min-height:56px;padding:7px 9px;border-radius:var(--dsw-radius-md);border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-family:inherit;font-size:12px;line-height:18px;resize:vertical}',
      '.dsl-textarea:focus{outline:none;border-color:var(--dsw-alias-brand-primary)}',
      '.dsl-actions{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-top:12px}',
      '.dsl-btn{box-sizing:border-box;display:inline-flex;align-items:center;height:28px;padding:0 10px;border-radius:var(--dsw-radius-md);border:1px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-primary);font-family:inherit;font-size:12px;line-height:18px;cursor:pointer}',
      '.dsl-btn:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.dsl-btn:disabled{opacity:.45;cursor:default}',
      '.dsl-btnPrimary{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}',
      '.dsl-btnDanger{border-color:var(--dsw-alias-state-error-primary,#c0392b);color:var(--dsw-alias-state-error-primary,#c0392b)}',
      '.dsl-empty{color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px;padding:18px 0}',
      '.dsl-foot{display:flex;align-items:center;gap:6px;color:var(--dsw-alias-label-secondary);font-size:11px;line-height:18px;word-break:break-all}',
      '.dsl-footErr{color:var(--dsw-alias-state-error-primary,#c0392b)}',
      '.dsl-panelIcon{display:block}',
    ].join('\n')

    /**
     * The sidebar entry. `sidebar.panellist` pairs each list id with the `main`
     * panel of the same id, so this component only draws the glyph: the owner
     * supplies the button, its tooltip, and the selected state.
     * @param props - `{ size, active }` from the panel row.
     * @returns the icon element.
     */
    function PanelIcon(props) {
      const size = typeof props.size === 'number' && props.size > 0 ? props.size : 20
      return h(
        'svg',
        {
          className: 'dsl-panelIcon',
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          'aria-hidden': true,
          style: { opacity: props.active ? 1 : 0.82 },
        },
        h('rect', {
          x: 3.5,
          y: 3.5,
          width: 17,
          height: 17,
          rx: 4,
          stroke: 'currentColor',
          strokeWidth: 1.6,
        }),
        h('path', {
          d: 'M7.5 9h9M7.5 12.5h6.5M7.5 16h8',
          stroke: 'currentColor',
          strokeWidth: 1.6,
          strokeLinecap: 'round',
        }),
      )
    }

    /**
     * Read a JSON answer without assuming the body is JSON.
     * @param response - the fetch response.
     * @returns the parsed payload, or an explicit error object.
     */
    async function readAnswer(response) {
      const text = await response.text()
      if (text.trim().length === 0) {
        return {
          ok: false,
          error:
            response.status === 404
              ? 'route not found — the plugin host half is not loaded'
              : `empty response (HTTP ${response.status})`,
        }
      }
      try {
        return JSON.parse(text)
      } catch {
        return { ok: false, error: `not JSON (HTTP ${response.status})` }
      }
    }

    /**
     * One editable text field that saves on blur when it actually changed.
     */
    function Field(props) {
      const [draft, setDraft] = React.useState(props.value)
      React.useEffect(() => setDraft(props.value), [props.value])
      return h(
        'label',
        { className: 'dsl-field' },
        h('span', { className: 'dsl-label' }, props.label),
        h('textarea', {
          className: 'dsl-textarea',
          value: draft,
          rows: props.rows ?? 2,
          disabled: props.disabled === true,
          onChange: (event) => setDraft(event.target.value),
          onBlur: () => {
            if (draft !== props.value) props.onCommit(draft)
          },
        }),
      )
    }

    /**
     * The ledger page.
     * @param props - slot props carrying the bound translator.
     * @returns the page tree.
     */
    function LedgerPage(props) {
      const t = props.t
      const [snapshot, setSnapshot] = React.useState({
        phase: 'loading',
        entries: [],
        stats: null,
        storePath: '',
        error: null,
      })
      const [query, setQuery] = React.useState('')
      const [kindFilter, setKindFilter] = React.useState('all')
      const [statusFilter, setStatusFilter] = React.useState('all')
      const [openId, setOpenId] = React.useState(null)
      const [notice, setNotice] = React.useState(null)

      const load = React.useCallback(async () => {
        try {
          const response = await fetch(LIST_URL, { headers: { Accept: 'application/json' } })
          const answer = await readAnswer(response)
          if (answer.ok !== true) throw new Error(answer.error ?? 'unavailable')
          setSnapshot({
            phase: 'ready',
            entries: Array.isArray(answer.entries) ? answer.entries : [],
            stats: answer.stats ?? null,
            storePath: typeof answer.storePath === 'string' ? answer.storePath : '',
            error: null,
          })
        } catch (error) {
          setSnapshot((current) => ({ ...current, phase: 'failed', error: String(error) }))
        }
      }, [])

      React.useEffect(() => {
        void load()
      }, [load])

      /**
       * Send one patch and fold the answer back into the list.
       * @param id - target entry id.
       * @param patch - changed fields.
       */
      const update = async (id, patch) => {
        setNotice(null)
        try {
          const response = await fetch(UPDATE_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id, patch }),
          })
          const answer = await readAnswer(response)
          if (answer.ok !== true) throw new Error(answer.error ?? 'rejected')
          setSnapshot((current) => ({
            ...current,
            entries: current.entries.map((entry) => (entry.id === id ? answer.entry : entry)),
          }))
          void load()
        } catch (error) {
          setNotice({ text: `${t('saveFailed')}: ${String(error)}`, failed: true })
        }
      }

      /**
       * Delete one entry after the browser confirms.
       * @param id - target entry id.
       */
      const remove = async (id) => {
        if (typeof window !== 'undefined' && !window.confirm(t('removeAsk'))) return
        setNotice(null)
        try {
          const response = await fetch(DELETE_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ids: [id] }),
          })
          const answer = await readAnswer(response)
          if (answer.ok !== true) throw new Error(answer.error ?? 'rejected')
          setSnapshot((current) => ({ ...current, entries: current.entries.filter((entry) => entry.id !== id) }))
          if (openId === id) setOpenId(null)
          void load()
        } catch (error) {
          setNotice({ text: `${t('saveFailed')}: ${String(error)}`, failed: true })
        }
      }

      const needle = query.trim().toLowerCase()
      const visible = snapshot.entries.filter((entry) => {
        if (kindFilter !== 'all' && entry.kind !== kindFilter) return false
        if (statusFilter !== 'all' && entry.status !== statusFilter) return false
        if (needle.length === 0) return true
        const haystack = [entry.title, entry.problem, entry.resolution, entry.rejected, entry.tags.join(' ')]
          .join(' ')
          .toLowerCase()
        return haystack.includes(needle)
      })

      const stats = snapshot.stats
      const summary = []
      if (stats !== null) {
        summary.push(`${t('total')} ${stats.total}`)
        if (stats.draft > 0) summary.push(`${t('draftCount')} ${stats.draft}`)
        if (stats.confirmed > 0) summary.push(`${t('confirmedCount')} ${stats.confirmed}`)
        if (stats.archived > 0) summary.push(`${t('archivedCount')} ${stats.archived}`)
      }

      const rows = visible.map((entry) => {
        const open = openId === entry.id
        const statusClass =
          entry.status === 'confirmed'
            ? ' dsl-badgeConfirmed'
            : entry.status === 'draft'
              ? ' dsl-badgeDraft'
              : ' dsl-badgeDeprecated'
        const badges = [
          h('span', { key: 'kind', className: 'dsl-badge' }, t(`kindLabel.${entry.kind}`)),
          h('span', { key: 'domain', className: 'dsl-badge' }, t(`domainLabel.${entry.domain}`)),
          h('span', { key: 'status', className: `dsl-badge${statusClass}` }, t(`statusLabel.${entry.status}`)),
        ]
        if (entry.archived) badges.push(h('span', { key: 'arch', className: 'dsl-badge' }, t('archive')))
        if (entry.hits > 0) badges.push(h('span', { key: 'hits', className: 'dsl-badge' }, `${t('hits')} ${entry.hits}`))

        return h(
          'div',
          { key: entry.id, className: 'dsl-item' + (entry.archived ? ' dsl-itemArchived' : '') },
          h(
            'div',
            {
              className: 'dsl-itemHead',
              role: 'button',
              tabIndex: 0,
              'aria-expanded': open,
              onClick: () => setOpenId(open ? null : entry.id),
              onKeyDown: (event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  setOpenId(open ? null : entry.id)
                }
              },
            },
            h(
              'div',
              { className: 'dsl-itemMain' },
              h('div', { className: 'dsl-title' }, entry.title),
              h('div', { className: 'dsl-meta' }, badges),
              entry.tags.length > 0 ? h('div', { className: 'dsl-tags' }, entry.tags.join(' · ')) : null,
            ),
            h('span', { className: 'dsl-chevron' }, open ? '▾' : '▸'),
          ),
          open
            ? h(
                'div',
                { className: 'dsl-body' },
                h(Field, {
                  label: t('fields.title'),
                  value: entry.title,
                  rows: 1,
                  onCommit: (value) => update(entry.id, { title: value }),
                }),
                h(Field, {
                  label: t('fields.problem'),
                  value: entry.problem,
                  onCommit: (value) => update(entry.id, { problem: value }),
                }),
                h(Field, {
                  label: t('fields.resolution'),
                  value: entry.resolution,
                  rows: 4,
                  onCommit: (value) => update(entry.id, { resolution: value }),
                }),
                entry.kind === 'decision' || entry.rejected.length > 0
                  ? h(Field, {
                      label: t('fields.rejected'),
                      value: entry.rejected,
                      onCommit: (value) => update(entry.id, { rejected: value }),
                    })
                  : null,
                h(Field, {
                  label: t('fields.verify'),
                  value: entry.verify,
                  onCommit: (value) => update(entry.id, { verify: value }),
                }),
                h(Field, {
                  label: t('fields.tags'),
                  value: entry.tags.join(', '),
                  rows: 1,
                  onCommit: (value) =>
                    update(entry.id, {
                      tags: value
                        .split(',')
                        .map((tag) => tag.trim())
                        .filter((tag) => tag.length > 0),
                    }),
                }),
                h(
                  'div',
                  { className: 'dsl-actions' },
                  entry.status === 'confirmed'
                    ? h(
                        'button',
                        {
                          type: 'button',
                          className: 'dsl-btn',
                          onClick: () => update(entry.id, { status: 'draft' }),
                        },
                        t('unconfirm'),
                      )
                    : h(
                        'button',
                        {
                          type: 'button',
                          className: 'dsl-btn dsl-btnPrimary',
                          onClick: () => update(entry.id, { status: 'confirmed' }),
                        },
                        t('confirm'),
                      ),
                  entry.status === 'deprecated'
                    ? h(
                        'button',
                        {
                          type: 'button',
                          className: 'dsl-btn',
                          onClick: () => update(entry.id, { status: 'draft' }),
                        },
                        t('restore'),
                      )
                    : h(
                        'button',
                        {
                          type: 'button',
                          className: 'dsl-btn',
                          onClick: () => update(entry.id, { status: 'deprecated' }),
                        },
                        t('deprecate'),
                      ),
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'dsl-btn',
                      onClick: () => update(entry.id, { archived: !entry.archived }),
                    },
                    entry.archived ? t('unarchive') : t('archive'),
                  ),
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'dsl-btn dsl-btnDanger',
                      onClick: () => void remove(entry.id),
                    },
                    t('remove'),
                  ),
                ),
              )
            : null,
        )
      })

      let list = rows
      if (snapshot.phase === 'loading') list = h('div', { className: 'dsl-empty' }, t('loading'))
      else if (snapshot.phase === 'failed') list = h('div', { className: 'dsl-empty' }, `${t('loadFailed')}: ${snapshot.error}`)
      else if (snapshot.entries.length === 0) list = h('div', { className: 'dsl-empty' }, t('empty'))
      else if (rows.length === 0) list = h('div', { className: 'dsl-empty' }, t('noMatch'))

      return h(
        'div',
        { className: 'dsl-page' },
        h('p', { className: 'dsl-intro' }, t('intro')),
        h(
          'div',
          { className: 'dsl-bar' },
          h('input', {
            className: 'dsl-input',
            type: 'search',
            value: query,
            placeholder: t('search'),
            'aria-label': t('search'),
            onChange: (event) => setQuery(event.target.value),
          }),
          h(
            'select',
            {
              className: 'dsl-select',
              value: kindFilter,
              'aria-label': t('kind'),
              onChange: (event) => setKindFilter(event.target.value),
            },
            h('option', { value: 'all' }, `${t('kind')}: ${t('all')}`),
            KINDS.map((kind) => h('option', { key: kind, value: kind }, t(`kindLabel.${kind}`))),
          ),
          h(
            'select',
            {
              className: 'dsl-select',
              value: statusFilter,
              'aria-label': t('status'),
              onChange: (event) => setStatusFilter(event.target.value),
            },
            h('option', { value: 'all' }, `${t('status')}: ${t('all')}`),
            STATUSES.map((status) => h('option', { key: status, value: status }, t(`statusLabel.${status}`))),
          ),
        ),
        summary.length > 0
          ? h(
              'div',
              { className: 'dsl-stats' },
              summary.map((text, index) =>
                index === 0
                  ? h('span', { key: text }, text)
                  : [h('span', { key: `${text}-sep`, className: 'dsl-dot', 'aria-hidden': true }), h('span', { key: text }, text)],
              ),
            )
          : null,
        h('div', { className: 'dsl-list' }, list),
        notice === null
          ? null
          : h('div', { className: 'dsl-foot' + (notice.failed ? ' dsl-footErr' : '') }, notice.text),
        snapshot.storePath.length > 0
          ? h('div', { className: 'dsl-foot' }, `${t('store')}: ${snapshot.storePath}`)
          : null,
      )
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'solution-ledger: dictionaries')
        const t = ctx.locale.bind(NS)

        // `main` carries no translator, so the bound `t` is closed over once and
        // the wrapper identity stays stable across renders.
        function MainPanel(props) {
          return h(LedgerPage, { ...props, t })
        }

        const styleTag = document.createElement('style')
        styleTag.setAttribute('data-plugin-css', 'dsh-solution-ledger/page')
        styleTag.textContent = CSS
        document.head.appendChild(styleTag)
        ctx.effect(() => () => styleTag.remove(), 'solution-ledger: page styles')

        // The panel id doubles as the `main` key: the sidebar owns the button
        // and switches the main column to the panel registered under that id.
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            {
              name: 'sidebar.panellist',
              id: PANEL_ID,
              order: 30,
              label: () => t('nav'),
              locale: NS,
            },
            PanelIcon,
          ),
        )

        ctx.slots.inject('main', () =>
          ctx.slots.register({ name: 'main', key: PANEL_ID }, MainPanel),
        )
      },
    }
  },
})
