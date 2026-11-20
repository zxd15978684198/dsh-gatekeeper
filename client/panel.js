/**
 * The browser half of gatekeeper: the sidebar panel and the composer chip.
 *
 * Two rules shape everything below.
 *
 * **The panel is a read-only report.** It fetches one route and draws what the
 * route says. No tool is invoked from here, nothing is written to the project, and
 * every failure ends in a sentence the user can act on.
 *
 * **The chip never speaks for the user.** Picking a mode writes one instruction
 * into the draft through the Host's own action face; the user still presses send.
 *
 * ## Design notes
 *
 * The panel used to be five different card treatments stacked on top of each
 * other — a bordered card here, a tinted card there, a block with a coloured
 * border below them — which reads as "assembled" rather than "designed". It is now
 * one surface with one paper-like section primitive: a hairline title, aligned
 * rows, and colour reserved for state (a refusal, a warning, a live status). Cards
 * are used only where something is genuinely floating above the page: the mode
 * popover.
 */
window.__ModuleLoader__.load({
  id: 'gatekeeper',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } = React

    const STATUS_ROUTE = '/gatekeeper/status'
    // Read-only sibling of the status route: it renders the workflow for a stage
    // selection. The panel only ever reads; writing stays with the tools.
    const PREVIEW_ROUTE = '/gatekeeper/preview'
    const PANEL_ID = 'gatekeeper'
    const MODE_ID = 'gatekeeper-mode'
    const MODE_STATUS_ID = 'gatekeeper-mode-status'
        const MODE_STORAGE_KEY = 'gatekeeper.mode'
    const SESSION_STORAGE_KEY = 'gatekeeper.session'
    const REQUEST_TIMEOUT_MS = 8000
    // The panel follows the session's directory rather than a snapshot taken when
    // it mounted, so it re-reads the route on a timer and whenever the tab comes
    // back into view. Quiet polls do not touch the loading state: a panel that
    // flashes "读取中" every few seconds is worse than a slightly stale number.
    const POLL_MS = 10000

    // Which session is on screen.
    //
    // Nothing on the Host's HTTP surface says "the active session", and the panel is
    // a global seat: it is mounted once and survives every session switch. The
    // composer chip, by contrast, only exists inside the composer of the visible
    // session, so it can see the session id the panel cannot. It publishes it here
    // and the panel asks about that session by name. Without this the route could
    // only answer "the newest session", which is often a background one — the exact
    // reason a switched directory looked ignored.
    let visibleSessionId = null
    const sessionWatchers = []

    /** Record the session the composer chip is currently rendered for. */
    function rememberVisibleSession(id) {
      if (typeof id !== 'string' || id === '') return
      if (visibleSessionId === id) return
      visibleSessionId = id
      // A switch should show up at once, not at the next poll: the user just moved.
      for (const watcher of sessionWatchers.slice()) {
        try {
          watcher(id)
        } catch (error) {
          console.warn('gatekeeper: a session watcher threw', error)
        }
      }
    }

    /** Subscribe to visible-session changes; returns the unsubscribe. */
    function onVisibleSession(watcher) {
      sessionWatchers.push(watcher)
      return () => {
        const index = sessionWatchers.indexOf(watcher)
        if (index !== -1) sessionWatchers.splice(index, 1)
      }
    }

    /**
     * The session id a session-scoped slot is rendering for.
     *
     * The composer slots receive the standard session props, and the exact shape has
     * moved between DSH releases. Reading each known carrier in turn costs one
     * `typeof` and buys the difference between "the panel follows you" and "the
     * panel follows whichever session the Host touched last" — the bug where a
     * switched directory appeared to be ignored.
     */
    function sessionIdOf(props) {
      if (props === null || props === undefined) return null
      const direct = props.sessionId
      if (typeof direct === 'string' && direct !== '') return direct
      const fromSession = props.session?.id ?? props.session?.header?.id
      if (typeof fromSession === 'string' && fromSession !== '') return fromSession
      const fromInput = props.input === null || props.input === undefined ? undefined : props.input.sessionId
      if (typeof fromInput === 'string' && fromInput !== '') return fromInput
      try {
        const snapshot = typeof props.conversation?.getSnapshot === 'function'
          ? props.conversation.getSnapshot()
          : null
        const fromConversation = snapshot?.sessionId
        if (typeof fromConversation === 'string' && fromConversation !== '') return fromConversation
      } catch {
        // A hook that throws must not take the chip down with it.
      }
      return null
    }

    // ------------------------------------------------------------ design tokens
    //
    // One scale, used everywhere. The numbers are the whole design system: if a
    // value is not in here it does not belong in a style object below.
    const RADIUS = { sm: '6px', md: '8px', lg: '12px', pill: '999px' }
    const TEXT = { micro: '11px', small: '12px', body: '13px', title: '15px' }
    const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'

    // Every colour below is an app theme token, so the panel and the chip follow the
    // app's light/dark switch with no listener and no duplicated palette. Do not add
    // literals here: a hex value cannot follow a theme.
    const COLOR = {
      bg: 'var(--dsw-alias-bg-base)',
      surface: 'var(--dsw-alias-bg-layer-1)',
      raised: 'var(--dsw-alias-bg-layer-2)',
      overlay: 'var(--dsw-alias-bg-overlay)',
      line: 'var(--dsw-alias-border-l1)',
      lineStrong: 'var(--dsw-alias-border-l2)',
      brand: 'var(--dsw-alias-brand-primary)',
      primary: 'var(--dsw-alias-label-primary)',
      secondary: 'var(--dsw-alias-label-secondary)',
      error: 'var(--dsw-alias-state-error-primary)',
      success: 'var(--dsw-alias-state-success-primary)',
      warn: 'var(--dsw-alias-state-warn-primary)',
      idle: 'var(--dsw-alias-state-idle-primary)',
    }

    // ------------------------------------------------------------- 技能包模式
    //
    // One mode per packaged document, grouped the way the source skills are
    // grouped: four upstream folders plus two for the documents written for this
    // plugin, sixteen documents, no invented taxonomy on top. A mode id IS a
    // packaged topic id, so the instruction and the tool agree by construction and
    // a typo cannot quietly pick the wrong document.
    // Grouped by which of the three tools the document serves, not by which
    // upstream package it came from. Nine documents come from four upstream skills
    // and seven are written for this plugin; a reader picking a mode does not care
    // about that provenance, they care whether it is about reading, writing or
    // running. The provenance is still named on every mode (`source` in
    // ./lib/references.js) and returned by py-audit's `topic` argument.
    const MODE_GROUPS = [
      {
        tool: 'py-audit',
        label: '读 · 先弄清这个项目由谁管',
        hint: '依赖归谁、版本从哪来、脚本怎么跑 —— 判定之前要看的文档',
        modes: [
          {
            id: 'uv-basics',
            label: 'uv 基础',
            hint: '项目依赖与环境该怎么用 uv 管',
            task: '用 uv 管理这个项目的依赖与虚拟环境',
            gives: 'pyproject 依赖段 + uv.lock',
          },
          {
            id: 'uv-commands',
            label: 'uv 命令',
            hint: '把 pip / poetry 命令换成 uv 的写法',
            task: '把这些项目的依赖安装、运行、锁定命令换成 uv 的写法',
            gives: '等价的 uv 命令清单',
          },
          {
            id: 'migration',
            label: '迁移到 uv',
            hint: '从 poetry / pip 迁过来',
            task: '把这个项目从现有工具迁到 uv + ruff + pytest 工具链',
            gives: '迁移步骤与命令对照',
          },
          {
            id: 'pep723',
            label: 'PEP 723 脚本',
            hint: '单文件脚本的内联依赖',
            task: '把这个项目里的脚本改成 PEP 723 内联依赖的形式',
            gives: '带内联依赖的单文件脚本',
          },
        ],
      },
      {
        tool: 'py-scaffold',
        label: '写 · 九份配置该长什么样',
        hint: 'pyproject、prek 钩子、Dependabot、workflow、ci.py、版本清单 —— 生成前先看模子',
        modes: [
          {
            id: 'pyproject',
            label: 'pyproject 配置',
            hint: '把配置集中到 pyproject.toml',
            task: '把这个项目的配置整理进 pyproject.toml',
            gives: '一个 pyproject.toml 骨架',
          },
          {
            id: 'ruff-config',
            label: 'Ruff 配置',
            hint: '规则集、target-version、格式化',
            task: '给这个项目配一套 ruff 规则与 target-version',
            gives: '规则集 + target-version + format 段',
          },
          {
            id: 'prek',
            label: 'prek 钩子',
            hint: '提交前跑 ruff / 安全检查',
            task: '用 prek 给这个项目配提交前钩子',
            gives: '.pre-commit-config.yaml',
          },
          {
            id: 'dependabot',
            label: 'Dependabot',
            hint: '依赖自动更新与 7 天冷静期',
            task: '给这个项目配 Dependabot 自动更新',
            gives: '.github/dependabot.yml',
          },
          {
            id: 'gh-workflow',
            label: 'GitHub Actions',
            hint: '13 阶段 Python/uv 版 workflow 模板',
            task: '为这个项目生成 Python/uv 版 GitHub Actions workflow',
            gives: '.github/workflows/ci.yml',
          },
          {
            id: 'ci-pipeline',
            label: '流程形状',
            hint: '单 job 还是拆 job、needs 与 artifact',
            task: '判断这个项目的 CI 该用一个 job 还是拆成多个',
            gives: '单 job / 多 job 的取舍',
          },
          {
            id: 'ci-design',
            label: 'CI 设计',
            hint: '质量闸门的顺序与理由',
            task: '为这个项目设计 CI 质量闸门与执行顺序',
            gives: '闸门顺序表与理由',
          },
        ],
      },
      {
        tool: 'py-run',
        label: '跑 · 闸门跑起来之后看什么',
        hint: '测试、安全、容器、发布、部署 —— 每道闸门各自证明什么',
        modes: [
          {
            id: 'testing',
            label: 'pytest 测试',
            hint: '测试布局与覆盖率',
            task: '用 pytest 组织这个项目的测试与覆盖率',
            gives: 'tests/ 布局 + pytest 配置',
          },
          {
            id: 'security',
            label: '安全与供应链',
            hint: '密钥扫描、依赖审计、workflow 权限',
            task: '给这个项目补上密钥扫描与依赖审计',
            gives: 'secret_scan.py / pip-audit 各挂在哪',
          },
          {
            id: 'ci-container',
            label: '容器验收',
            hint: 'compose/build 每道门禁 + 6 项镜像体检',
            task: '按容器五道门禁验证镜像与编排，并把 6 项体检只看作报告',
            gives: 'compose 五道门禁的判定法',
          },
          {
            id: 'ci-release',
            label: '发布',
            hint: 'download-artifact、SBOM、provenance、GitHub Release',
            task: '把这个项目的发布流程做成打标签触发：下载 dist、证明、SBOM、Release',
            gives: 'release job 的骨架',
          },
          {
            id: 'ci-deploy',
            label: '部署',
            hint: 'environment、审批、部署后的探测（变量未配就不跑）',
            task: '把这个项目的部署阶段接在发布之后，带环境与审批',
            gives: 'deploy job 与环境清单',
          },
        ],
      },
    ]

    /** Every mode, flattened, for lookups. */
    const MODES = MODE_GROUPS.reduce((all, group) => all.concat(group.modes), [])

    /**
     * The catalog name behind a mode: `uv-basics` -> `python-uv-basics`.
     *
     * These are not invented here. The Host half registers exactly this name with
     * `ctx.skills.register()`, so the token the head writes is the same one DSH
     * resolves — the head is a view of the catalog, not a label pretending to be one.
     */
    function modeSkill(mode) {
      return 'python-' + mode.id
    }

    /** The invocation token for a mode, e.g. `/python-uv-basics`. */
    function modeToken(mode) {
      return '/' + modeSkill(mode)
    }

    /**
     * The browser's `localStorage`, or `null`.
     *
     * Touching it can throw on its own (a sandboxed frame, a private window with
     * storage disabled), so even the lookup is guarded rather than the call site.
     */
    function modeStorage() {
      try {
        if (typeof localStorage !== 'undefined' && localStorage !== null) return localStorage
      } catch {
        // Falls through to the `window` probe below.
      }
      try {
        if (typeof window !== 'undefined' && window.localStorage) return window.localStorage
      } catch {
        // No storage in this environment.
      }
      return null
    }

    /** The mode id remembered in this browser, or `null`. */
    function readStoredMode() {
      try {
        const storage = modeStorage()
        if (storage === null) return null
        const value = storage.getItem(MODE_STORAGE_KEY)
        return MODES.some((mode) => mode.id === value) ? value : null
      } catch {
        // A private window without storage is not an error worth reporting.
        return null
      }
    }

    /** Remember the pick, best effort. */
    function writeStoredMode(id) {
      try {
        const storage = modeStorage()
        if (storage !== null) storage.setItem(MODE_STORAGE_KEY, id)
      } catch {
        // Ignored on purpose: the chip still works for this turn.
      }
    }

    // The chip picks a mode, the header inside the composer shows it. Those are two
    // seats in two different slots, so they cannot share React state; the pick lives
    // in this one module-level store that both subscribe to, backed by storage so a
    // reload keeps it. Nothing about the mode is ever written into the draft here:
    // the header is the encapsulation, the insert is an explicit action on it.
    let activeModeId = readStoredMode()
    const modeWatchers = new Set()

    function setActiveMode(id) {
      activeModeId = id === undefined ? null : id
      writeStoredMode(activeModeId)
      for (const watcher of Array.from(modeWatchers)) {
        try {
          watcher(activeModeId)
        } catch (error) {
          console.error('gatekeeper: a mode watcher failed', error)
        }
      }
    }

    function useActiveMode() {
      const [value, setValue] = useState(() => activeModeId)
      useEffect(() => {
        const watcher = (next) => setValue(next)
        modeWatchers.add(watcher)
        // Catch up with anything that changed between render and subscribe.
        setValue(activeModeId)
        return () => modeWatchers.delete(watcher)
      }, [])
      return value
    }

    function modeById(id) {
      if (id === null || id === undefined) return null
      return MODES.find((mode) => mode.id === id) ?? null
    }

    /**
     * The session the panel should describe, remembered in this browser.
     *
     * `AUTO` means "ask the chip which session is on screen". When the chip cannot
     * tell (an older Host that passes no session prop), the panel must still be
     * usable, so a pinned session id is the fallback the user can set by hand.
     */
    const AUTO_SESSION = 'auto'

    function readStoredSession() {
      try {
        const storage = modeStorage()
        if (storage === null) return AUTO_SESSION
        const value = storage.getItem(SESSION_STORAGE_KEY)
        return typeof value === 'string' && value !== '' ? value : AUTO_SESSION
      } catch {
        return AUTO_SESSION
      }
    }

    function writeStoredSession(id) {
      try {
        const storage = modeStorage()
        if (storage !== null) {
          if (id === AUTO_SESSION) storage.removeItem(SESSION_STORAGE_KEY)
          else storage.setItem(SESSION_STORAGE_KEY, id)
        }
      } catch {
        // Ignored: a private window still has the in-memory pin for this session.
      }
    }

    // ------------------------------------------------------------------ styles

    const PANEL_STYLE = {
      display: 'flex',
      flexDirection: 'column',
      height: '100%',
      minHeight: 0,
      color: COLOR.primary,
      // Transparent, not COLOR.bg: the pane is mounted inside the app shell, so the
      // shell's background (and its light/dark switch) must show through.
      background: 'transparent',
      // Native widgets inside the panel — the session <select>, scrollbars — follow
      // the app's scheme rather than the operating system's.
      colorScheme: 'inherit',
      fontSize: TEXT.body,
      lineHeight: 1.55,
    }

    const HEADER_STYLE = {
      flex: '0 0 auto',
      display: 'flex',
      flexDirection: 'column',
      gap: '10px',
      padding: '18px 16px 14px',
      borderBottom: '1px solid ' + COLOR.line,
    }

    const HEADER_TOP_STYLE = {
      display: 'flex',
      alignItems: 'flex-start',
      justifyContent: 'space-between',
      gap: '12px',
    }

    const TITLE_STYLE = {
      margin: 0,
      fontSize: TEXT.title,
      fontWeight: 600,
      letterSpacing: '-0.01em',
      lineHeight: 1.3,
    }

    const SUBTITLE_STYLE = {
      marginTop: '2px',
      fontSize: TEXT.micro,
      color: COLOR.secondary,
      letterSpacing: '0.02em',
    }

    const STATUS_STYLE = {
      display: 'inline-flex',
      alignItems: 'center',
      gap: '6px',
      fontSize: TEXT.micro,
      color: COLOR.secondary,
      whiteSpace: 'nowrap',
      paddingTop: '3px',
    }

    const DOT_STYLE = {
      width: '6px',
      height: '6px',
      borderRadius: RADIUS.pill,
      background: 'currentColor',
      flex: '0 0 auto',
    }

    /** The project path: one line, mono, truncated in the middle by CSS. */
    const PATH_STYLE = {
      display: 'flex',
      alignItems: 'center',
      gap: '6px',
      minWidth: 0,
      padding: '6px 10px',
      borderRadius: RADIUS.md,
      background: COLOR.raised,
      color: COLOR.secondary,
      fontFamily: MONO,
      fontSize: TEXT.small,
      lineHeight: 1.4,
    }

    const PATH_TEXT_STYLE = {
      minWidth: 0,
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap',
      direction: 'rtl',
      textAlign: 'left',
    }

    const ACTION_BAR_STYLE = {
      display: 'flex',
      gap: '8px',
      flex: '0 0 auto',
    }

    const BODY_STYLE = {
      flex: '1 1 auto',
      minHeight: 0,
      overflowY: 'auto',
      padding: '2px 14px 18px',
      display: 'flex',
      flexDirection: 'column',
    }

    /** A section is a card: hairline borders alone made the panel read as one wall. */
    const SECTION_STYLE = {
      display: 'flex',
      flexDirection: 'column',
      gap: '6px',
      margin: '10px 0 0',
      padding: '12px 12px 10px',
      borderRadius: RADIUS.md,
      border: '1px solid ' + COLOR.line,
      background: COLOR.surface,
    }

    const SECTION_HEAD_STYLE = {
      display: 'flex',
      alignItems: 'baseline',
      justifyContent: 'space-between',
      gap: '10px',
      paddingBottom: '6px',
    }

    const SECTION_TITLE_STYLE = {
      fontSize: TEXT.small,
      fontWeight: 600,
      letterSpacing: 0,
      color: COLOR.primary,
    }

    const SECTION_HINT_STYLE = { fontSize: TEXT.micro, color: COLOR.secondary }

    const GRID_STYLE = {
      display: 'grid',
      gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
      columnGap: '16px',
    }

    const STAT_STYLE = {
      display: 'flex',
      flexDirection: 'column',
      gap: '1px',
      padding: '7px 0',
      borderBottom: '1px solid ' + COLOR.line,
      minWidth: 0,
    }

    const STAT_WIDE_STYLE = Object.assign({}, STAT_STYLE, { gridColumn: '1 / -1' })

    const STAT_LABEL_STYLE = { fontSize: TEXT.micro, color: COLOR.secondary }
    // The evidence beside a value: a path or a table name, never prose.
    const STAT_HINT_STYLE = {
      fontSize: TEXT.micro,
      color: COLOR.secondary,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      opacity: 0.85,
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap',
    }

    /** The session picker: a label and a native select, on its own line. */
    const SESSION_ROW_STYLE = {
      display: 'flex',
      alignItems: 'center',
      gap: '8px',
      padding: '8px 0 2px',
      borderTop: '1px solid ' + COLOR.line,
      marginTop: '6px',
    }
    const SELECT_STYLE = {
      flex: '1 1 auto',
      minWidth: 0,
      height: '24px',
      padding: '0 6px',
      borderRadius: RADIUS.sm,
      border: '1px solid ' + COLOR.line,
      background: COLOR.surface,
      color: COLOR.primary,
      colorScheme: 'inherit',
      fontFamily: 'inherit',
      fontSize: TEXT.small,
    }

    const STAT_VALUE_STYLE = {
      fontSize: TEXT.body,
      fontWeight: 500,
      wordBreak: 'break-word',
      minWidth: 0,
    }

    // A stage row: a filled or hollow dot, the id in mono, then its commands. The
    // dot is what says "in `all`" without a legend — filled is in, hollow is opt-in.
    const STAGE_ROW_STYLE = {
      display: 'flex',
      alignItems: 'baseline',
      flexWrap: 'wrap',
      gap: '6px',
      padding: '3px 0',
      fontSize: TEXT.small,
      lineHeight: 1.5,
    }

    // The stage list used to be a wall of shell commands. What a reader needs first is
    // what each stage is for; the command is evidence you open when you want it. The
    // default eight are gated by a check; the five optional ones either need something
    // the project may not have (a daemon, a tag, credentials) or are too slow to be
    // mandatory, and their copy says which.
    const STAGE_TEXT = {
      lock: { name: '锁文件校验', line: 'uv.lock 与 pyproject 对得上；锁文件过期在这里就红，后面的步骤不用等。' },
      sync: { name: '同步依赖', line: '按锁文件装出一套和本地一致的环境；从这一步起所有命令都跑在这套依赖里。' },
      lint: { name: '代码检查', line: '风格、导入、明显的逻辑错误。最便宜的一道，所以排在最前面。' },
      type: { name: '类型检查', line: '类型对不上，在跑测试之前就暴露，省掉一轮等待。' },
      manifest: { name: '版本清单', line: '组件版本与 release/agent_versions.json 对得上，发布前先把版本钉死。' },
      test: { name: '测试与覆盖率', line: '把行为钉住；覆盖率门槛读 pyproject，不写死在命令行。' },
      security: { name: '密钥扫描', line: '扫工作区里不该提交的密钥与凭据；这是 CI 里最容易漏、代价最高的一道。' },
      build: { name: '构建产物', line: '包能构建出来，产物是确定的；quality job 结束时上传 dist。' },
      integration: { name: '集成测试', line: '需要真实依赖的用例单独跑，失败先怀疑环境而不是代码。' },
      audit: { name: '依赖审计', line: '对已装依赖做 CVE 审计；要网络访问，所以默认不跑。' },
      container: { name: '容器验收', line: '镜像构建成功不等于能启动：compose 五道门禁，外加 6 项只报告的镜像体检。' },
      release: { name: '发布', line: '打 tag 才跑；下载 quality 的 dist，做来源证明、SBOM、GitHub Release。' },
      deploy: { name: '部署', line: '只渲染环境与骨架；部署命令没替换就红，探活只在配了变量时跑。' },
    }

    const STAGE_MARK_STYLE = { color: COLOR.brand, fontSize: '9px', flex: 'none' }

    const STAGE_OPT_IN_STYLE = { color: COLOR.secondary, fontSize: TEXT.micro, flex: 'none' }

    /** The stage toolbar: one primary action, one reset, nothing else. */
    const STAGE_ACTIONS_STYLE = { display: 'flex', gap: '8px', padding: '8px 0 2px' }

    const STAGE_BUTTON_STYLE = {
      padding: '5px 11px',
      borderRadius: RADIUS.pill,
      border: '1px solid ' + COLOR.lineStrong,
      background: 'transparent',
      color: COLOR.primary,
      font: 'inherit',
      fontSize: TEXT.micro,
      lineHeight: 1.4,
      cursor: 'pointer',
    }

    /** The checkbox stand-in: a 20px hit target, because 12px ones miss. */
    const STAGE_TOGGLE_STYLE = {
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      width: '20px',
      height: '20px',
      flex: '0 0 auto',
      borderRadius: '6px',
      border: '1px solid ' + COLOR.lineStrong,
      background: 'transparent',
      color: COLOR.secondary,
      font: 'inherit',
      fontSize: TEXT.micro,
      lineHeight: 1,
      cursor: 'pointer',
    }

    const STAGE_TOGGLE_ON_STYLE = Object.assign({}, STAGE_TOGGLE_STYLE, {
      border: '1px solid ' + COLOR.brand,
      background: 'color-mix(in srgb, ' + COLOR.brand + ' 16%, transparent)',
      color: COLOR.brand,
    })

    const PREVIEW_STYLE = {
      margin: '8px 0 2px',
      padding: '10px 12px',
      maxHeight: '220px',
      overflow: 'auto',
      borderRadius: RADIUS.md,
      border: '1px solid ' + COLOR.line,
      background: COLOR.raised,
      color: COLOR.secondary,
      fontFamily: MONO,
      fontSize: TEXT.micro,
      lineHeight: 1.55,
      whiteSpace: 'pre',
    }
    const STAGE_MAIN_STYLE = { display: 'flex', flexDirection: 'column', gap: '3px', flex: '1 1 auto', minWidth: 0 }

    const STAGE_TITLE_ROW_STYLE = { display: 'flex', alignItems: 'center', gap: '6px' }

    const STAGE_NAME_STYLE = { fontSize: TEXT.small, fontWeight: 600, color: COLOR.primary }

    const STAGE_LINE_STYLE = { fontSize: TEXT.micro, color: COLOR.secondary, lineHeight: 1.5 }

    const STAGE_CMDS_STYLE = {
      alignSelf: 'flex-start',
      border: 'none',
      background: 'transparent',
      padding: '0',
      color: COLOR.brand,
      fontFamily: 'inherit',
      fontSize: TEXT.micro,
      cursor: 'pointer',
    }

    const STAGE_CMD_PRE_STYLE = {
      margin: '2px 0 0',
      padding: '6px 8px',
      borderRadius: RADIUS.sm,
      background: 'color-mix(in srgb, ' + COLOR.line + ' 32%, transparent)',
      color: COLOR.secondary,
      fontFamily: MONO,
      fontSize: TEXT.micro,
      lineHeight: 1.6,
      whiteSpace: 'pre-wrap',
      wordBreak: 'break-all',
    }

    const STAGE_JOB_STYLE = {
      color: COLOR.warn, fontSize: TEXT.micro, flex: 'none', fontFamily: MONO,
    }

    const BADGE_STYLE = {
      display: 'inline-flex',
      alignItems: 'center',
      gap: '4px',
      padding: '1px 7px',
      borderRadius: RADIUS.pill,
      background: COLOR.raised,
      fontSize: TEXT.micro,
      fontWeight: 500,
      lineHeight: 1.7,
      whiteSpace: 'nowrap',
    }

    const PARA_STYLE = { margin: 0, fontSize: TEXT.body, color: COLOR.primary }

    const MUTED_STYLE = { fontSize: TEXT.small, color: COLOR.secondary, margin: 0 }

    const LIST_STYLE = {
      margin: 0,
      padding: 0,
      listStyle: 'none',
      display: 'flex',
      flexDirection: 'column',
      gap: '6px',
    }

    const LIST_ITEM_STYLE = {
      display: 'flex',
      gap: '8px',
      fontSize: TEXT.small,
      color: COLOR.secondary,
      lineHeight: 1.5,
    }

    const BULLET_STYLE = {
      flex: '0 0 auto',
      width: '14px',
      color: COLOR.secondary,
      textAlign: 'center',
    }

    /** Error / refusal: the one place colour carries meaning, so it is a band. */
    const ALERT_STYLE = {
      display: 'flex',
      flexDirection: 'column',
      gap: '6px',
      padding: '10px 12px',
      margin: '12px 0 2px',
      borderLeft: '3px solid ' + COLOR.error,
      background: COLOR.raised,
      borderRadius: '0 ' + RADIUS.sm + ' ' + RADIUS.sm + ' 0',
    }

    const ALERT_TITLE_STYLE = {
      fontSize: TEXT.small,
      fontWeight: 600,
      color: COLOR.error,
    }

    const WARN_BAND_STYLE = Object.assign({}, ALERT_STYLE, {
      borderLeftColor: COLOR.warn,
    })

    const WARN_TITLE_STYLE = Object.assign({}, ALERT_TITLE_STYLE, { color: COLOR.warn })

    // A two-column fact list: one label column for the whole panel, so 用途 / 边界 /
    // 入口 / 工具 all start text on the same vertical axis. 60px fits the longest
    // label in this panel ("直接对话") without a single row growing its own indent.
    const FACT_ROW_STYLE = {
      display: 'grid',
      gridTemplateColumns: '60px 1fr',
      gap: '10px',
      alignItems: 'baseline',
      padding: '4px 0',
      borderBottom: '1px solid ' + COLOR.line,
    }

    const FACT_LIST_STYLE = { display: 'flex', flexDirection: 'column' }

    // A titled sub-block inside a section: the label sits above its rows instead of
    // competing with them for the 60px column.
    const BLOCK_STYLE = {
      display: 'flex',
      flexDirection: 'column',
      gap: '2px',
      paddingTop: '8px',
      borderTop: '1px solid ' + COLOR.line,
    }

    const BLOCK_LABEL_STYLE = {
      fontSize: TEXT.micro,
      color: COLOR.secondary,
      letterSpacing: '0.04em',
      paddingBottom: '2px',
    }

    const FACT_LABEL_STYLE = {
      fontSize: TEXT.micro,
      color: COLOR.secondary,
      lineHeight: 1.6,
      whiteSpace: 'nowrap',
    }

    const FACT_VALUE_STYLE = {
      fontSize: TEXT.small,
      color: COLOR.primary,
      lineHeight: 1.6,
      minWidth: 0,
      wordBreak: 'break-word',
    }

    const FACT_CODE_STYLE = {
      fontFamily: MONO,
      fontSize: TEXT.small,
      color: COLOR.primary,
      lineHeight: 1.6,
      minWidth: 0,
      wordBreak: 'break-all',
    }

    const TOOL_ROW_STYLE = {
      display: 'grid',
      gridTemplateColumns: '112px 1fr',
      gap: '10px',
      alignItems: 'baseline',
      padding: '5px 0',
      borderBottom: '1px solid ' + COLOR.line,
    }

    const CODE_STYLE = {
      fontFamily: MONO,
      fontSize: TEXT.small,
      color: COLOR.primary,
      whiteSpace: 'nowrap',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
    }

    const EMPTY_STYLE = {
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      gap: '6px',
      padding: '28px 16px',
      textAlign: 'center',
      color: COLOR.secondary,
      fontSize: TEXT.small,
    }

    const FOOTER_STYLE = {
      flex: '0 0 auto',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: '10px',
      padding: '10px 18px',
      borderTop: '1px solid ' + COLOR.line,
      fontSize: TEXT.micro,
      color: COLOR.secondary,
    }

    // Buttons: one height, one radius, two intents.
    const BUTTON_BASE = {
      appearance: 'none',
      display: 'inline-flex',
      alignItems: 'center',
      gap: '5px',
      height: '26px',
      padding: '0 10px',
      borderRadius: RADIUS.md,
      font: 'inherit',
      fontSize: TEXT.small,
      lineHeight: 1,
      cursor: 'pointer',
      whiteSpace: 'nowrap',
      transition: 'background 120ms ease, border-color 120ms ease',
    }

    const BUTTON_GHOST_STYLE = Object.assign({}, BUTTON_BASE, {
      border: '1px solid ' + COLOR.line,
      background: 'transparent',
      color: COLOR.secondary,
    })

    const BUTTON_PRIMARY_STYLE = Object.assign({}, BUTTON_BASE, {
      border: '1px solid ' + COLOR.lineStrong,
      background: COLOR.raised,
      color: COLOR.primary,
    })

    const BUTTON_DISABLED_STYLE = { opacity: 0.55, cursor: 'default' }

    const LINK_BUTTON_STYLE = {
      appearance: 'none',
      border: 'none',
      background: 'none',
      padding: 0,
      font: 'inherit',
      fontSize: TEXT.micro,
      color: COLOR.secondary,
      cursor: 'pointer',
      textDecoration: 'underline',
      textUnderlineOffset: '2px',
    }

    // The chip floats its menu, so it needs a positioned parent; everything else
    // about it is ordinary inline layout in the composer dock row.
    const CHIP_WRAP_STYLE = { position: 'relative', display: 'inline-flex', maxWidth: '100%' }

    const CHIP_STYLE = Object.assign({}, BUTTON_BASE, {
      height: '24px',
      padding: '0 8px 0 9px',
      gap: '6px',
      borderRadius: RADIUS.md,
      border: '1px solid ' + COLOR.lineStrong,
      background: COLOR.surface,
      color: COLOR.primary,
      maxWidth: '280px',
      overflow: 'hidden',
    })
    const CHIP_ACTIVE_STYLE = CHIP_STYLE

    const HEAD_DOT_STYLE = {
      width: '5px',
      height: '5px',
      borderRadius: '50%',
      background: COLOR.success,
      flex: '0 0 auto',
    }

    // The skill chip is the host's inline atom (`/python-<id>` in the draft), so no
    // head style lives here; the status strip keeps its own dot style.

    const CARET_STYLE = { fontSize: '8px', opacity: 0.6, lineHeight: 1 }

    // "Already picked" strip at the top of the popover: the mode is state, so the
    // open menu has to show the current state instead of only the options.
    const PICKED_STRIP_STYLE = {
      display: 'flex',
      alignItems: 'center',
      gap: '6px',
      padding: '6px 8px',
      borderRadius: RADIUS.md,
      background: COLOR.raised,
      border: '1px solid ' + COLOR.line,
    }

    const PICKED_LABEL_STYLE = { fontSize: TEXT.micro, color: COLOR.primary, fontWeight: 600 }

    const PICKED_CLEAR_STYLE = Object.assign({}, BUTTON_BASE, {
      marginLeft: 'auto',
      height: '20px',
      padding: '0 8px',
      borderRadius: RADIUS.pill,
      border: '1px solid ' + COLOR.line,
      background: 'transparent',
      color: COLOR.secondary,
      fontSize: TEXT.micro,
    })

    const BACKDROP_STYLE = {
      position: 'fixed',
      inset: 0,
      zIndex: 60,
      background: 'transparent',
      // A transparent layer still composites; keeping it out of the paint path
      // stops the whole viewport from being redrawn when the menu toggles.
      contain: 'paint',
    }

    // The chip sits in the composer's bottom control row, so the menu opens UPWARD:
    // hanging it below the chip pushes it off the bottom of the window, which is both
    // unreachable and expensive to paint while the page scrolls to chase it.
    const POPOVER_STYLE = {
      position: 'absolute',
      bottom: 'calc(100% + 6px)',
      left: 0,
      zIndex: 61,
      width: '360px',
      maxHeight: 'min(58vh, 420px)',
      overflowY: 'auto',
      overscrollBehavior: 'contain',
      contain: 'layout paint',
      border: '1px solid ' + COLOR.lineStrong,
      borderRadius: RADIUS.lg,
      background: COLOR.overlay,
      boxShadow: '0 10px 26px color-mix(in srgb, var(--dsw-alias-label-secondary) 26%, transparent)',
      padding: '8px',
      boxSizing: 'border-box',
      display: 'flex',
      flexDirection: 'column',
      gap: '2px',
      color: COLOR.primary,
      fontSize: TEXT.small,
    }

    const POPOVER_HEAD_STYLE = {
      padding: '4px 8px 8px',
      display: 'flex',
      flexDirection: 'column',
      gap: '2px',
    }

    // The list is a tree, not a wall: four group rows, and a group's modes only
    // exist in the DOM after its row is clicked. Twelve rows at once is a menu
    // nobody reads; four rows that open one level are a table of contents.
    const GROUP_ROW_STYLE = {
      appearance: 'none',
      border: 'none',
      borderRadius: RADIUS.md,
      background: 'transparent',
      color: 'inherit',
      font: 'inherit',
      textAlign: 'left',
      padding: '7px 8px',
      cursor: 'pointer',
      display: 'flex',
      alignItems: 'baseline',
      gap: '8px',
      width: '100%',
    }

    const GROUP_ROW_OPEN_STYLE = Object.assign({}, GROUP_ROW_STYLE, { background: COLOR.raised })

    const GROUP_CHEVRON_STYLE = {
      fontFamily: MONO,
      fontSize: TEXT.micro,
      color: COLOR.secondary,
      width: '10px',
      flex: '0 0 auto',
    }

    // A hairline rail carries the depth: children sit on it, so the eye reads
    // "these belong to the row above" without a second background colour.
    const GROUP_CHILDREN_STYLE = {
      borderLeft: '1px solid ' + COLOR.line,
      marginLeft: '13px',
      paddingLeft: '5px',
      display: 'flex',
      flexDirection: 'column',
      gap: '1px',
      marginBottom: '2px',
    }

    const GROUP_SKILL_STYLE = {
      fontFamily: MONO,
      fontSize: TEXT.micro,
      color: COLOR.secondary,
      opacity: 0.85,
    }

    const GROUP_LABEL_STYLE = { fontSize: TEXT.small, fontWeight: 600 }

    const GROUP_HINT_STYLE = { fontSize: TEXT.micro, color: COLOR.secondary, marginLeft: 'auto' }

    const MODE_ROW_STYLE = {
      appearance: 'none',
      border: 'none',
      borderRadius: RADIUS.md,
      background: 'transparent',
      color: 'inherit',
      font: 'inherit',
      textAlign: 'left',
      padding: '6px 8px',
      cursor: 'pointer',
      display: 'flex',
      alignItems: 'baseline',
      gap: '8px',
      width: '100%',
    }

    const MODE_ROW_ACTIVE_STYLE = Object.assign({}, MODE_ROW_STYLE, { background: COLOR.raised })

    const MODE_LABEL_STYLE = { fontSize: TEXT.small, fontWeight: 500, flex: '0 0 auto' }

    const MODE_HINT_STYLE = {
      fontSize: TEXT.micro,
      color: COLOR.secondary,
      minWidth: 0,
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap',
    }

    // The status strip sits in the row directly above the composer card: the first
    // thing the eye meets before typing, not a badge buried in a toolbar.
    const STATUS_DOCK_STYLE = {
      display: 'flex',
      justifyContent: 'center',
      padding: '0 12px 6px',
      zIndex: 2,
    }

    const STATUS_PILL_STYLE = {
      display: 'inline-flex',
      alignItems: 'center',
      gap: '6px',
      height: '24px',
      padding: '0 7px 0 9px',
      maxWidth: '100%',
      borderRadius: RADIUS.pill,
      background: COLOR.raised,
      border: '1px solid ' + COLOR.line,
      color: COLOR.primary,
      fontFamily: MONO,
      fontSize: '11.5px',
    }

    const STATUS_SLASH_STYLE = { opacity: 0.55, flex: 'none' }

    const STATUS_NAME_STYLE = { flex: 'none', whiteSpace: 'nowrap' }

    const STATUS_HINT_STYLE = {
      color: COLOR.secondary,
      fontFamily: 'inherit',
      fontSize: TEXT.micro,
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap',
      maxWidth: '280px',
    }

    const STATUS_CLOSE_STYLE = Object.assign({}, BUTTON_BASE, {
      width: '16px',
      height: '16px',
      padding: 0,
      borderRadius: RADIUS.sm,
      border: 'none',
      background: 'transparent',
      color: COLOR.secondary,
      fontSize: '11px',
      opacity: 0.7,
      flex: 'none',
    })

    const TOAST_STYLE = {
      position: 'absolute',
      bottom: 'calc(100% + 8px)',
      left: 0,
      zIndex: 62,
      padding: '5px 9px',
      borderRadius: RADIUS.md,
      border: '1px solid ' + COLOR.line,
      background: COLOR.overlay,
      color: COLOR.secondary,
      fontSize: TEXT.micro,
      whiteSpace: 'nowrap',
    }

    // ---------------------------------------------------------------- content

    // Two sentences, then a table. The first says what the plugin decides, the
    // second says what it refuses to do — a boundary is the only claim a reader
    // cannot verify by clicking around, so it belongs in the same place.
    const INTRO = [
      '把随包的 16 份 skill 变成可执行的判据：体检项目、生成配置、写进项目、跑同一套闸门；同一批文档也注册成 /python-* 命令，在输入框里可以直接调用。',
      '边界：默认不动手。只有 py-scaffold（写 9 个固定文件，写前备份）与 py-run（只跑白名单命令）会改项目或起进程，且都必须显式 dryRun:false；py-audit 只读。lockfile 由 Poetry / PDM / Pipenv 接管时，一律返回 blocked，而不是降级改写。',
    ]

    /** The three entry points, in the order a reader is likely to meet them. */
    const ENTRY_POINTS = [
      { label: '左栏面板', text: '体检结果与流水线阶段（当前这一页）' },
      { label: '输入框下方', text: '「技能包」：十六份文档按三个工具折叠，选一个就把对应的 /python-* 命令写进输入框。它列的是文档，不是工具——要读文档用这里的模式，要动手用 py-scaffold / py-run。' },
      { label: '直接对话', text: '例如「给这个项目补 ruff 和 prek」「生成 Dependabot 配置」' },
    ]

    // One line per verb: what it does, and — just as important — what it refuses to
    // do unless asked. No adjectives; a reader choosing between three tools needs the
    // difference, not the praise.
    const TOOL_INTRO = [
      {
        name: 'py-audit',
        text: '读。一次给出：哪个锁文件在管依赖（uv，或 Poetry / PDM / Pipenv —— 这时 uv 必须退出）、'
          + 'Python 版本及其来源、ruff / ty / pytest / pre-commit 配了哪些、workflow 与 13 条静态规则的结论、'
          + '9 个生成目标缺了哪些、git hook 是否指向 prek、13 阶段闸门（8 默认 + 5 可选）的顺序；'
          + '传 topic 取回一份 skill 原文，传 run 才跑白名单内的只读探测。不写盘。',
        covers: ['锁文件与包管理器', 'Python 版本与来源', 'lint / 类型 / 测试配置', 'workflow 13 条规则', '9 个生成目标', 'git hook 状态', '13 阶段闸门顺序', '16 份 skill 原文'],
      },
      {
        name: 'py-scaffold',
        text: '写。默认只预览九份东西：pyproject 的配置表（ruff 含 per-file-ignores、pytest 覆盖率门槛、mypy 或 ty）、'
          + '.pre-commit-config.yaml、.github/dependabot.yml、workflow、scripts/ci.py、release/agent_versions.json、'
          + 'scripts/validate_version_manifest.py、scripts/secret_scan.py、scripts/container_report.py。'
          + '只有 dryRun:false 才写这九个固定路径，且绝不碰你的源码。',
        covers: ['pyproject 配置表', '.pre-commit-config.yaml', '.github/dependabot.yml', 'GitHub Actions workflow', 'scripts/ci.py', 'release/agent_versions.json', '版本清单校验脚本', '密钥扫描脚本', '容器体检脚本'],
      },
      {
        name: 'py-run',
        text: '执行。按 lock（uv lock --check）→ sync（uv sync）→ lint（ruff）→ type（mypy 或 ty）'
          + '→ manifest（版本清单）→ test（pytest，门槛读 pyproject）→ security（密钥扫描）→ build（uv build）'
          + '跑闸门；--profile commit 走提交前的快子集，--from 从某阶段续跑，可选 integration / audit / container。'
          + '命令与生成的 workflow、scripts/ci.py 同源。默认只打印计划，dryRun:false 才执行，失败即停。',
        covers: ['lock · uv lock --check', 'sync · uv sync', 'lint · ruff', 'type · mypy / ty', 'manifest · 版本清单', 'test · pytest', 'security · 密钥扫描', 'build · uv build', '可选 integration / audit / container'],
      },
    ]

    // ------------------------------------------------------------------ format

    /**
     * The manager that owns the dependency graph.
     *
     * Value only — the file that proves it is a separate column. A cell that reads
     * "uv" with `uv.lock` beside it tells a reader where to look; a cell that reads
     * "uv（有 uv.lock）" tells them what to think.
     */
    function describeManager(detection) {
      if (detection === null || detection === undefined) return '—'
      if (detection.packageManager === 'uv') return 'uv'
      if (detection.packageManager === 'unknown') return '未识别'
      return String(detection.packageManager)
    }

    /** The file behind the manager claim. */
    function managerEvidence(detection) {
      if (detection === null || detection === undefined) return ''
      if (detection.packageManager === 'uv') return 'uv.lock'
      const foreign = Array.isArray(detection.foreignLockfiles) ? detection.foreignLockfiles : []
      if (foreign.length > 0) return foreign.join(', ')
      return detection.hasPyproject === true ? 'pyproject.toml' : ''
    }

    /** The declared interpreter. */
    function describePython(detection) {
      if (detection === null || detection === undefined) return '—'
      const version = detection.pythonVersion
      return typeof version === 'string' && version !== '' ? version : '未声明'
    }

    /** Where the interpreter was declared. */
    function pythonEvidence(detection) {
      const source = detection?.pythonVersionSource
      return typeof source === 'string' && source !== '' ? source : ''
    }

    /** Dependency declaration: PEP 735 groups, legacy dev-dependencies, or neither. */
    function describeGroups(detection) {
      if (detection === null || detection === undefined) return '—'
      if (detection.hasDependencyGroups === true) return 'PEP 735 分组'
      if (detection.hasLegacyDevDependencies === true) return 'legacy dev-dependencies'
      return detection.hasPyproject === true ? '无 dev 组' : '无 pyproject.toml'
    }

    /** pyproject.toml is the only place a group can be declared. */
    function groupsEvidence(detection) {
      return detection?.hasPyproject === true ? 'pyproject.toml' : ''
    }

    /** Linters present, as tool names only. */
    function describeLinters(detection) {
      if (detection === null || detection === undefined) return '—'
      const linters = detection.linters ?? {}
      const parts = []
      if (linters.ruff === true) parts.push('ruff')
      if (linters.mypy === true) parts.push('mypy')
      if (linters.ty === true) parts.push('ty')
      if (linters.black === true) parts.push('black')
      if (linters.preCommit === true) parts.push('pre-commit')
      return parts.length === 0 ? '未配置' : parts.join('、')
    }

    /** The files that carry linter configuration. */
    function linterEvidence(detection) {
      const files = Array.isArray(detection?.linterConfigFiles) ? detection.linterConfigFiles : []
      return files.length === 0 ? '' : files.join(', ')
    }

    /** Test runner. */
    function describeTests(detection) {
      if (detection === null || detection === undefined) return '—'
      return detection.linters?.pytest === true ? 'pytest' : '未配置'
    }

    /** CI workflows, counted. */
    function describeCi(detection) {
      if (detection === null || detection === undefined) return '—'
      const workflows = Array.isArray(detection.workflows) ? detection.workflows : []
      return workflows.length === 0 ? '无' : String(workflows.length) + ' 个'
    }

    /** Which workflow files, or what is missing from `.github/workflows`. */
    function ciEvidence(detection) {
      const workflows = Array.isArray(detection?.workflows) ? detection.workflows : []
      if (workflows.length > 0) return workflows.map((workflow) => workflow.file).join(', ')
      return detection?.hasWorkflowDir === true ? '.github/workflows/（空）' : '.github/workflows/（不存在）'
    }

    /**
     * Whether `git commit` will run a hook, and whether that hook is prek's.
     *
     * A missing hook is not a defect in the project's config — `prek install` writes
     * into `.git/hooks`, which is local state — so the cell says what it is and the
     * evidence cell says how to change it, instead of implying the project is wrong.
     */
    function describeHooks(detection) {
      const hooks = detection?.gitHooks
      if (hooks === null || hooks === undefined) return '—'
      if (hooks.installed !== true) return '未安装'
      return hooks.pointsToPrek === true ? 'prek' : '已安装（未指向 prek）'
    }

    /** Where the hook lives, or the command that puts it there. */
    function hooksEvidence(detection) {
      const hooks = detection?.gitHooks
      if (hooks === null || hooks === undefined) return ''
      return hooks.installed === true ? '.git/hooks/pre-commit' : 'prek install'
    }

    /**
     * The container image report, as one cell.
     *
     * The six checks are facts the plugin states, never gates: the only one that could
     * fail is the size limit, and only when the project configured one.
     */
    function describeImageChecks(detection) {
      const container = detection?.container
      if (container === null || container === undefined) return '6 项'
      return container.reportScript === true ? '6 项 · 脚本已生成' : '6 项 · 脚本未生成'
    }

    /** The configured size limit, or the fact that there is none. */
    function imageEvidence(detection) {
      const limit = detection?.container?.imageLimit
      return typeof limit === 'number' ? '上限 ' + String(limit) + ' MB' : '不设上限 · 只报告'
    }

    /** How confident the detection is, in words rather than a bare enum. */
    function describeConfidence(detection) {
      const confidence = detection?.confidence
      if (confidence === 'high') return '高'
      if (confidence === 'medium') return '中'
      if (confidence === 'low') return '低'
      return '—'
    }

    /**
     * An ISO timestamp as a local wall clock, for the footer.
     *
     * An unparseable value is returned as-is rather than turned into "Invalid
     * Date": the footer is the one place a reader checks whether the numbers above
     * are current, so it must not lie about what it could not parse.
     */
    function describeUpdatedAt(value) {
      const parsed = new Date(value)
      if (Number.isNaN(parsed.getTime())) return String(value)
      try {
        return parsed.toLocaleTimeString('zh-CN', { hour12: false })
      } catch {
        return parsed.toISOString().slice(11, 19)
      }
    }

    /**
     * One option label for the session picker: the directory, then enough of the id
     * to tell two sessions in the same directory apart.
     */
    function shortSessionLabel(entry) {
      const dir = typeof entry?.dir === 'string' && entry.dir !== '' ? entry.dir : '（无目录）'
      const id = typeof entry?.id === 'string' ? entry.id : ''
      const tail = id.replace(/^session-/, '').slice(0, 8)
      return tail === '' ? dir : dir + ' · ' + tail
    }

    // The Host writes its `notes` in English for the model's sake. The panel has a
    // small dictionary for the sentences it knows and passes anything else through
    // unchanged, so a future Host note degrades to English rather than disappearing.
    const NOTES_ZH = {
      'No pyproject.toml at this directory: the tools suggest creating one before adding tool configuration.':
        '这个目录没有 pyproject.toml：建议先创建它，再加工具配置。',
      'A src/ directory is present: the pytest snippet points testpaths at src/tests, adjust if your tests live elsewhere.':
        '检测到 src/ 目录：pytest 片段按 src/tests 写 testpaths，测试若在别处请改。',
      'Nothing that identifies a Python project was found at this directory. If this is a monorepo, pass the subproject path instead.':
        '这个目录看不出是 Python 项目；如果这是 monorepo，请传子项目路径。',
    }

    /**
     * The Host note about an existing workflow that predates setup-uv.
     *
     * Matched by prefix instead of sitting in the table above: the key would carry a
     * retired per-action tool name into this file, and only the sentence matters.
     */
    const LEGACY_WORKFLOW_NOTE_PREFIX = 'Existing workflows do not use astral-sh/setup-uv'

    /** One note in Chinese, or the original sentence when it is not in the table. */
    function noteText(note) {
      const text = NOTES_ZH[note]
      if (text !== undefined) return text
      if (String(note).startsWith(LEGACY_WORKFLOW_NOTE_PREFIX)) {
        return '现有 workflow 没有用 astral-sh/setup-uv：再加一条流水线前，先和 py-scaffold 的方案比一比。'
      }
      return String(note)
    }

    /**
     * Why uv was refused, in Chinese.
     *
     * The Host's `reason` is a full English paragraph that quotes the skill; the
     * panel restates the same facts for the reader and keeps the quote intact,
     * because the quote is the point.
     */
    function blockerText(blocker) {
      if (blocker === null || blocker === undefined) return ''
      if (blocker.code === 'foreign-lockfile') {
        return '「' + String(blocker.file ?? '?') + '」说明这个项目的依赖由别的工具管理。1-uv skill 的原话是'
          + '「Don\'t use uv in projects managed by other tools」，所以这里不会生成 uv 配置或 uv 版 workflow。'
          + '要迁到 uv，先看 2-modern-python 的迁移清单；否则保留现有工具，跳过 py-scaffold 与 py-run。'
      }
      return String(blocker.reason ?? '')
    }

    /** The plain-text summary the copy button puts on the clipboard. */
    function summaryText(status) {
      const detection = status?.detection
      if (detection === null || detection === undefined) {
        return '门禁：还没有可体检的项目。先在会话里调用一次 py-audit。'
      }
      const lines = [
        '门禁 —— ' + String(detection.root ?? status.root ?? '?'),
        '包管理器：' + describeManager(detection),
        'Python：  ' + describePython(detection),
        'Lint：    ' + describeLinters(detection),
        '测试：    ' + describeTests(detection),
        'CI：      ' + describeCi(detection),
        '置信度：  ' + describeConfidence(detection),
        '检测时间：' + String(detection.detectedAt ?? status.recordedAt ?? '?'),
      ]
      const blockers = Array.isArray(detection.blockers) ? detection.blockers : []
      if (blockers.length > 0) {
        lines.push('', '拒绝原因：')
        for (const blocker of blockers) lines.push('- ' + blockerText(blocker))
      }
      const notes = Array.isArray(detection.notes) ? detection.notes : []
      if (notes.length > 0) {
        lines.push('', '备注：')
        for (const note of notes) lines.push('- ' + noteText(note))
      }
      return lines.join('\n')
    }

    // -------------------------------------------------------------- components

    /** A section: hairline, a small title, then content. */
    function Section({ title, hint, aside, children }) {
      const head = [React.createElement('span', { key: 'title', style: SECTION_TITLE_STYLE }, title)]
      if (hint !== undefined) head.push(React.createElement('span', { key: 'hint', style: SECTION_HINT_STYLE }, hint))
      if (aside !== undefined) head.push(React.createElement('span', { key: 'aside', style: SECTION_HINT_STYLE }, aside))
      return React.createElement(
        'section',
        { style: SECTION_STYLE },
        React.createElement('div', { key: 'head', style: SECTION_HEAD_STYLE }, head),
        children,
      )
    }

    /**
     * One cell of the spec sheet: a term, its value, and the file that proves it.
     *
     * The hint is deliberately not prose. A reader checking a claim wants the
     * path to look at, not a sentence reassuring them it was checked.
     */
    function Stat({ label, value, hint, wide }) {
      const cells = [React.createElement('span', { style: STAT_LABEL_STYLE }, label)]
      cells.push(React.createElement(
        'span',
        { key: 'value', style: STAT_VALUE_STYLE },
        value,
        hint === undefined || hint === null || hint === ''
          ? null
          : React.createElement('span', { style: STAT_HINT_STYLE }, ' ' + hint),
      ))
      return React.createElement('div', { style: wide === true ? STAT_WIDE_STYLE : STAT_STYLE }, cells)
    }

    /** A quiet pill for a short fact. */
    function Badge({ children }) {
      return React.createElement('span', { style: BADGE_STYLE }, children)
    }

    /** One bullet line in a list of notes or steps. */
    function Bullet({ marker, children }) {
      return React.createElement(
        'li',
        { style: LIST_ITEM_STYLE },
        React.createElement('span', { style: BULLET_STYLE }, marker),
        React.createElement('span', { style: { minWidth: 0 } }, children),
      )
    }

    /**
     * The rail icon: the uv hexagon with a pass mark, in `currentColor`.
     *
     * The rail renders every `sidebar.panellist` occupant as
     * `renderSlot('sidebar.panellist', { size: wide ? 16 : 18, active })`, so the
     * seat has to honour both: a hardcoded 18 ignores the collapsed rail and the
     * selection state has no visible feedback at all.
     */
    function PythonToolchainIcon(props) {
      const size = typeof props?.size === 'number' && props.size > 0 ? props.size : 18
      const active = props?.active === true
      return React.createElement(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: active ? 2 : 1.6,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
          focusable: 'false',
          style: active ? undefined : { opacity: 0.75 },
        },
        React.createElement('path', { d: 'M12 3.2 19.2 7.3v7.4L12 18.8 4.8 14.7V7.3Z' }),
        React.createElement('path', { d: 'M8.6 11.3l2.4 2.4 4.4-4.7' }),
      )
    }

    /**
     * A term/value row, used wherever a label is shorter than its explanation.
     * The label column is fixed so every block in the panel — 概览, 工具, 入口 —
     * lines up on the same axis instead of each inventing its own indent.
     */
    function Fact({ label, value, code }) {
      return React.createElement(
        'div',
        { style: FACT_ROW_STYLE },
        React.createElement('span', { style: FACT_LABEL_STYLE }, label),
        code === true
          ? React.createElement('code', { style: FACT_CODE_STYLE }, value)
          : React.createElement('span', { style: FACT_VALUE_STYLE }, value),
      )
    }

    /**
     * What the plugin is, which three tools it adds, and the three ways in.
     *
     * Three labelled blocks, not one paragraph: 用途/边界 answer "should I use
     * this", the tool table answers "which one", the entry list answers "how do I
     * start". Each block keeps the same label column, so the eye can skip.
     */
    function Intro({ open, onToggle }) {
      const children = [
        React.createElement(
          'div',
          { key: 'head', style: SECTION_HEAD_STYLE },
          React.createElement('span', { key: 'title', style: SECTION_TITLE_STYLE }, '插件概览'),
          React.createElement('button', { type: 'button', key: 'toggle', style: LINK_BUTTON_STYLE, onClick: onToggle },
            open ? '收起' : '展开'),
        ),
      ]
      if (open) {
        children.push(React.createElement(
          'div',
          { key: 'purpose', style: FACT_LIST_STYLE },
          INTRO.map((line, index) => React.createElement(
            Fact,
            { key: 'intro-' + index, label: index === 0 ? '用途' : '边界', value: line },
          )),
        ))
        children.push(React.createElement(
          'div',
          { key: 'tools', style: BLOCK_STYLE },
          React.createElement('span', { key: 'label', style: BLOCK_LABEL_STYLE }, '三个工具'),
          React.createElement(
            'div',
            { key: 'rows', style: FACT_LIST_STYLE },
            TOOL_INTRO.map((tool) => React.createElement(
              'div',
              { key: tool.name, style: TOOL_ROW_STYLE },
              React.createElement('code', { style: CODE_STYLE }, tool.name),
              React.createElement(
                'div',
                { key: 'body', style: { display: 'flex', flexDirection: 'column', gap: '3px', minWidth: 0 } },
                React.createElement('span', { key: 'text', style: FACT_VALUE_STYLE }, tool.text),
                React.createElement(
                  'span',
                  { key: 'covers', style: MUTED_STYLE },
                  '覆盖：' + tool.covers.join(' · '),
                ),
              ),
            )),
          ),
        ))
        children.push(React.createElement(
          'div',
          { key: 'entries', style: BLOCK_STYLE },
          React.createElement('span', { key: 'label', style: BLOCK_LABEL_STYLE }, '入口'),
          React.createElement(
            'div',
            { key: 'rows', style: FACT_LIST_STYLE },
            ENTRY_POINTS.map((entry) => React.createElement(
              Fact,
              { key: entry.label, label: entry.label, value: entry.text },
            )),
          ),
        ))
      }
      return React.createElement('section', { style: SECTION_STYLE }, children)
    }

    /**
     * The panel.
     *
     * Every failure mode ends in a sentence the user can act on — no route, a
     * route that timed out, a Host that answered with an error — because a blank
     * panel reads as "the plugin is broken" when it usually means "the route is
     * not mounted in this build".
     */
    function PythonToolchainPanel(props) {
      const [status, setStatus] = useState(null)
      const [error, setError] = useState(null)
      const [loading, setLoading] = useState(true)
      const [copied, setCopied] = useState(false)
      const [introOpen, setIntroOpen] = useState(true)
      // Stage selection. `null` means "whatever the plugin calls default"; a click
      // turns it into an explicit set, which is the only way an opt-in stage such as
      // container / release / deploy can get into the preview.
      const [stagePick, setStagePick] = useState(null)
      const [preview, setPreview] = useState(null)
      const [previewing, setPreviewing] = useState(false)
      const [cmdOpen, setCmdOpen] = useState(null)
      const [sessionChoice, setSessionChoice] = useState(() => readStoredSession())
      // `load` is created once, so it cannot close over the state value; the ref is
      // how a manual pin reaches the next request without recreating the callback.
      const sessionChoiceRef = useRef(AUTO_SESSION)
      sessionChoiceRef.current = sessionChoice
      // Read at request time, not at mount: the chip publishes the visible session
      // id as the user moves between sessions, and a value captured in a closure
      // would pin the panel to whichever session happened to be open first.
      const load = useCallback((refresh, quiet) => {
        const quietMode = quiet === true
        if (!quietMode) setLoading(true)
        const controller = typeof AbortController === 'function' ? new AbortController() : null
        const timer = setTimeout(() => {
          if (controller !== null) controller.abort()
        }, REQUEST_TIMEOUT_MS)
        const propsSessionId = sessionIdOf(props)
        const pinned = sessionChoiceRef.current
        const sessionId = pinned !== AUTO_SESSION
          ? pinned
          : (visibleSessionId !== null ? visibleSessionId : propsSessionId)
        const params = []
        if (refresh === true) params.push('refresh=1')
        if (sessionId !== null) params.push('session=' + encodeURIComponent(sessionId))
        const url = STATUS_ROUTE + (params.length === 0 ? '' : '?' + params.join('&'))
        fetch(url, { signal: controller === null ? undefined : controller.signal, headers: { accept: 'application/json' } })
          .then((response) => {
            if (!response.ok) throw new Error('状态路由返回 ' + response.status)
            return response.json()
          })
          .then((body) => {
            setStatus(body)
            setError(null)
          })
          .catch((cause) => {
            const aborted = cause !== null && cause !== undefined && cause.name === 'AbortError'
            // A failed background poll must not replace a working panel with an
            // error: keep the last good answer until a foreground read fails too.
            if (quietMode && aborted) return
            setError(aborted
              ? '状态路由 ' + REQUEST_TIMEOUT_MS + 'ms 内没有响应（这个 DSH 可能没有挂载 webServer）。'
              : '无法读取 /gatekeeper/status：' + String(cause?.message ?? cause))
          })
          .finally(() => {
            clearTimeout(timer)
            if (!quietMode) setLoading(false)
          })
      }, [])
      useEffect(() => {
        load(false)
      }, [load])

      // Switching sessions is a user gesture, so it gets an immediate read rather
      // than waiting out the poll interval.
      useEffect(() => onVisibleSession(() => load(false, true)), [load])

      useEffect(() => {
        const poll = () => {
          if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
          load(false, true)
        }
        const timer = typeof setInterval === 'function' ? setInterval(poll, POLL_MS) : null
        const onVisible = () => {
          if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
          poll()
        }
        if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
          document.addEventListener('visibilitychange', onVisible)
        }
        if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
          window.addEventListener('focus', onVisible)
        }
        return () => {
          if (timer !== null && typeof clearInterval === 'function') clearInterval(timer)
          if (typeof document !== 'undefined' && typeof document.removeEventListener === 'function') {
            document.removeEventListener('visibilitychange', onVisible)
          }
          if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
            window.removeEventListener('focus', onVisible)
          }
        }
      }, [load])

      const detection = status === null ? null : status.detection
      const blockers = detection !== null && Array.isArray(detection.blockers) ? detection.blockers : []
      const notes = detection !== null && Array.isArray(detection.notes) ? detection.notes : []

      const copy = useCallback(() => {
        const text = summaryText(status)
        const done = () => {
          setCopied(true)
          setTimeout(() => setCopied(false), 1600)
        }
        if (typeof navigator !== 'undefined' && navigator.clipboard !== undefined) {
          navigator.clipboard.writeText(text).then(done).catch(() => setError('复制失败：浏览器拒绝了剪贴板写入。'))
        } else {
          setError('复制失败：这个环境没有 navigator.clipboard。')
        }
      }, [status])

      const rows = useMemo(() => ([
        { label: '包管理器', value: describeManager(detection), hint: managerEvidence(detection) },
        { label: '解释器', value: describePython(detection), hint: pythonEvidence(detection) },
        { label: '依赖声明', value: describeGroups(detection), hint: groupsEvidence(detection) },
        { label: '代码检查', value: describeLinters(detection), hint: linterEvidence(detection) },
        { label: '测试', value: describeTests(detection), hint: detection?.linters?.pytest === true ? 'pyproject.toml' : '' },
        { label: '持续集成', value: describeCi(detection), hint: ciEvidence(detection) },
        // Local state, not project config: the hook lives in .git/hooks, so the value
        // cell says prek / 未安装 and the evidence cell says where or how.
        { label: '提交钩子', value: describeHooks(detection), hint: hooksEvidence(detection) },
        { label: '镜像体检', value: describeImageChecks(detection), hint: imageEvidence(detection) },
        { label: '判定置信', value: describeConfidence(detection), hint: '' },
      ]), [detection])

      const degraded = status !== null && status.plugin?.degraded === true
      const versionText = status === null ? '' : 'v' + String(status.plugin?.version ?? '?')
      const statusText = error !== null ? '未连接' : (loading ? '读取中' : (degraded ? '降级' : '已就绪'))
      const statusColor = error !== null ? COLOR.error : (loading ? COLOR.idle : (degraded ? COLOR.warn : COLOR.success))
      const pathText = status === null
        ? (loading ? '正在读取项目…' : '—')
        : String(status.root ?? '（没有可体检的项目目录）')

      const header = React.createElement(
        'header',
        { key: 'header', style: HEADER_STYLE },
        React.createElement(
          'div',
          { key: 'top', style: HEADER_TOP_STYLE },
          React.createElement(
            'div',
            { key: 'titles', style: { minWidth: 0 } },
            React.createElement('h2', { style: TITLE_STYLE }, 'Gatekeeper'),
            React.createElement('div', { style: SUBTITLE_STYLE },
              '三个工具 · 十六份文档 · 13 阶段（8 默认 + 5 可选）' + (versionText === '' ? '' : ' · ' + versionText)),
          ),
          React.createElement(
            'div',
            { key: 'status', style: Object.assign({}, STATUS_STYLE, { color: statusColor }) },
            React.createElement('span', { style: DOT_STYLE }),
            React.createElement('span', null, statusText),
          ),
        ),
        React.createElement(
          'div',
          { key: 'path', style: PATH_STYLE, title: pathText },
          React.createElement('span', { 'aria-hidden': 'true' }, '📁'),
          React.createElement('span', { style: PATH_TEXT_STYLE }, pathText),
        ),
        React.createElement(
          'div',
          { key: 'actions', style: ACTION_BAR_STYLE },
          React.createElement('button', {
            type: 'button',
            style: loading ? Object.assign({}, BUTTON_PRIMARY_STYLE, BUTTON_DISABLED_STYLE) : BUTTON_PRIMARY_STYLE,
            disabled: loading,
            onClick: () => load(true),
          }, loading ? '检测中…' : '重新检测'),
          React.createElement('button', {
            type: 'button',
            style: BUTTON_GHOST_STYLE,
            onClick: copy,
          }, copied ? '已复制' : '复制摘要'),
        ),
      )

      const body = [React.createElement(Intro, {
        key: 'intro',
        open: introOpen,
        onToggle: () => setIntroOpen(!introOpen),
      })]

      // Alerts come before the data: a reader who cannot read the panel, or whose
      // project uv refuses, must not have to scroll past seven green rows first.
      if (error !== null) {
        body.push(React.createElement(
          'div',
          { key: 'error', style: ALERT_STYLE },
          React.createElement('span', { style: ALERT_TITLE_STYLE }, '面板不可用'),
          React.createElement('span', { style: MUTED_STYLE }, error),
          React.createElement('span', { style: MUTED_STYLE }, '三个工具不依赖这个面板，仍然可以正常调用。'),
        ))
      }

      if (degraded) {
        body.push(React.createElement(
          'div',
          { key: 'degraded', style: WARN_BAND_STYLE },
          React.createElement('span', { style: WARN_TITLE_STYLE }, '降级模式'),
          React.createElement('span', { style: MUTED_STYLE },
            '宿主里没有可用的 @deepseek-ai/schemastery：工具按默认配置工作，面板不提供开关。'),
        ))
      }

      if (blockers.length > 0) {
        body.push(React.createElement(
          'div',
          { key: 'blockers', style: ALERT_STYLE },
          React.createElement('span', { style: ALERT_TITLE_STYLE }, 'uv 被拒绝'),
          ...blockers.map((blocker, index) => React.createElement(
            'span',
            { key: 'blocker-' + index, style: MUTED_STYLE },
            blockerText(blocker),
          )),
        ))
      }

      if (error === null && status !== null && detection !== null) {
        // `rows` already carries 持续集成 with its evidence file; a second wide CI cell
        // used to repeat the same value one row below it.
        const stats = rows.map((row) => React.createElement(Stat, { key: row.label, label: row.label, value: row.value, hint: row.hint }))
        body.push(React.createElement(
          Section,
          { key: 'facts', title: '项目体检', hint: '只读' },
          React.createElement('div', { style: GRID_STYLE }, stats),
        ))
      }

      // A missing commit hook is local git state, not a defect in the project, so it
      // gets a band with the one command that fixes it — and only when there is a
      // project to fix.
      if (error === null && detection !== null && detection.gitHooks?.installed !== true) {
        body.push(React.createElement(
          'div',
          { key: 'hooks-hint', style: WARN_BAND_STYLE },
          React.createElement('span', { style: WARN_TITLE_STYLE }, '提交钩子未安装'),
          React.createElement('span', { style: MUTED_STYLE },
            '在项目里跑一次 prek install，提交前的 lint 与密钥扫描才会生效；钩子写在 .git/hooks/，不是项目文件。'),
        ))
      }

      // The jobs the stage selection will end up as. The mapping is the IR's, not the
      // panel's: showing it here is how a reader learns that ticking `release` also
      // means waiting for `quality`'s dist.
      if (status !== null && Array.isArray(status.jobs) && status.jobs.length > 0) {
        const jobs = status.jobs
        body.push(React.createElement(
          Section,
          {
            key: 'jobs',
            title: 'CI 作业',
            hint: 'workflow 里实际的 job 划分；needs 决定谁等谁',
            aside: String(jobs.length) + ' 个',
          },
          React.createElement(
            'ul',
            { style: LIST_STYLE },
            jobs.map((job) => React.createElement(
              Bullet,
              { key: String(job.name), marker: '·' },
              job.name
                + (job.needs.length > 0 ? ' ← ' + job.needs.join(', ') : '')
                + '：' + job.stages.map((stage) => stage.title).join(' · '),
            )),
          ),
        ))
      }

      if (status !== null) {
        const stages = Array.isArray(status.stages) ? status.stages : []
        if (stages.length > 0) {
          const defaults = stages
            .filter((stage) => stage.defaultIncluded === true)
            .map((stage) => String(stage.id))
          const chosen = stagePick === null ? defaults : stagePick
          const toggle = (id) => {
            setStagePick(chosen.indexOf(id) === -1
              ? chosen.concat([id])
              : chosen.filter((entry) => entry !== id))
            setPreview(null)
          }
          const generate = () => {
            const root = typeof status.root === 'string' ? status.root : ''
            if (root === '') {
              setPreview('这个面板还不知道项目路径，先在会话里跑一次 py-audit。')
              return
            }
            setPreviewing(true)
            const url = PREVIEW_ROUTE
              + '?path=' + encodeURIComponent(root)
              + '&stages=' + encodeURIComponent(chosen.join(','))
            fetch(url, { headers: { accept: 'application/json' } })
              .then((response) => {
                if (!response.ok) throw new Error('预览路由返回 ' + response.status)
                return response.json()
              })
              .then((body) => setPreview(body.blocked === true
                ? String(body.reason ?? '这个项目不能用 uv，workflow 没有被渲染。')
                : String(body.yaml ?? '')))
              .catch((cause) => setPreview('无法生成预览：' + String(cause?.message ?? cause)))
              .finally(() => setPreviewing(false))
          }
          body.push(React.createElement(
            Section,
            {
              key: 'stages',
              title: '流水线阶段',
              hint: '点左边加入或移出；选中的阶段就是 workflow 与 scripts/ci.py 里的阶段；小字标出 job、可选与未验证',
              aside: chosen.length + ' / ' + stages.length,
            },
            React.createElement(
              'div',
              { key: 'actions', style: STAGE_ACTIONS_STYLE },
              React.createElement('button', {
                type: 'button',
                style: STAGE_BUTTON_STYLE,
                disabled: previewing === true,
                onClick: generate,
              }, previewing === true ? '生成中…' : '生成 workflow'),
              React.createElement('button', {
                type: 'button',
                style: STAGE_BUTTON_STYLE,
                onClick: () => {
                  setStagePick(null)
                  setPreview(null)
                },
              }, '恢复默认'),
            ),
            React.createElement(
              'ul',
              { key: 'list', style: LIST_STYLE },
              stages.map((stage) => {
                const id = String(stage.id)
                const on = chosen.indexOf(id) !== -1
                const copy = STAGE_TEXT[id] ?? { name: id, line: '' }
                const commands = Array.isArray(stage.commands) ? stage.commands : []
                const showCmds = cmdOpen === id
                return React.createElement(
                  'li',
                  { key: id, style: STAGE_ROW_STYLE },
                  React.createElement('button', {
                    type: 'button',
                    style: on ? STAGE_TOGGLE_ON_STYLE : STAGE_TOGGLE_STYLE,
                    'aria-pressed': on,
                    'aria-label': (on ? '移出 ' : '加入 ') + copy.name,
                    title: on ? '移出本次选择' : '加入本次选择',
                    onClick: () => toggle(id),
                  }, on ? '✓' : '+'),
                  React.createElement('div', { style: STAGE_MAIN_STYLE },
                    React.createElement('div', { style: STAGE_TITLE_ROW_STYLE },
                      React.createElement('span', { style: STAGE_NAME_STYLE }, copy.name),
                      // Three orthogonal facts, each a word: whether a stage is in the
                      // default run, whether it gates a quality decision at all, and
                      // whether this plugin has actually proven it here.
                      stage.optional === true
                        ? React.createElement('span', { style: STAGE_OPT_IN_STYLE }, '可选')
                        : null,
                      stage.kind === 'delivery'
                        ? React.createElement('span', { style: STAGE_OPT_IN_STYLE }, '交付')
                        : null,
                      stage.verified === false
                        ? React.createElement('span', { style: STAGE_OPT_IN_STYLE }, '未验证')
                        : null,
                      // A stage in its own job fails differently: it cannot be mistaken
                      // for a lint failure. `needs` is shown because "release waits for
                      // quality" is the reason its dist is trustworthy.
                      typeof stage.job === 'string' && stage.job !== 'quality'
                        ? React.createElement('span', { style: STAGE_JOB_STYLE },
                          '独立 job：' + stage.job
                          + (Array.isArray(stage.needs) && stage.needs.length > 0
                            ? '（依赖 ' + stage.needs.join(', ') + '）'
                            : ''))
                        : null),
                    React.createElement('span', { style: STAGE_LINE_STYLE }, copy.line),
                    commands.length === 0
                      ? null
                      : React.createElement('button', {
                        type: 'button',
                        style: STAGE_CMDS_STYLE,
                        'aria-expanded': showCmds,
                        onClick: () => setCmdOpen(showCmds ? null : id),
                      }, showCmds
                        ? '收起命令 ▴'
                        : '看命令（' + commands.length + ' 条）▾'),
                    showCmds
                      ? React.createElement('pre', { style: STAGE_CMD_PRE_STYLE }, commands.join('\n'))
                      : null),
                )
              }),
            ),
            preview === null
              ? null
              : React.createElement('pre', { key: 'preview', style: PREVIEW_STYLE }, preview),
          ))
        }
      }

      // The write side, as a checklist: `py-scaffold` targets nine fixed paths, and a
      // reader deciding whether to run it needs to see which of them already exist.
      if (status !== null && Array.isArray(status.applyTargets) && status.applyTargets.length > 0) {
        const targets = status.applyTargets
        const missing = targets.filter((target) => target.present !== true)
        body.push(React.createElement(
          Section,
          {
            key: 'targets',
            title: '生成物',
            hint: 'py-scaffold 会写盘的固定路径 · 不碰你的源码',
            aside: missing.length === 0 ? '齐全' : String(missing.length) + ' 项缺失',
          },
          React.createElement(
            'div',
            { style: { display: 'flex', flexWrap: 'wrap', gap: '4px' } },
            targets.map((target) => React.createElement(
              Badge,
              { key: String(target.id) },
              (target.present === true ? '✓ ' : '✗ ') + String(target.path),
            )),
          ),
        ))
      }

      // The values the pipeline will use, with their source. This is what makes
      // "why 3.12 and not 3.13" answerable without running a dry-run.
      if (status !== null && Array.isArray(status.resolveLines) && status.resolveLines.length > 0) {
        body.push(React.createElement(
          Section,
          {
            key: 'resolved',
            title: '取值解析',
            hint: '每个值从哪来：existing / detected / default —— 面板与 dry-run 看到的是同一份',
            aside: String(status.resolveLines.length) + ' 项',
          },
          React.createElement('pre', {
            key: 'lines',
            style: Object.assign({}, PREVIEW_STYLE, { margin: '6px 0 0', maxHeight: '190px' }),
          }, status.resolveLines.join('\n')),
        ))
      }

      if (notes.length > 0) {
        body.push(React.createElement(
          Section,
          { key: 'notes', title: '备注', hint: String(notes.length) + ' 条' },
          React.createElement(
            'ul',
            { style: LIST_STYLE },
            notes.map((note, index) => React.createElement(
              Bullet,
              { key: 'note-' + index, marker: '·' },
              noteText(note),
            )),
          ),
        ))
      }

      if (status !== null) {
        const settings = status.settings ?? {}
        const tools = settings.tools ?? {}
        const enabled = Object.keys(tools).filter((key) => tools[key] === true)
        const sourceLabels = {
          query: '面板指定的路径',
          detection: '上一次体检',
          session: '会话工作目录',
          none: '无',
        }
        body.push(React.createElement(
          Section,
          { key: 'settings', title: '运行配置', hint: '只读' },
          React.createElement('div', { style: GRID_STYLE },
            React.createElement(Stat, { label: '默认 Python', value: String(settings.defaultPythonVersion ?? '—') }),
            React.createElement(Stat, { label: 'CI 矩阵', value: String(settings.matrixPythonVersions ?? '—') }),
            React.createElement(Stat, { label: 'testpaths', value: String(settings.testPaths ?? '—') }),
            React.createElement(Stat, { label: '数据来源', value: sourceLabels[status.source] ?? String(status.source ?? '无') }),
          ),
          React.createElement(
            'div',
            { style: { display: 'flex', flexWrap: 'wrap', gap: '4px', padding: '8px 0 2px' } },
            enabled.length === 0
              ? React.createElement(Badge, null, '没有启用的工具')
              : enabled.map((name) => React.createElement(Badge, { key: name }, name)),
          ),
          React.createElement(
            'div',
            { style: SESSION_ROW_STYLE },
            React.createElement('span', { style: STAT_LABEL_STYLE }, '跟随会话'),
            React.createElement(
              'select',
              {
                style: SELECT_STYLE,
                value: sessionChoice,
                onChange: (event) => {
                  const next = event?.target?.value ?? AUTO_SESSION
                  setSessionChoice(next)
                  writeStoredSession(next)
                  // The pin changed, so the next read must not reuse the old answer.
                  load(true)
                },
              },
              React.createElement('option', { value: AUTO_SESSION }, '自动（跟随当前会话）'),
              ...(status.sessionList ?? []).map((entry) => React.createElement(
                'option',
                { key: String(entry.id), value: String(entry.id) },
                shortSessionLabel(entry),
              )),
            ),
          ),
          sessionChoice === AUTO_SESSION && status.sessionMatched === false
            ? React.createElement('span', { style: MUTED_STYLE },
              '宿主没有收到「你在看哪个会话」的提示，上面显示的是最近活动的会话。用左边的下拉手动指定一次即可固定。')
            : null,
        ))
      }

      if (status !== null && detection === null) {
        body.push(React.createElement(
          'div',
          { key: 'empty', style: EMPTY_STYLE },
          React.createElement('code', { style: CODE_STYLE }, 'py-audit'),
          React.createElement('span', null, '还没有可体检的目录'),
          React.createElement('span', null, '在任意会话里调用一次 py-audit，这里就会显示那个项目。'),
        ))
      }

      const footer = React.createElement(
        'footer',
        { key: 'footer', style: FOOTER_STYLE },
        React.createElement('span', null,
          typeof status?.recordedAt === 'string' && status.recordedAt !== ''
            ? '更新于 ' + describeUpdatedAt(status.recordedAt) + ' · 自动跟随当前会话目录'
            : '面板只读 · 写盘走 py-scaffold'),
        React.createElement('span', null, '真实能力在三个工具'),
      )

      return React.createElement(
        'div',
        { style: PANEL_STYLE },
        header,
        React.createElement('div', { key: 'body', style: BODY_STYLE }, body),
        footer,
      )
    }

    // ------------------------------------------------------------ 技能包按钮

    /**
     * Insert text at the caret through the composer's input actions. Returns whether
     * the host accepted it. Nothing here touches the DOM directly.
     *
     * The argument order is the host's: `insertText(text, span)`, with the span from
     * `captureInsertion()` (dsh-client-ui-conversation README: "captureInsertion()
     * captures the draft selection and revision; insertText(text, span) inserts one
     * undoable plain-text edit only while that revision is current"). Passing them the
     * other way round is silently rejected, which is exactly how the skill token went
     * missing once already.
     */
    function insertIntoDraft(inputActions, text) {
      try {
        if (inputActions === undefined || inputActions === null) return false
        if (typeof inputActions.captureInsertion !== 'function') return false
        if (typeof inputActions.insertText !== 'function') return false
        const span = inputActions.captureInsertion()
        const accepted = inputActions.insertText(text, span)
        return accepted !== false
      } catch (error) {
        console.warn('gatekeeper: writing into the draft failed', error)
        return false
      }
    }

    /** Best-effort clipboard write; returns whether the browser accepted it. */
    function copyText(text) {
      try {
        if (typeof navigator === 'undefined' || navigator.clipboard === undefined) return false
        if (typeof navigator.clipboard.writeText !== 'function') return false
        navigator.clipboard.writeText(text)
        return true
      } catch {
        return false
      }
    }

    /**
     * The「技能包」picker in the composer's control row.
     *
     * It stays a small control next to the other composer buttons: picking from it is
     * what turns a mode on, and the chip carries that state afterwards.
     */
    /**
     * The「技能包」chip in the composer's control row.
     *
     * It is a control, not a container: it opens the catalog and carries the picked
     * mode. Turning a mode on is what makes the status strip above the card appear.
     */
    // ------------------------------------------------------------ 技能包菜单样式

    /**
     * The dropdown and its companion detail card.
     *
     * One column, three foldable groups. A group bar is a button: folded it is a plain
     * line in an index, unfolded it is a tinted sticky bar over its documents. The
     * detail card appears beside the box on hover, never inside it, so rows keep one
     * height and the list does not jump while the pointer moves.
     */
    // Fixed, not absolute: the composer card and the control row both clip and both
    // create stacking contexts, and a menu that lands under them never appears. The
    // anchor is measured from the pill on open, so the menu still sits on the chip.
    // What every document is *for* inside a pipeline: the stage it governs and the
    // failure it removes. Written from the documents themselves, not from the labels.
    const CI_ROLE = {
      'uv-basics': {
        stage: '每个 job 的地基',
        solves: 'CI 里没有装好的环境。uv 用 lock 文件加缓存，把「本地能跑」和「CI 能跑」变成同一件事，不用在每个 job 里重演依赖解析。',
      },
      'uv-commands': {
        stage: '本地 / CI 命令对照',
        solves: 'CI 里失败的命令必须能在本地原样重跑。这份文档给同一套命令的两种用法，避免出现「CI 红了我本地复现不了」。',
      },
      pyproject: {
        stage: 'lint / test / build 的入口',
        solves: '三个 job 都从 pyproject 读配置。name、version、requires-python 缺一个，问题会拖到 build 阶段才炸。',
      },
      'ruff-config': {
        stage: 'lint（最便宜的一道门禁）',
        solves: '风格、导入顺序、明显逻辑错误在分钟级被挡住，而不是留给 review 或线上。规则选窄了拦不住，选太宽一次淹死人。',
      },
      testing: {
        stage: 'test（行为门禁）',
        solves: '覆盖率门槛把「测试没写」变成一次红色，而不是靠人记得；门槛写在 pyproject，CI 不另存一份。没有门槛的测试 job 只是打印了一份报告。',
      },
      migration: {
        stage: '迁移期的一次性关卡',
        solves: '换工具链时先定布局和 lock 策略。跳过这步，lint 和 CI 可能全绿，构建出来的包却是错的。',
      },
      pep723: {
        stage: '脚本类任务的依赖',
        solves: '单文件脚本在 CI 里要么缺依赖、要么依赖漂移。内联元数据让 uv run script.py 自己把依赖装好。',
      },
      prek: {
        stage: '提交前（省下一轮 CI）',
        solves: '格式、lint、密钥扫描放在提交前，失败一次只要几秒，而不是等 CI 跑完再回来改。',
      },
      security: {
        stage: 'security（密钥扫描）',
        solves: '泄露的密钥 lint 和 test 都看不见，只能靠专门的门禁；依赖 CVE 交给 audit 阶段，workflow 权限交给 13 条静态规则。',
      },
      dependabot: {
        stage: '依赖更新（定时，不在 push 链路上）',
        solves: '依赖不升级等于漏洞长期留存。分组和冷却让升级 PR 不把 review 队列淹没。',
      },
      'ci-design': {
        stage: '整条管线的顺序（13 阶段：8 默认 + 5 可选）',
        solves: '决定要几道门禁、按什么顺序、在哪一步拦。默认八道从便宜到贵排，可选的五道各自需要别的前置（daemon、tag、凭据、网络）。顺序错了，最贵的检查会先跑，反馈反而更慢。',
      },
      'gh-workflow': {
        stage: 'workflow 文件本身',
        solves: '把上面这些门禁固化成 YAML（13 阶段按 job 分组），让每次 push 都跑同一套检查，而不是靠人记得跑。',
      },
      'ci-container': {
        stage: 'container job',
        solves: '镜像构建成功不等于能启动、能连库、以非 root 跑。五道门禁每道只证明一件事；另有 6 项体检只报告，不设上限就永不失败。',
      },
      'ci-pipeline': {
        stage: 'job 结构（单 job 还是拆）',
        solves: '拆 job 要重复准备环境、还要用 artifact 传文件。先单 job，拆分必须写清 needs 和文件怎么过去。',
      },
      'ci-release': {
        stage: 'release job（tag 触发）',
        solves: '发布不可撤回。job 不再重新构建，而是下载 quality 上传的 dist，同一份产物做 provenance、SBOM、GitHub Release——各自证明一件事，缺一个就等于「发布了但说不清发了什么」。',
      },
      'ci-deploy': {
        stage: 'deploy job',
        solves: 'deploy 没有通用命令，模板里的占位命令不替换就会失败。环境、审批与回滚位置是脚手架，探活只在配了 vars.DEPLOY_HEALTH_URL 时才跑。',
      },
    }

    const PANE_STYLE = {
      position: 'relative',
      maxHeight: '300px',
      boxSizing: 'border-box',
      padding: '4px',
      borderRadius: RADIUS.md,
      border: '1px solid ' + COLOR.lineStrong,
      background: COLOR.overlay,
      boxShadow: '0 14px 34px color-mix(in srgb, ' + COLOR.primary + ' 20%, transparent)',
    }

    // The triangle on a box's left edge. It points at the row that opened that box.
    const PANE_ARROW_STYLE = {
      position: 'absolute',
      left: '-6px',
      width: '0',
      height: '0',
      borderTop: '5px solid transparent',
      borderBottom: '5px solid transparent',
      borderRight: '6px solid ' + COLOR.lineStrong,
    }

    // A triangle that grows out of a box's right edge: outline + fill, 1px apart, so it
    // reads as part of the box instead of a shape floating in the gutter.
    function boxArrow() {
      return React.createElement('span', {
        key: 'arrow',
        style: {
          position: 'absolute',
          right: '-6px',
          top: '50%',
          marginTop: '-5px',
          width: '6px',
          height: '10px',
          pointerEvents: 'none',
        },
      },
      React.createElement('span', {
        key: 'outline',
        style: {
          position: 'absolute',
          left: 0,
          top: 0,
          width: '0',
          height: '0',
          borderTop: '5px solid transparent',
          borderBottom: '5px solid transparent',
          borderLeft: '6px solid ' + COLOR.lineStrong,
        },
      }),
      React.createElement('span', {
        key: 'fill',
        style: {
          position: 'absolute',
          left: '1px',
          top: '1px',
          width: '0',
          height: '0',
          borderTop: '4px solid transparent',
          borderBottom: '4px solid transparent',
          borderLeft: '5px solid ' + COLOR.overlay,
        },
      }))
    }

    // Hugs its rows: no fixed width, so a group named `1-uv` does not sit in a box sized
    // for `5-container-and-pipeline`.
    const MENU_LIST_BOX_STYLE = Object.assign({}, PANE_STYLE, {
      display: 'flex',
      flexDirection: 'column',
    })

    // Level two and three, hung off the group box: `right: 100%` puts this row's right
    // edge on the group box's left edge, the padding opens the 6px gutter the arrow sits
    // in, and `translateY(-50%)` centres the whole row on the group box's centre line —
    // the centre of the six group rows it is aligned to.
    const MENU_TAIL_STYLE = {
      position: 'absolute',
      top: '50%',
      right: '100%',
      transform: 'translateY(-50%)',
      display: 'flex',
      flexDirection: 'row-reverse',
      alignItems: 'center',
      gap: '6px',
      paddingRight: '6px',
      boxSizing: 'border-box',
    }

    const MENU_GROUP_STYLE = {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: '6px',
      width: '100%',
      height: '26px',
      boxSizing: 'border-box',
      padding: '0 7px',
      border: 'none',
      borderRadius: RADIUS.sm,
      background: 'transparent',
      color: COLOR.secondary,
      fontFamily: 'inherit',
      fontSize: TEXT.micro,
      textAlign: 'left',
      cursor: 'pointer',
      whiteSpace: 'nowrap',
      overflow: 'hidden',
    }

    const MENU_ROW_STYLE = {
      display: 'flex',
      alignItems: 'center',
      gap: '8px',
      // Sized by its own content, not by the pane: a two-word label and a long token
      // must not share one fixed width, and the box around them hugs the widest row.
      width: 'auto',
      alignSelf: 'flex-start',
      whiteSpace: 'nowrap',
      padding: '6px 9px',
      border: 'none',
      borderRadius: '6px',
      background: 'transparent',
      color: COLOR.primary,
      font: 'inherit',
      fontSize: TEXT.small,
      lineHeight: 1.4,
      textAlign: 'left',
      cursor: 'pointer',
    }

    const MENU_ROW_HOVER_STYLE = Object.assign({}, MENU_ROW_STYLE, {
      background: COLOR.raised,
      boxShadow: 'inset 2px 0 0 ' + COLOR.brand,
    })

    // A viewport dimension, with a sane fallback: a host without a real window (or a
    // test harness with a partial one) must not turn the card's coordinates into NaN.
    function viewportSize(fallback, key) {
      if (typeof window === 'undefined' || window === null) return fallback
      const value = window[key]
      return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
    }

    /**
     * The offset that puts a fixed panel just above its chip.
     *
     * `box` and `target` are viewport rectangles (`getBoundingClientRect`), so this is
     * the one place that knows the difference between where the panel was *told* to go
     * and where it actually landed. A host whose composer establishes a containing
     * block for fixed children (a transformed or `contain`-ed wrapper) answers with a
     * large offset here, and adding it back is what keeps the menu on screen.
     *
     * The unit conversion comes from the rendered width: a border-box panel declared
     * `panelWidth` wide renders that many viewport pixels unless an ancestor is scaled,
     * in which case one style unit is `scale` pixels and the offset must be divided.
     */
    /**
     * How far to move the box, measured instead of assumed.
     *
     * Dividing the wanted distance by the scale implied by the rendered width would only
     * be right while a style unit moves the box by a known amount in a known direction.
     * Neither holds once an ancestor establishes a containing block for `position: fixed`:
     * that ancestor is scaled *and* anchored, so one unit of `bottom` can move the box up
     * by the ancestor's scale — the opposite sign from `top` — and guessing the sign
     * pushes the box twice as far the wrong way. Two probes answer both questions without
     * knowing anything about the host: set the box down by `step`, read where it actually
     * went, and the measured delta is the exact exchange rate for each axis.
     *
     * Returns null when a probe produced no movement (a box that cannot be placed this
     * way, e.g. one whose inline offsets are ignored).
     */
    function placementSolve(now, probed, step, target, viewport, panelWidth) {
      if (now === null || now === undefined) return null
      if (probed === null || probed === undefined) return null
      if (target === null || target === undefined) return null
      if (!(now.width > 0) || !(target.width > 0)) return null
      const unit = typeof step === 'number' && step > 0 ? step : 8
      const width = typeof panelWidth === 'number' && panelWidth > 0 ? panelWidth : 316
      const scale = now.width / width
      const maxLeft = Math.max(8, viewport.width - width * scale - 8)
      const wantedLeft = Math.max(8, Math.min(target.left, maxLeft))
      const wantedBottom = target.top - 6
      const rateX = (probed.left - now.left) / unit
      const rateY = (probed.bottom - now.bottom) / unit
      if (!Number.isFinite(rateX) || !Number.isFinite(rateY)) return null
      if (Math.abs(rateX) < 1e-3 || Math.abs(rateY) < 1e-3) return null
      return {
        dx: (wantedLeft - now.left) / rateX,
        dy: (wantedBottom - now.bottom) / rateY,
        rateX,
        rateY,
      }
    }
    /**
     * Where the arrow sits on the card's border, in the card's own CSS pixels.
     *
     * The arrow is a 12px CSS triangle, so its `top` is the row's centre minus half of
     * that. The clamp is what keeps it from sliding past the card's rounded corners when
     * the card itself had to be pushed away from the row by the viewport edge: a pointer
     * near the bottom of the list would otherwise put the arrow below the card's border.
     *
     * Returns null when the measurement is unusable, so the caller can fall back to a
     * centred arrow instead of drawing one at a guessed coordinate.
     */
    function arrowOffset(rowCenter, cardTop, cardHeight, scale) {
      if (!Number.isFinite(rowCenter) || !Number.isFinite(cardTop)) return null
      if (!Number.isFinite(cardHeight) || !(cardHeight > 0)) return null
      const ratio = Number.isFinite(scale) && scale > 0 ? Math.min(20, Math.max(0.05, scale)) : 1
      const top = (rowCenter - cardTop) / ratio - 6
      const max = Math.max(10, cardHeight / ratio - 22)
      return Math.max(10, Math.min(top, max))
    }
    /**
     * Where the detail card goes, in the layer's own coordinates.
     *
     * Both rectangles come from one measurement pass, so the subtraction is exact: the
     * card lands beside the box without this code having to know where the host's
     * containing block starts. `layer` carries the measured origin plus the scale its
     * width implies, which is what turns viewport pixels back into style units.
     *
     * Returns null when the measurement is unusable, so the caller can skip the card
     * instead of drawing it at a guessed position.
     */
    // The card may shrink below its nominal width when a narrow window leaves no side
    // room; below this it stops being readable and a narrower card no longer helps.
    const MIN_CARD_WIDTH = 200
    function detailOffset(row, layer, viewport, panelWidth, cardWidth) {
      if (row === null || row === undefined) return null
      if (layer === null || layer === undefined) return null
      if (viewport === null || viewport === undefined) return null
      const vw = Number.isFinite(viewport.width) ? viewport.width : 0
      const vh = Number.isFinite(viewport.height) ? viewport.height : 0
      if (!(vw > 0) || !(vh > 0)) return null
      if (!Number.isFinite(row.top)) return null
      const panel = typeof panelWidth === 'number' && panelWidth > 0 ? panelWidth : 316
      const card = typeof cardWidth === 'number' && cardWidth > 0 ? cardWidth : 300
      const ratio = Number.isFinite(layer.scale) && layer.scale > 0 ? layer.scale : 1
      const scale = ratio > 0.05 && ratio < 20 ? ratio : 1
      const left = Number.isFinite(layer.left) ? layer.left : null
      const top = Number.isFinite(layer.top) ? layer.top : null
      const gap = 10
      const anchorLeft = left === null ? 8 : left
      // The side with more room. Clamping to the viewport alone pulled the card back over
      // the box whenever the right side was narrow.
      const roomLeft = Math.max(0, anchorLeft - 8 - gap)
      const roomRight = Math.max(0, vw - (anchorLeft + panel) - 8 - gap)
      const onLeft = roomLeft > roomRight
      // A narrow window leaves no room beside a 300px card. Shrinking it keeps the card
      // beside the box, where it does not cover the rows the pointer is moving between;
      // keeping the full width there was worse than a narrower card.
      const room = onLeft ? roomLeft : roomRight
      const width = room >= MIN_CARD_WIDTH ? Math.min(card, room) : Math.min(card, Math.max(0, vw - 16))
      const wanted = onLeft ? anchorLeft - width - gap : anchorLeft + panel + gap
      const cardLeft = Math.max(8, Math.min(wanted, vw - width - 8))
      const height = Number.isFinite(row.height) && row.height > 0 ? row.height : 28
      const cardTop = Math.max(8, Math.min(row.top + height / 2 - 92, vh - 210))
      return {
        side: onLeft ? 'left' : 'right',
        width,
        left: left === null ? (onLeft ? -width - gap : panel + gap) : (cardLeft - left) / scale,
        top: top === null ? cardTop - row.top : (cardTop - top) / scale,
        // The same target in viewport pixels: the correction pass measures the card where
        // it actually landed and needs the goal in the units the measurement is in.
        viewLeft: cardLeft,
        viewTop: cardTop,
      }
    }
    /** The hover card: floats beside the menu, pinned to the row the pointer is on. */
    // Beside the menu rather than above it, so the arrow can point at the actual row.
    const DETAIL_STYLE = Object.assign({}, PANE_STYLE, {
      width: '300px',
      display: 'flex',
      flexDirection: 'column',
      gap: '6px',
      padding: '10px 12px',
      paddingRight: '14px',
      // No `alignSelf`: the card centres on the same line as the other two boxes. It is
      // capped and scrolls so a long `解决什么` can never grow the band the boxes sit in.
      maxHeight: '230px',
      overflowY: 'auto',
    })

    // The arrow: a filled triangle (plus a hairline one behind it for the outline)
    // pointing at the row the card describes.

    const DETAIL_HEAD_STYLE = {
      display: 'flex',
      alignItems: 'baseline',
      justifyContent: 'space-between',
      gap: '10px',
    }

    const DETAIL_TITLE_STYLE = { fontSize: TEXT.small, fontWeight: 600 }

    const DETAIL_ROWS_STYLE = { display: 'flex', flexDirection: 'column', gap: '5px' }

    const DETAIL_STAGE_STYLE = {
      alignSelf: 'flex-start',
      padding: '1px 7px',
      borderRadius: '999px',
      border: '1px solid ' + COLOR.lineStrong,
      background: 'color-mix(in srgb, ' + COLOR.brand + ' 9%, transparent)',
      fontFamily: MONO,
      fontSize: TEXT.micro,
      color: COLOR.primary,
      whiteSpace: 'nowrap',
    }

    const DETAIL_LABEL_STYLE = {
      width: '64px',
      flexShrink: 0,
      fontSize: TEXT.micro,
      color: COLOR.secondary,
      opacity: 0.9,
    }

    const DETAIL_VALUE_STYLE = {
      fontSize: TEXT.small,
      color: COLOR.primary,
      lineHeight: 1.5,
    }

    /** One labelled line of the card: 主要作用 / 什么时候用 / 产出. */
    function detailRow(label, value) {
      return React.createElement('div', {
        key: label,
        style: { display: 'flex', alignItems: 'flex-start', gap: '8px' },
      },
      React.createElement('span', { style: DETAIL_LABEL_STYLE }, label),
      React.createElement('span', { style: DETAIL_VALUE_STYLE }, value ?? '—'))
    }

    const DETAIL_TOKEN_STYLE = {
      fontFamily: MONO,
      fontSize: TEXT.small,
      color: COLOR.brand,
      wordBreak: 'break-all',
    }

    const DETAIL_TEXT_STYLE = { fontSize: TEXT.small, color: COLOR.secondary, lineHeight: 1.55 }

    const DETAIL_META_STYLE = { fontSize: TEXT.micro, color: COLOR.secondary, opacity: 0.85 }

    // ------------------------------------------------------------ 技能包（一个框）
    //
    // One box, not two panes. A group is a header bar and its documents hang under it,
    // indented, so the hierarchy reads top-to-bottom the way a file tree does. The card
    // is the only thing that appears on hover, and it sits beside the box, never over it.

    /** The group a mode id belongs to, or `null`. */
    function ownerGroupOf(id) {
      if (id === null || id === undefined) return null
      for (const group of MODE_GROUPS) {
        if (group.modes.some((mode) => mode.id === id)) return group
      }
      return null
    }

    /**
     * Which groups start folded.
     *
     * A mode is a lens on one stage of the pipeline, so opening all six at once defeats
     * the point: the user asked for a foldable group list. All folded keeps the box to
     * six one-line bars, and picking a group is one click away.
     */
    function initialFolded() {
      return MODE_GROUPS.map((group) => group.tool)
    }

    function PythonModePicker(props) {
      const inputActions = props === null || props === undefined ? undefined : props.inputActions
      rememberVisibleSession(sessionIdOf(props))
      const selected = useActiveMode()
      const [open, setOpen] = useState(false)
      const [hovered, setHovered] = useState(null)
      const [cursor, setCursor] = useState(-1)
      const [notice, setNotice] = useState(null)
      const [anchor, setAnchor] = useState(null)
      const [rowRect, setRowRect] = useState(null)
      // The box is placed from an estimate, then corrected against what actually
      // rendered (see the layout effect below). This is that correction, in style
      // units: dx moves right, dy moves up.
      const [shift, setShift] = useState({ dx: 0, dy: 0 })
      // The card gets the same treatment for the same reason: whatever the host does to
      // containing blocks, measuring where the card actually landed and moving it to
      // where it is supposed to be is the only step that does not have to guess.
      const [cardShift, setCardShift] = useState({ dx: 0, dy: 0 })
      // null means "not measured yet": the arrow then falls back to the card's middle.
      const [arrowTop, setArrowTop] = useState(null)
      const chipRef = useRef(null)
      const panelRef = useRef(null)
      const layerRef = useRef(null)
      const cardRef = useRef(null)
      const rowElRef = useRef(null)
      const correctionsRef = useRef(0)
      const cardPassesRef = useRef(0)
      // Which groups are folded shut. Three bars that each open on demand keep the box
      // short; sixteen rows at once was the wall the user asked to stop seeing.
      const [folded, setFolded] = useState(() => initialFolded())

      // Opening the menu reveals the group the active mode lives in, so the current
      // choice is visible without hunting for it.
      useEffect(() => {
        if (!open) return
        const owner = ownerGroupOf(selected)
        if (owner === null) return
        setFolded((previous) => previous.filter((tool) => tool !== owner.tool))
      }, [open, selected])

      const toggleGroup = useCallback((skill) => {
        setFolded((previous) => (
          previous.indexOf(skill) < 0
            ? previous.concat([skill])
            : previous.filter((entry) => entry !== skill)
        ))
        setHovered(null)
        setCursor(-1)
      }, [])

      // Only what is on screen is walkable: an arrow key must never land the cursor on
      // a row the user cannot see.
      const shownGroups = MODE_GROUPS.filter((group) => folded.indexOf(group.tool) < 0)
      const flat = []
      for (const group of shownGroups) for (const mode of group.modes) flat.push(mode)

      useEffect(() => {
        if (notice === null) return undefined
        if (typeof setTimeout !== 'function') return undefined
        const timer = setTimeout(() => setNotice(null), 2800)
        return () => {
          if (typeof clearTimeout === 'function') clearTimeout(timer)
        }
      }, [notice])

      // The hovered row's rect, plus the layer's own rect. The card is placed inside the
      // layer, so its offset is `rowTop - layerTop`: two rectangles from the same
      // event-time measurement, both in viewport coordinates, so the subtraction is
      // exact whatever the host does with containing blocks.
      const measure = useCallback((event) => {
        const element = event === null || event === undefined ? null : event.currentTarget
        if (element === null || typeof element.getBoundingClientRect !== 'function') return
        // Kept so the correction pass below can re-read the row instead of trusting a
        // rect that was taken before the box moved.
        rowElRef.current = element
        const rect = element.getBoundingClientRect()
        const panel = panelRef.current
        const box = panel !== null && panel !== undefined && typeof panel.getBoundingClientRect === 'function'
          ? panel.getBoundingClientRect()
          : null
        setRowRect({
          top: Number.isFinite(rect.top) ? rect.top : 0,
          height: Number.isFinite(rect.height) ? rect.height : 28,
          panelTop: box === null || !Number.isFinite(box.top) ? null : box.top,
          panelLeft: box === null || !Number.isFinite(box.left) ? null : box.left,
          // The card's offset is a difference of viewport coordinates, but it is written
          // as a style value inside the layer — so it has to come back out of the
          // ancestor's scale, exactly as the box's own correction does.
          scale: box === null || !Number.isFinite(box.width) || box.width <= 0
            ? 1
            : Math.max(0.05, Math.min(20, box.width / PANEL_WIDTH)),
        })
      }, [])

      const close = useCallback(() => {
        setOpen(false)
        setHovered(null)
        setCursor(-1)
        setShift({ dx: 0, dy: 0 })
      }, [])

      const pick = useCallback((mode) => {
        // The token goes into the draft: the host renders it as an inline chip in the
        // text flow, deletable like text. Deleting that chip turns the mode off (see
        // the editor watch in the picker).
        const token = modeToken(mode)
        setActiveMode(mode.id)
        const written = insertIntoDraft(inputActions, token + ' ')
        setNotice(written
          ? '已开启「' + mode.label + '」，删除输入框里的 ' + mode.id + ' 即关闭'
          : '已开启「' + mode.label + '」（无法写入输入框）')
        setOpen(false)
        setHovered(null)
        setCursor(-1)
        setShift({ dx: 0, dy: 0 })
      }, [inputActions])

      const viewportWidth = viewportSize(1200, 'innerWidth')
      const viewportHeight = viewportSize(800, 'innerHeight')

      // A fresh open starts from the estimate again.
      useLayoutEffect(() => {
        correctionsRef.current = 0
        if (!open) return undefined
        if (typeof window === 'undefined' || window === null) return undefined
        if (typeof window.addEventListener !== 'function') return undefined
        // The chip moves when the window resizes or an ancestor scrolls, and a stale
        // correction would then hold the menu at the wrong distance. Dropping it makes
        // the pass below measure again from the estimate.
        const forget = () => {
          correctionsRef.current = 0
          setShift((previous) => (previous.dx === 0 && previous.dy === 0 ? previous : { dx: 0, dy: 0 }))
        }
        window.addEventListener('resize', forget)
        window.addEventListener('scroll', forget, true)
        return () => {
          window.removeEventListener('resize', forget)
          window.removeEventListener('scroll', forget, true)
        }
      }, [open, anchor])

      // A different row (or a closed menu) is a different card: the offset measured for
      // the last one would otherwise be carried into the next.
      useEffect(() => {
        cardPassesRef.current = 0
        setCardShift((previous) => (previous.dx === 0 && previous.dy === 0 ? previous : { dx: 0, dy: 0 }))
      }, [hovered, open])

      // Placement is decided in CSS units, but `position: fixed` is only the viewport
      // when no ancestor establishes a containing block for fixed children — a
      // transformed or `contain`-ed composer wrapper is one, and the estimate then
      // lands the box outside the window instead of above the capsule. Measuring what
      // actually rendered and correcting the offset keeps placement tied to the chip
      // the user sees, not to the host's private layout. Bounded to three passes, so a
      // host that rescales on every pass still settles.
      useLayoutEffect(() => {
        if (!open) return
        const box = layerRef.current
        const chip = chipRef.current
        if (box === null || box === undefined || chip === null || chip === undefined) return
        if (typeof box.getBoundingClientRect !== 'function') return
        if (typeof chip.getBoundingClientRect !== 'function') return
        if (box.style === null || box.style === undefined) return
        const now = box.getBoundingClientRect()
        const target = chip.getBoundingClientRect()
        const savedLeft = box.style.left
        const savedBottom = box.style.bottom
        const left = Number.parseFloat(savedLeft)
        const bottom = Number.parseFloat(savedBottom)
        if (!Number.isFinite(left) || !Number.isFinite(bottom)) return
        // Probe: shove the box by a known amount and read where it actually went. This is
        // what makes the correction independent of the host's containing block — no
        // assumption about scale, direction, or origin survives being measured away.
        const step = 8
        let solved = null
        try {
          box.style.left = (left + step) + 'px'
          box.style.bottom = (bottom + step) + 'px'
          const probed = box.getBoundingClientRect()
          solved = placementSolve(now, probed, step, target, { width: viewportWidth, height: viewportHeight }, PANEL_WIDTH)
        } finally {
          box.style.left = savedLeft
          box.style.bottom = savedBottom
        }
        if (solved === null) return
        const dx = solved.dx
        const dy = solved.dy
        if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return
        if (correctionsRef.current >= 3) return
        correctionsRef.current = correctionsRef.current + 1
        setShift((previous) => ({ dx: previous.dx + dx, dy: previous.dy + dy }))
      }, [open, anchor, viewportWidth, viewportHeight, shift])

      // The card, corrected the same way and for the same reason. It hangs off the layer,
      // so the estimate above already places it — but an estimate is still an estimate,
      // and this is the pass that turns "next to the row" into "measured to be next to
      // the row". Desired position is read from the layer as it is now, so the two
      // corrections cannot disagree.
      useLayoutEffect(() => {
        if (!open || hovered === null || rowRect === null) return
        const card = cardRef.current
        const panel = panelRef.current
        if (card === null || card === undefined || panel === null || panel === undefined) return
        if (typeof card.getBoundingClientRect !== 'function') return
        if (typeof panel.getBoundingClientRect !== 'function') return
        const box = card.getBoundingClientRect()
        const layerBox = panel.getBoundingClientRect()
        if (!(box.width > 0) || !(layerBox.width > 0)) return
        const scale = Math.max(0.05, Math.min(20, layerBox.width / PANEL_WIDTH))
        // The row is re-read here rather than taken from the hover rect: the box may have
        // moved between the hover and this pass, and the card has to follow the row the
        // pointer is on now.
        const rowEl = rowElRef.current
        const rowBox = rowEl !== null && rowEl !== undefined && typeof rowEl.getBoundingClientRect === 'function'
          ? rowEl.getBoundingClientRect()
          : null
        const rowTop = rowBox !== null && Number.isFinite(rowBox.top) ? rowBox.top : rowRect.top
        const rowHeight = rowBox !== null && Number.isFinite(rowBox.height) && rowBox.height > 0
          ? rowBox.height
          : rowRect.height
        // One decision, one place: the pass that corrects the card asks the same helper that
        // estimated it, so a shrunken card is corrected to where a shrunken card belongs.
        const placed = detailOffset(
          { top: rowTop, height: rowHeight },
          { left: layerBox.left, top: layerBox.top, scale },
          { width: viewportWidth, height: viewportHeight },
          PANEL_WIDTH,
          300,
        )
        if (placed === null) return
        const dx = (placed.viewLeft - box.left) / scale
        const dy = (placed.viewTop - box.top) / scale
        if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return
        if (cardPassesRef.current >= 3) return
        cardPassesRef.current = cardPassesRef.current + 1
        setCardShift((previous) => ({ dx: previous.dx + dx, dy: previous.dy + dy }))
      }, [open, hovered, rowRect, viewportWidth, viewportHeight, cardShift, shift])

      // The arrow follows the row, not the card. Measured on every pass instead of derived
      // from the placement estimate: the card's height depends on its content (and on the
      // max-height clamp), so only the rendered box knows where its borders actually are.
      useLayoutEffect(() => {
        if (!open || hovered === null || rowRect === null) {
          if (arrowTop !== null) setArrowTop(null)
          return
        }
        const card = cardRef.current
        const rowEl = rowElRef.current
        if (card === null || card === undefined || typeof card.getBoundingClientRect !== 'function') return
        if (rowEl === null || rowEl === undefined || typeof rowEl.getBoundingClientRect !== 'function') return
        const box = card.getBoundingClientRect()
        const rowBox = rowEl.getBoundingClientRect()
        const layerBox = panelRef.current === null || panelRef.current === undefined
          ? null
          : panelRef.current.getBoundingClientRect()
        if (!(box.height > 0) || !(rowBox.height > 0)) return
        const scale = layerBox !== null && layerBox.width > 0
          ? Math.max(0.05, Math.min(20, layerBox.width / PANEL_WIDTH))
          : 1
        const next = arrowOffset(rowBox.top + rowBox.height / 2, box.top, box.height, scale)
        if (next === null) return
        if (arrowTop === null || Math.abs(next - arrowTop) > 0.5) setArrowTop(next)
      }, [open, hovered, rowRect, cardShift, shift, arrowTop])

      // Arrow keys walk the flat list, Enter takes the row the keyboard is on, Escape
      // closes. Hover and keyboard share one `hovered` value so the card cannot disagree
      // with the highlight.
      const onKeyDown = (event) => {
        if (event === null || event === undefined) return
        if (event.key === 'Escape') {
          close()
          return
        }
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          if (typeof event.preventDefault === 'function') event.preventDefault()
          if (flat.length === 0) return
          const step = event.key === 'ArrowDown' ? 1 : -1
          const next = cursor < 0
            ? (step > 0 ? 0 : flat.length - 1)
            : (cursor + step + flat.length) % flat.length
          setCursor(next)
          setHovered(flat[next].id)
          return
        }
        if (event.key === 'Enter' && cursor >= 0 && cursor < flat.length) {
          if (typeof event.preventDefault === 'function') event.preventDefault()
          pick(flat[cursor])
        }
      }

      const M_WRAP = { position: 'relative', display: 'inline-flex', alignItems: 'center', maxWidth: '100%' }
      const M_CARET = { fontSize: '9px', color: COLOR.secondary, lineHeight: 1 }
      const M_DOT = {
        width: '5px',
        height: '5px',
        borderRadius: '50%',
        background: 'var(--dsw-alias-state-success-primary)',
        flexShrink: 0,
      }
      const M_CHIP_LABEL = { fontSize: TEXT.small, fontWeight: 600 }
      const M_CHIP_TOKEN = {
        fontFamily: MONO,
        fontSize: TEXT.micro,
        color: COLOR.secondary,
        maxWidth: '150px',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      }
      const M_CLOSE = { cursor: 'pointer', fontSize: TEXT.micro, color: COLOR.secondary, padding: '0 1px' }
      // The box and the detail card hang off one positioned layer. `position: fixed` is
      // what keeps it out of the composer's stacking context — the composer card paints
      // above its own dock, and an absolutely placed menu would be hidden behind it.
      // The layer is what gets `left`/`bottom`; everything inside it is placed relative
      // to that layer, so only ONE element ever has to be corrected against the host's
      // containing block. Placing the card independently meant inverting an unknown
      // origin for a `top`-anchored box inside a `bottom`-anchored one, which is what
      // put the card off screen.
      // The panel's own width lives in one place: the viewport clamp and the card's side
      // both need it, and neither should be allowed to drift from the style.
      const PANEL_WIDTH = 316
      const M_LAYER = {
        position: 'fixed',
        zIndex: 70,
        // The layer must not add width: the clamp arithmetic and the card's side both
        // assume PANEL_WIDTH is the width the user sees.
        width: PANEL_WIDTH + 'px',
        boxSizing: 'border-box',
      }
      const M_PANEL = {
        position: 'relative',
        zIndex: 1,
        // border-box, so PANEL_WIDTH is the width actually on screen. With the default
        // content-box the box was 12px wider than the number the card's placement uses,
        // and the card landed 2px inside the box.
        boxSizing: 'border-box',
        width: PANEL_WIDTH + 'px',
        maxHeight: '380px',
        overflowY: 'auto',
        padding: '6px',
        display: 'flex',
        flexDirection: 'column',
        borderRadius: '10px',
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'var(--dsw-alias-bg-overlay)',
        boxShadow: '0 16px 40px color-mix(in srgb, var(--dsw-alias-label-primary) 22%, transparent)',
        outline: 'none',
      }
      const M_LIST = { display: 'flex', flexDirection: 'column', gap: '1px' }
      // A group is a bar, not a row: tinted, smaller, sticky so the group a document
      // belongs to is still readable after scrolling into a long list. It is a button
      // now — folding is the only way sixteen rows stay readable in one box.
      const M_GROUP = {
        position: 'sticky',
        top: 0,
        zIndex: 1,
        display: 'flex',
        alignItems: 'center',
        gap: '7px',
        width: '100%',
        padding: '6px 9px',
        marginTop: '4px',
        border: 'none',
        borderRadius: '6px',
        background: 'color-mix(in srgb, var(--dsw-alias-brand-primary) 12%, var(--dsw-alias-bg-overlay))',
        fontSize: '11px',
        fontWeight: 600,
        color: COLOR.secondary,
        textAlign: 'left',
        cursor: 'pointer',
      }
      // A folded bar has nothing under it, so it loses the sticky edge and the tint:
      // six shut bars must read as an index, not as six sections.
      const M_GROUP_FOLDED = {
        marginTop: '2px',
        background: 'transparent',
        color: COLOR.primary,
      }
      const M_GROUP_CARET = { fontSize: '9px', width: '9px', flexShrink: 0, opacity: 0.8 }
      const M_GROUP_NAME = { letterSpacing: '0.02em', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }
      const M_GROUP_COUNT = { fontFamily: MONO, fontSize: TEXT.micro, opacity: 0.7, flexShrink: 0 }
      const M_GROUP_NOW = {
        fontFamily: MONO,
        fontSize: TEXT.micro,
        color: COLOR.brand,
        flexShrink: 0,
      }
      // A document is a row: indented under its bar, transparent until the pointer or the
      // keyboard reaches it, so the two levels never look alike.
      const M_ROW = {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: '8px',
        width: '100%',
        padding: '6px 9px 6px 18px',
        border: 'none',
        borderRadius: '6px',
        background: 'transparent',
        color: COLOR.primary,
        fontSize: TEXT.small,
        textAlign: 'left',
        cursor: 'pointer',
      }
      const M_ROW_HOVER = { background: 'color-mix(in srgb, var(--dsw-alias-label-primary) 9%, transparent)' }
      const M_ROW_PICKED = {
        background: 'color-mix(in srgb, var(--dsw-alias-brand-primary) 14%, transparent)',
        color: COLOR.brand,
      }
      const M_LABEL = { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }
      const M_TOKEN = { fontFamily: MONO, fontSize: TEXT.micro, color: COLOR.secondary, flexShrink: 0 }
      const M_CARD = {
        // Inside the layer, not fixed: the layer already sits where the box belongs, so a
        // card anchored to it needs a relative offset and nothing else.
        position: 'absolute',
        zIndex: 2,
        // Same reason as the panel: the placement arithmetic uses the declared 300px,
        // so padding and border must live inside it.
        boxSizing: 'border-box',
        width: '300px',
        padding: '10px 12px',
        display: 'flex',
        flexDirection: 'column',
        gap: '7px',
        borderRadius: '10px',
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'var(--dsw-alias-bg-overlay)',
        boxShadow: '0 14px 34px color-mix(in srgb, var(--dsw-alias-label-primary) 20%, transparent)',
      }
      // No fixed `top`: the arrow slides along the card's side border to land on the row
      // the pointer is on. `arrowOffset()` owns the number.
      const M_TRI = { position: 'absolute', width: 0, height: 0, borderStyle: 'solid' }
      const M_TRI_RIGHT = {
        right: '-6px',
        borderWidth: '6px 0 6px 6px',
        borderColor: 'transparent transparent transparent var(--dsw-alias-border-l2)',
      }
      const M_TRI_LEFT = {
        left: '-6px',
        borderWidth: '6px 6px 6px 0',
        borderColor: 'transparent var(--dsw-alias-border-l2) transparent transparent',
      }
      const M_CARD_HEAD = { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: '8px' }
      const M_CARD_TITLE = { fontSize: TEXT.small, color: COLOR.primary }
      const M_CARD_TOKEN = { fontFamily: MONO, fontSize: TEXT.micro, color: COLOR.brand }
      const M_CARD_STAGE = { fontSize: TEXT.micro, fontWeight: 600, color: COLOR.brand, letterSpacing: '0.02em' }
      const M_CARD_BODY = { display: 'flex', flexDirection: 'column', gap: '5px' }
      const M_CARD_META = { fontSize: TEXT.micro, color: COLOR.secondary, opacity: 0.85 }

      const children = []
      const current = selected === null ? null : modeById(selected)
      const chipChildren = [React.createElement('span', { key: 'caret', style: M_CARET }, open ? '▴' : '▾')]
      if (current === null) {
        chipChildren.push(React.createElement('span', { key: 'label', style: M_CHIP_LABEL }, '技能包'))
      } else {
        chipChildren.push(React.createElement('span', { key: 'dot', style: M_DOT }))
        chipChildren.push(React.createElement('span', { key: 'label', style: M_CHIP_LABEL }, current.label))
        chipChildren.push(React.createElement('span', { key: 'token', style: M_CHIP_TOKEN }, modeToken(current)))
        chipChildren.push(React.createElement('span', {
          key: 'close',
          role: 'button',
          'aria-label': '关闭 ' + current.label,
          style: M_CLOSE,
          onClick: (event) => {
            if (typeof event.stopPropagation === 'function') event.stopPropagation()
            setActiveMode(null)
            setNotice('已关闭「' + current.label + '」')
          },
        }, '✕'))
      }
      children.push(React.createElement('button', {
        key: 'chip',
        type: 'button',
        'data-pt-chip': '',
        ref: chipRef,
        style: CHIP_STYLE,
        'aria-haspopup': 'menu',
        'aria-expanded': open ? 'true' : 'false',
        onClick: (event) => {
          const element = event === null || event === undefined ? null : event.currentTarget
          if (element !== null && typeof element.getBoundingClientRect === 'function') {
            const rect = element.getBoundingClientRect()
            setAnchor({ left: rect.left, bottom: viewportHeight - rect.top + 6 })
          }
          // Each open measures the host's containing block afresh; a stale offset from
          // a previous open (or a resized window) would otherwise be added twice.
          setShift({ dx: 0, dy: 0 })
          setOpen(!open)
          setHovered(null)
          setCursor(-1)
        },
      }, chipChildren))

      if (open) {
        children.push(React.createElement('div', { key: 'backdrop', style: BACKDROP_STYLE, onClick: close }))

        const panelLeft = anchor === null ? 8 : Math.max(8, Math.min(anchor.left, viewportWidth - PANEL_WIDTH - 8))
        // The one element that is positioned against the host's containing block. The
        // correction effect measures the panel (same box as the layer) and moves this.
        const layerStyle = Object.assign({}, M_LAYER, {
          left: (panelLeft + shift.dx) + 'px',
          bottom: ((anchor === null ? 8 : anchor.bottom) + shift.dy) + 'px',
        })
        const panelStyle = M_PANEL

        const rows = []
        for (const group of MODE_GROUPS) {
          const isFolded = folded.indexOf(group.tool) >= 0
          const owner = ownerGroupOf(selected)
          const holdsPick = owner !== null && owner.tool === group.tool
          rows.push(React.createElement('button', {
            key: 'g-' + group.tool,
            type: 'button',
            'data-pt-group': group.tool,
            'data-pt-folded': isFolded ? 'true' : 'false',
            'aria-expanded': isFolded ? 'false' : 'true',
            style: Object.assign({}, M_GROUP, isFolded ? M_GROUP_FOLDED : null),
            onClick: () => toggleGroup(group.tool),
          },
          React.createElement('span', { key: 'caret', style: M_GROUP_CARET }, isFolded ? '▸' : '▾'),
          React.createElement('span', { key: 'name', style: M_GROUP_NAME }, group.label),
          holdsPick && !isFolded
            ? React.createElement('span', { key: 'now', style: M_GROUP_NOW }, '当前')
            : React.createElement('span', { key: 'count', style: M_GROUP_COUNT },
              String(group.modes.length) + ' 项')))
          if (isFolded) continue
          for (const mode of group.modes) {
            const isPicked = selected === mode.id
            const isHovered = hovered === mode.id
            rows.push(React.createElement('button', {
              key: 'm-' + mode.id,
              type: 'button',
              role: 'menuitemradio',
              'aria-checked': isPicked ? 'true' : 'false',
              'data-pt-mode': mode.id,
              style: Object.assign({}, M_ROW, isPicked ? M_ROW_PICKED : (isHovered ? M_ROW_HOVER : null)),
              onMouseEnter: (event) => {
                setHovered(mode.id)
                setCursor(flat.indexOf(mode))
                measure(event)
              },
              onFocus: (event) => {
                setHovered(mode.id)
                setCursor(flat.indexOf(mode))
                measure(event)
              },
              onClick: () => pick(mode),
            },
            React.createElement('span', { key: 'label', style: M_LABEL }, (isPicked ? '✓ ' : '') + mode.label),
            React.createElement('span', { key: 'token', style: M_TOKEN }, modeToken(mode))))
          }
        }

        const layerChildren = [React.createElement('div', {
          key: 'panel',
          'data-pt-panel': '',
          role: 'menu',
          tabIndex: 0,
          ref: panelRef,
          'aria-label': '技能包',
          style: panelStyle,
          onKeyDown: onKeyDown,
        }, React.createElement('div', { key: 'list', 'data-pt-list': '', style: M_LIST }, rows))]

        // The card: hover only, beside the box, centred on the row it describes, clamped
        // to the viewport so it cannot leave the screen on either axis. It hangs off the
        // same layer as the box, so its offset is the difference of two rects measured in
        // one pass — no inverting of an unknown containing-block origin, which is what
        // threw it off screen when it was positioned on its own.
        if (hovered !== null && rowRect !== null) {
          const detail = modeById(hovered)
          if (detail !== null) {
            const owner = MODE_GROUPS.find((entry) => entry.modes.some((mode) => mode.id === detail.id))
            const role = CI_ROLE[detail.id] ?? { stage: '—', solves: detail.task }
            const cardWidth = 300
            const placed = detailOffset(
              rowRect,
              { left: rowRect.panelLeft, top: rowRect.panelTop, scale: rowRect.scale },
              { width: viewportWidth, height: viewportHeight },
              PANEL_WIDTH,
              cardWidth,
            )
            if (placed !== null) {
              const onLeft = placed.side === 'left'
              layerChildren.push(React.createElement('div', {
                key: 'card',
                'data-pt-card': '',
                ref: cardRef,
                style: Object.assign({}, M_CARD, {
                  width: placed.width + 'px',
                  left: (placed.left + cardShift.dx) + 'px',
                  top: (placed.top + cardShift.dy) + 'px',
                }),
              },
              React.createElement('span', {
                key: 'tri',
                'data-pt-tri': '',
                style: Object.assign({}, M_TRI, onLeft ? M_TRI_RIGHT : M_TRI_LEFT, {
                  // Fallback centres it: before the first measurement there is no honest
                  // number, and a centred arrow is the old behaviour rather than a guess.
                  top: (arrowTop === null ? 86 : arrowTop) + 'px',
                }),
              }),
              React.createElement('div', { key: 'head', style: M_CARD_HEAD },
                React.createElement('strong', { key: 'title', style: M_CARD_TITLE }, detail.label),
                React.createElement('span', { key: 'token', style: M_CARD_TOKEN }, modeToken(detail))),
              React.createElement('div', { key: 'stage', style: M_CARD_STAGE }, role.stage),
              React.createElement('div', { key: 'body', style: M_CARD_BODY },
                detailRow('解决什么', role.solves),
                detailRow('产出', detail.gives)),
              React.createElement('div', { key: 'meta', style: M_CARD_META },
                (owner === undefined ? '' : owner.label + ' · ') + '只改建议，不动你的文件')))
            }
          }
        }

        children.push(React.createElement('div', {
          key: 'layer',
          'data-pt-layer': '',
          ref: layerRef,
          style: layerStyle,
        }, layerChildren))
      }

      if (notice !== null) {
        children.push(React.createElement('div', { key: 'toast', style: TOAST_STYLE }, notice))
      }

      return React.createElement('div', { key: 'chipwrap', style: M_WRAP }, children)
    }

    /**
     * The status strip directly above the composer card.
     *
     * This is the part the user asked for: once a mode is on, it is stated where the
     * eye lands before typing, and it can be dismissed without opening the menu. It
     * reads the same store the chip writes, so the two never disagree.
     */
    function PythonModeStatus() {
      const selected = useActiveMode()
      const current = modeById(selected)
      // Hooks first, then the early return: a closed strip leaves no DOM behind.
      if (current === null) return null
      return React.createElement('div', { style: STATUS_DOCK_STYLE },
        React.createElement('div', { style: STATUS_PILL_STYLE },
          React.createElement('span', { style: HEAD_DOT_STYLE }),
          React.createElement('span', { style: STATUS_SLASH_STYLE }, '/'),
          React.createElement('span', { style: STATUS_NAME_STYLE }, modeSkill(current)),
          React.createElement('span', { style: STATUS_HINT_STYLE }, current.hint),
          React.createElement('span', {
            key: 'close',
            role: 'button',
            tabIndex: 0,
            style: STATUS_CLOSE_STYLE,
            title: '关闭 ' + modeToken(current),
            'aria-label': '关闭技能包模式',
            onClick: () => setActiveMode(null),
          }, '✕')))
    }

    // ------------------------------------------------------------------ apply

    /**
     * Mount the rail entry, the panel and the composer chip.
     *
     * This function must never throw: a client half that fails to apply takes its
     * whole bundle's surface with it, and the three tools work without any of this.
     */
    function apply(ctx) {
      try {
        if (ctx.slots === undefined || ctx.slots === null) {
          console.error('gatekeeper: this DSH has no slots service; the panel stays unmounted')
          return
        }
        // Both seats are registered from the innermost callback, exactly as the
        // shipped panels do: the rail entry and the panel it opens appear together
        // or not at all. The callback's return value is the disposer chain.
        ctx.slots.inject('main', () =>
          ctx.slots.inject('sidebar.panellist', () => {
            const stopMain = ctx.slots.register(
              { name: 'main', key: PANEL_ID },
              PythonToolchainPanel,
            )
            const stopIcon = ctx.slots.register(
              { name: 'sidebar.panellist', id: PANEL_ID, order: 55, label: () => 'Gatekeeper' },
              PythonToolchainIcon,
            )
            return () => {
              if (typeof stopIcon === 'function') stopIcon()
              if (typeof stopMain === 'function') stopMain()
            }
          }),
        )
      } catch (error) {
        console.error('gatekeeper: registering the panel failed', error)
      }

      // The picker sits in the composer's control row (`conversation.composer.dock`),
      // next to the other compact buttons.
      //
      // A host without `slots` skips this seat only — never `return`s: the slash
      // source below is registered on `inputTriggers`, which is independent, and an
      // early return used to take the whole slash menu down with it.
      try {
        if (typeof ctx.slots?.inject === 'function') {
          ctx.slots.inject('conversation.composer.dock', () =>
            ctx.slots.register(
              { name: 'conversation.composer.dock', id: MODE_ID, order: 55, label: () => '技能包' },
              PythonModePicker,
            ),
          )
        }
      } catch (error) {
        console.error('gatekeeper: registering the composer mode chip failed', error)
      }

      // The status strip is a seat of its own in the row directly above the card, so
      // an active mode is stated above the input instead of only on the chip.
      try {
        if (typeof ctx.slots?.inject === 'function') {
          ctx.slots.inject('conversation.input.dock', () =>
            ctx.slots.register(
              { name: 'conversation.input.dock', id: MODE_STATUS_ID, order: 55, label: () => '技能包状态' },
              PythonModeStatus,
            ),
          )
        }
      } catch (error) {
        console.error('gatekeeper: registering the composer mode status failed', error)
      }

      // ---------------------------------------------------------- slash source
      //
      // The composer turns `/name` into a chip only when `name` is a member of the
      // live lexicon, and the shipped `ui-skill` source builds that lexicon from a
      // per-session copy of the Host catalog that it fetches lazily. A skill
      // registered by this plugin at mount time can therefore be absent from the
      // copy the editor already holds, and the token stays plain text — the Host
      // catalog is correct, the copy is stale.
      //
      // Declaring our own source fixes that from the inside: the controller
      // concatenates the lexicon of every source on `/`, so these sixteen names
      // are members whether or not the catalog fetch has settled. Nothing is
      // faked — each name is registered with `ctx.skills.register()` on the Host
      // half, so the token the editor chips is a token the Host will load.
      //
      // The source deliberately contributes no menu rows: the shipped skill source
      // already lists these names, and a second group would only duplicate them
      // under an untranslated title. An empty, ready group renders nothing.
      //
      // Mount order matters: `inputTriggers` is provided by a sibling client
      // plugin, so a plain `ctx.get()` at apply time can legitimately return
      // `undefined` (the service is not up yet) and the membership is then lost
      // for the whole session. Injecting instead defers the registration until
      // the service exists and re-runs it if the provider reloads.
      try {
        if (typeof ctx.inject === 'function') {
          ctx.inject(['inputTriggers'], (scope) => {
            try {
              const triggers = scope.inputTriggers
              if (triggers === undefined || triggers === null || typeof triggers.registerSource !== 'function') return
              const source = {
                trigger: '/',
                name: 'gatekeeper',
                order: 3,
                // The host calls `candidates(...).then(...)` — `fetchCandidates` is
                // written against a Promise, so a synchronous array throws
                // "[].then is not a function" and takes the whole slash menu with it.
                candidates: async () => [],
                lexicon: () => MODES.map((mode) => modeSkill(mode)),
              }
              if (typeof scope.effect === 'function') {
                scope.effect(() => triggers.registerSource(source), 'gatekeeper: slash source')
              } else {
                triggers.registerSource(source)
              }
            } catch (error) {
              console.error('gatekeeper: registering the slash source failed', error)
            }
          })
        } else {
          const triggers = typeof ctx.get === 'function' ? ctx.get('inputTriggers') : undefined
          if (triggers !== undefined && triggers !== null && typeof triggers.registerSource === 'function') {
            const source = {
              trigger: '/',
              name: 'gatekeeper',
              order: 3,
              // Promise-returning, like the injected branch above: the host's
              // `fetchCandidates` always calls `.then(...)` on the result.
              candidates: async () => [],
              lexicon: () => MODES.map((mode) => modeSkill(mode)),
            }
            if (typeof ctx.effect === 'function') {
              ctx.effect(() => triggers.registerSource(source), 'gatekeeper: slash source')
            } else {
              triggers.registerSource(source)
            }
          }
        }
      } catch (error) {
        console.error('gatekeeper: registering the slash source failed', error)
      }

    }

    // `slots` is the one service this module needs before it can do anything.
    exports.apply = apply
    exports.inject = ['slots']
    // The placement arithmetic is pure, and the one piece here that a harness can
    // exercise without a DOM; the test suite pins it through this name.
    exports.__placementSolve = placementSolve
    exports.__detailOffset = detailOffset
    exports.__arrowOffset = arrowOffset
    return module.exports
  },
})
