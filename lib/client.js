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
    const CHECK_URL = '/solution-ledger/update-check'
    const BACKUP_URL = '/solution-ledger/backup'
    /** Own package name: the Plugins page is asked to open exactly this bundle. */
    const PACKAGE_NAME = 'dsh-solution-ledger'

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
      updateChecking: '检查更新…',
      updateAvailable: '有新版本',
      updateCurrent: '当前',
      updateLatest: '已是最新',
      updateFailed: '更新检查失败',
      updateNow: '去更新',
      updateLater: '稍后',
      updateRecheck: '重新检查',
      updateCheckedAt: '检查于',
      updateMirrorLag: '镜像未同步',
      updateMirrorLagHint: '官方源已发布，npmmirror 仍停在旧版。安装时请把源切到 registry.npmjs.org，否则会装不到。',
      updateDegraded: '官方源不可达，以下结果来自镜像，可能滞后',
      updatePublishing: '官方源正在发布该版本，稍后再查',
      updateHint: '在 Plugins 页对这个插件点 Update 即可，确认框里会显示目标版本。',
      updateOpenFailed: '打不开 Plugins 页，请从侧边栏手动打开。',
      updateSources: '源状态',
      updateUnavailable: '目标版本在所有源上都取不到，先确认发布是否完成',
      updateReadyForPlugins: '已备份，正在打开 Plugins 页',
      backingUp: '正在备份…',
      backupDone: '已备份旧版',
      backupFailed: '备份失败',
      backupFailedAsk: '仍要前往 Plugins 页更新吗？没有备份就无法从本地回退。',
      restoreHint: '回退命令',
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
      updateChecking: 'Checking for updates…',
      updateAvailable: 'New version',
      updateCurrent: 'current',
      updateLatest: 'Up to date',
      updateFailed: 'Update check failed',
      updateNow: 'Update',
      updateLater: 'Later',
      updateRecheck: 'Check again',
      updateCheckedAt: 'checked',
      updateMirrorLag: 'mirror not synced',
      updateMirrorLagHint: 'The official registry has this release but npmmirror still serves the old one. Switch the install source to registry.npmjs.org or the install will not find it.',
      updateDegraded: 'Official registry unreachable; this answer came from the mirror and may lag',
      updatePublishing: 'The registry is still finalizing this release, try again later',
      updateHint: 'Open Plugins and press Update on this plugin; the confirmation shows the target version.',
      updateOpenFailed: 'Could not open the Plugins page; open it from the sidebar.',
      updateSources: 'Sources',
      updateUnavailable: 'No source serves the target version yet; confirm the publish finished',
      updateReadyForPlugins: 'Backed up; opening the Plugins page',
      backingUp: 'Backing up…',
      backupDone: 'Previous version saved',
      backupFailed: 'Backup failed',
      backupFailedAsk: 'Open the Plugins page anyway? Without a backup there is no local way back.',
      restoreHint: 'restore with',
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
      // Update strip. Deliberately quiet when everything is current: it must not
      // compete with the ledger it sits above.
      '.dsl-update{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:8px 12px;border-radius:var(--dsw-radius-md);border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}',
      '.dsl-updateHot{border-color:var(--dsw-alias-brand-primary)}',
      '.dsl-updateStrong{color:var(--dsw-alias-label-primary);font-weight:600;font-size:13px}',
      '.dsl-updateHint{flex-basis:100%;font-size:12px;line-height:17px;color:var(--dsw-alias-label-secondary)}',
      '.dsl-updateSpacer{flex:1}',
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
      // `idle` until the first answer lands; `ready` carries the Host report.
      // `backup` holds the last confirmed rollback copy for this version.
      const [updateState, setUpdateState] = React.useState({
        phase: 'idle',
        report: null,
        error: null,
        backup: null,
      })
      const [updateDismissed, setUpdateDismissed] = React.useState(false)

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
       * Ask the Host whether a newer version exists.
       *
       * `force` bypasses the Host's short cache, which is what the page offers
       * right after a publish: the whole point is to see a version that a
       * cached answer would still deny.
       * @param force - skip the Host-side cached answer.
       */
      const checkUpdate = React.useCallback(async (force) => {
        setUpdateState((current) => ({ ...current, phase: 'checking', error: null }))
        try {
          const response = await fetch(force === true ? `${CHECK_URL}?force=1` : CHECK_URL, {
            headers: { Accept: 'application/json' },
          })
          const answer = await readAnswer(response)
          if (answer.disabled === true) {
            setUpdateState((current) => ({ ...current, phase: 'disabled', report: null, error: null }))
            return
          }
          if (answer.ok !== true) throw new Error(answer.error ?? 'unreachable')
          setUpdateState((current) => ({ ...current, phase: 'ready', report: answer, error: null }))
        } catch (error) {
          setUpdateState((current) => ({ ...current, phase: 'failed', report: null, error: String(error) }))
        }
      }, [])

      React.useEffect(() => {
        void checkUpdate(false)
      }, [checkUpdate])

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

      /** Local clock time for a check, so a stale answer is recognizable. */
      const clock = (ms) => {
        try {
          return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        } catch {
          return ''
        }
      }

      /** Short host name for a registry URL, so a source line stays readable. */
      const hostOf = (url) => {
        try {
          return new URL(url).host
        } catch {
          return String(url)
        }
      }

      /**
       * Reaching the Plugins page is the only way this plugin installs
       * anything, so the two safety steps happen here first:
       *
       * 1. Every registry is asked for the target tarball. A version in
       *    `dist-tags` whose file 404s everywhere would turn an update into a
       *    removal with nothing to install, so it is refused up front.
       * 2. The running copy is saved before leaving. `updateBundle` will not
       *    move backwards, so without this copy there is no local way back.
       */
      const goUpdate = async (report, installable, hasBackup) => {
        if (installable !== true) {
          setNotice({ text: t('updateUnavailable'), failed: true })
          return
        }
        if (hasBackup !== true) {
          setUpdateState((current) => ({ ...current, phase: 'backing-up', error: null }))
          try {
            const response = await fetch(BACKUP_URL, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: '{}',
            })
            const answer = await readAnswer(response)
            if (answer.ok !== true) throw new Error(answer.error ?? 'backup failed')
            setUpdateState((current) => ({ ...current, phase: 'ready', backup: answer.backup }))
          } catch (error) {
            setUpdateState((current) => ({ ...current, phase: 'ready' }))
            const proceed =
              typeof window === 'undefined' ||
              window.confirm(`${t('backupFailed')}: ${String(error)}\n\n${t('backupFailedAsk')}`)
            if (!proceed) return
          }
        }
        if (props.openPlugins?.() !== true) setNotice({ text: t('updateOpenFailed'), failed: true })
        else setNotice({ text: t('updateReadyForPlugins'), failed: false })
      }

      /**
       * The update strip. Silent unless there is something to say: a check that
       * is running, failed, or found a newer version. A successful "up to date"
       * collapses to one quiet line because it still proves the check ran.
       */
      const updateStrip = (() => {
        if (updateState.phase === 'idle' || updateState.phase === 'disabled') return null
        if (updateState.phase === 'checking') {
          return h('div', { className: 'dsl-update' }, h('span', null, t('updateChecking')))
        }
        if (updateState.phase === 'failed') {
          return h(
            'div',
            { className: 'dsl-update' },
            h('span', null, `${t('updateFailed')}: ${updateState.error}`),
            h('span', { className: 'dsl-updateSpacer' }),
            h('button', { type: 'button', className: 'dsl-btn', onClick: () => void checkUpdate(true) }, t('updateRecheck')),
          )
        }
        const report = updateState.report
        if (report === null) return null

        if (report.hasUpdate !== true) {
          return h(
            'div',
            { className: 'dsl-update' },
            h(
              'span',
              null,
              report.publishing === true
                ? t('updatePublishing')
                : `${t('updateLatest')} · v${report.current || report.latest}`,
            ),
            h('span', { className: 'dsl-updateSpacer' }),
            h('span', null, `${t('updateCheckedAt')} ${clock(report.checkedAt)}`),
            h('button', { type: 'button', className: 'dsl-btn', onClick: () => void checkUpdate(true) }, t('updateRecheck')),
          )
        }

        if (updateDismissed) return null
        const mirror = report.mirror
        const availability = Array.isArray(report.availability) ? report.availability : []
        const installable = report.installable === true
        const backup = updateState.backup
        const busy = updateState.phase === 'backing-up'

        // Every line here answers "why am I allowed / not allowed to install".
        const detail = []
        if (availability.length > 0) {
          detail.push(
            `${t('updateSources')} · ${availability
              .map((entry) => `${hostOf(entry.registry)} ${entry.ok === true ? '200' : entry.status || entry.error}`)
              .join(' / ')}`,
          )
        }
        if (mirror !== null && mirror.lagging === true) {
          detail.push(`${t('updateMirrorLag')} · ${t('updateMirrorLagHint')}`)
        } else if (report.degraded === true) {
          detail.push(t('updateDegraded'))
        }
        if (installable !== true) detail.push(t('updateUnavailable'))
        if (backup !== null) {
          detail.push(`${t('backupDone')} · ${backup.path} · ${t('restoreHint')} ${backup.restoreCommand}`)
        } else if (installable === true) {
          detail.push(t('updateHint'))
        }

        return h(
          'div',
          { className: 'dsl-update dsl-updateHot' },
          h('span', { className: 'dsl-updateStrong' }, `${t('updateAvailable')} v${report.latest}`),
          h('span', null, `· ${t('updateCurrent')} v${report.current}`),
          h('span', { className: 'dsl-updateSpacer' }),
          h(
            'button',
            {
              type: 'button',
              className: 'dsl-btn dsl-btnPrimary',
              disabled: busy,
              onClick: () => void goUpdate(report, installable, backup !== null),
            },
            busy ? t('backingUp') : t('updateNow'),
          ),
          h('button', { type: 'button', className: 'dsl-btn', onClick: () => setUpdateDismissed(true) }, t('updateLater')),
          h(
            'div',
            { className: 'dsl-updateHint' },
            detail.map((line, index) => h('div', { key: `d${index}` }, line)),
          ),
        )
      })()

      let list = rows
      if (snapshot.phase === 'loading') list = h('div', { className: 'dsl-empty' }, t('loading'))
      else if (snapshot.phase === 'failed') list = h('div', { className: 'dsl-empty' }, `${t('loadFailed')}: ${snapshot.error}`)
      else if (snapshot.entries.length === 0) list = h('div', { className: 'dsl-empty' }, t('empty'))
      else if (rows.length === 0) list = h('div', { className: 'dsl-empty' }, t('noMatch'))

      return h(
        'div',
        { className: 'dsl-page' },
        h('p', { className: 'dsl-intro' }, t('intro')),
        updateStrip,
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
          return h(LedgerPage, { ...props, t, openPlugins })
        }

        /**
         * Open this bundle's page on the official Plugins panel.
         *
         * `ui-plugin-manager` publishes `pluginNavigation` through Cordis
         * reflect, and that opens the package's own detail page — the one place
         * with a Versions section, an Update confirmation, progress and a
         * rollback. Reimplementing the install here would mean replacing a
         * package this very plugin runs from, so the button only navigates.
         * @returns true when a navigation was issued.
         */
        function openPlugins() {
          try {
            const navigation = ctx.reflect?.get?.('pluginNavigation')
            if (navigation !== undefined && typeof navigation.openBundle === 'function') {
              navigation.openBundle(PACKAGE_NAME)
              return true
            }
          } catch (error) {
            console.log('solution-ledger: pluginNavigation unavailable:', String(error))
          }
          try {
            const layout = (typeof ctx.get === 'function' ? ctx.get('layout') : undefined) ?? ctx.layout
            if (layout !== undefined && typeof layout.selectPanel === 'function') {
              layout.selectPanel('plugins')
              return true
            }
          } catch (error) {
            console.log('solution-ledger: cannot open the Plugins panel:', String(error))
          }
          return false
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
