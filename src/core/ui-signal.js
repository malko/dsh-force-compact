/**
 * Live UI status messenger — the plugin-private bridge between the HOST half
 * ("which phase am I in right now?") and the CLIENT half ("replace the official
 * running label's leading phrase with THAT status").
 *
 * Why settings at all
 * ------------------
 * The client half (`web/client.js`) already mirrors the `falling-ts-force-compact`
 * namespace through `configForms.get` → `createSnapshotStore`, so ANY field
 * written by the host here is reflected in the browser live (the `ConfigForm`
 * revision-fencing contract). That is the ONLY sanctioned host→browser live-data
 * channel this independent plugin bundle can use — there is no reverse RPC seam
 * for a client-loaded plugin to expose arbitrary callable methods (the unary
 * route map is closed and host-defined). The `liveUi` field documented below is
 * therefore a PLUGIN-PRIVATE transient messenger: the host is its only writer;
 * the client never writes it; it deliberately persists to `settings.yaml` like
 * every other field of the namespace (harmless cosmetic residue — the worst
 * outcome after a restart is the badge briefly showing a stale phase before the
 * next LLM call overwrites it).
 *
 * Phases
 * ------
 * Every model request begins with a WORKING phase (a random text drawn from
 * {@link WORKING_TEXTS} — the "工作中的状态" set). Around a force-compaction the
 * display is OVERRIDDEN deterministically, not randomly:
 *
 *   • COMPRESSING — pinned `[强制压缩中>>>]`, fired BEFORE the `compactNow` /
 *     `compactRegion` call;
 *   • DONE        — pinned `[压缩完成!]`, fired right AFTER the call
 *     commits; then after `DONE_FALLBACK_MS` (3 s) a forced
 *     `isImportant=true` push redraws a fresh random working status
 *     (single-purpose timer — the only one in this module);
 *   • END         — pinned EMPTY text `""`, fired at the END of a
 *     conversation (the `agent/status` idle transition — hooks/idle.js): a
 *     CLEAR push that restores the official running label (the client half
 *     drops its replacement prefix and puts the harness's own text back).
 *     Replaces the former conversation-START forced working override
 *     (removed 2026-09).
 *
 * A payload carries NO presentation attributes — only `phase`, the canonical
 * zh `text`, and the locale-independent `textId`. The client half substitutes
 * only the official running label's leading phrase ("深度求索中" /
 * "Deep diving...") and leaves the harness's own elapsed-time text, font, and
 * colour untouched.
 *
 * Every published payload carries BOTH a canonical `text` (the Chinese default)
 * and a locale-independent `textId` discriminator: `'working.N'` (index into
 * {@link WORKING_TEXTS}), or the phase name itself for the pinned phases
 * (`'compressing'` / `'done'` / `'end'`). `textId` is the localization seam:
 * the client half (`web/client.js` `paintTurnStatus`) maps it through its own
 * `ctx.locale` zh/en dictionaries, so the badge follows the app language, and
 * falls back to the canonical `text` when `textId` is absent or unresolvable.
 * The host half must stay locale-agnostic — dsh exposes the locale service
 * only to the client web half, not to the host.
 *
 * All writers are GUARANTEED never to throw (they wrap the settings-service
 * write in try/catch): a messenger failure must NEVER disrupt the model
 * request or the compaction transaction itself.
 *
 * @module @falling-ts/dsh-force-compact/ui-signal
 */

import { readRawSetting } from './settings.js'

/** The settings field name carrying the live UI status (host-written, client-read). */
export const LIVE_UI_FIELD = 'liveUi'

/** Phase discriminants. Closed union — consumers switch on exactly these. */
export const PHASE_WORKING = 'working'
export const PHASE_COMPRESSING = 'compressing'
export const PHASE_DONE = 'done'
export const PHASE_END = 'end'

/** Pinned (never randomized) payloads for the deterministic phases. `end` is the EMPTY clear — see {@link publishEnd}. Canonical zh text; the `textId` (== phase) lets the client half translate per app language. */
export const PINNED_TEXTS = Object.freeze({
  [PHASE_COMPRESSING]: '[强制压缩中>>>]',
  [PHASE_DONE]: '[压缩完成!]',
  [PHASE_END]: '',
})

/**
 * The 20 WORKING-phase texts. Deliberately irreverent, meme-flavored one-liners
 * aimed at the agent ITSELF ("正在憋大招" / "正在偷渡灵感" and friends) — the
 * badge talks about what the agent is supposedly up to in a playful voice
 * instead of dry status verbs. Lengths intentionally exceed the old four-char
 * constraint; the client paints the raw string with no width assumption.
 * **No trailing dots**: the client appends the harness's own elapsed-time text
 * directly after the phrase, so an ellipsis would read as "…，用时1分14秒".
 * Canonical zh; index `N` becomes `textId 'working.N'`, which the client half
 * maps to its en/zh dictionaries (`badgeWorking<N>`) so the app-language
 * setting picks the display tongue.
 * @readonly
 */
export const WORKING_TEXTS = Object.freeze([
  '正在酝酿骚操作',
  '正在憋大招',
  '灵感正在路上',
  '脑细胞开会中',
  '灵魂拷问进行中',
  '偷偷翻你底牌',
  '量子纠缠计算中',
  '假装很忙',
  '摸鱼式工作中',
  '疯狂敲键盘(精神上)',
  '正在缝合上下文',
  '正在驯服混沌',
  '正在召唤赛博大脑',
  '正在翻阅《天机》',
  'GPU 正在冒烟',
  '正在跟熵值搏斗',
  '正在画饼给你吃',
  '正在偷渡灵感',
  '正在暗中观察',
  '马上就好(大概)',
])

/**
 * Draw a random working-phase status from {@link WORKING_TEXTS}. Pure — no I/O,
 * trivially testable. The payload carries the canonical zh `text` PLUS the
 * locale-independent `textId 'working.N'` so the client half can render the
 * app-language equivalent.
 * @returns {{phase: string, text: string, textId: string}}
 */
export function randomWorkingStatus() {
  const index = Math.floor(Math.random() * WORKING_TEXTS.length)
  return {
    phase: PHASE_WORKING,
    text: WORKING_TEXTS[index],
    textId: 'working.' + index,
  }
}

/**
 * Build the pinned payload for a deterministic phase (`end` is the empty
 * conversation-END clear). Takes `textId = phase` so the client half can
 * localize the canonical zh `text` per app language.
 * @param {'compressing'|'done'|'end'} phase
 * @returns {{phase: string, text: string, textId: string}}
 */
export function pinnedPayload(phase) {
  return { phase, text: PINNED_TEXTS[phase], textId: phase }
}

/**
 * Publish one UI status onto the `liveUi` field of the `falling-ts-force-compact`
 * namespace. This is THE host→browser delivery point: the client half's
 * `configForms.get` mirror flips its snapshot on the next accepted
 * revision, and the browser component replaces the official running label's
 * leading phrase with it.
 *
 * Guarantees:
 *   • NEVER throws — a settings-service absence or a rejected write is caught
 *     and logged at most once per lifetime (observability only; the model
 *     request and any surrounding compaction transaction proceed untouched).
 *   • Fire-and-forget from the caller's perspective: the returned promise
 *     always settles (resolve on success, resolve-with-warning on failure).
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{phase: string, text: string, textId: string}} status
 * @param {boolean} [isImportant=false] — `true` bypasses the guard entirely
 *   and writes unconditionally. `false` (the default) refuses to overwrite a
 *   currently displayed text that starts with `[` (i.e. a pinned bracket-form
 *   message such as `[强制压缩中>>>]`), returning early without touching
 *   settings.
 * @returns {Promise<void>}
 */
let warnedOnce = false
export async function publishUiStatus(ctx, status, isImportant = false) {
  try {
    const settings = ctx.get('settings')
    if (settings === undefined || typeof settings.update !== 'function') return
    const NS = 'falling-ts-force-compact'
    // Non-important pushes refuse to overwrite a pinned bracket-form text.
    if (!isImportant) {
      let currentText
      try {
        // Harness 0.1.7 removed `settings.get(ns)`; read the live Config ref the
        // plugin was bound with. The gate is purely advisory (worst case: the
        // write proceeds, nothing breaks).
        const liveUi = await readRawSetting(ctx, LIVE_UI_FIELD)
        currentText = (liveUi != null && typeof liveUi === 'object')
          ? liveUi.text
          : (typeof liveUi === 'string' ? liveUi : undefined)
      } catch { /* read failure must not block the important path — fall through */ }
      if (typeof currentText === 'string' && currentText.startsWith('[')) return
    }
    await settings.update(NS, { [LIVE_UI_FIELD]: status })
    if (!warnedOnce) {
      warnedOnce = true
      try {
        ctx.logger.debug(`[force-compact] ui-signal: publishing ${status?.phase} "${status?.text}" textId=${status?.textId} via ${NS}.${LIVE_UI_FIELD}`)
      } catch { /* logging must never propagate */ }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    try {
      ctx.logger.warn(`[force-compact] ui-signal publish failed (ignored, cosmetic only) — ${message}`)
    } catch { /* never */ }
  }
}

/**
 * The host-side driver for one MODEL REQUEST's start moment. Call from the
 * `llm/stream` waterfall (once per outgoing call): draw a fresh random working
 * status and publish it NON-importantly (so a pinned bracket-form text such as
 * `[压缩完成!]` survives the push until its own fallback timer clears it — see
 * {@link publishDone}). A fresh status is also emitted on the 3-second fallback
 * after DONE ({@link DONE_FALLBACK_MS}), firing with `isImportant=true` so it
 * overwrites the DONE banner even though a `[`-prefixed text is on screen.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @returns {Promise<void>}
 */
export async function publishRandomWorking(ctx) {
  await publishUiStatus(ctx, randomWorkingStatus())
}

/**
 * The conversation-END clear: publish the pinned EMPTY text `""` with
 * `isImportant=true`, so it UNCONDITIONALLY overwrites whatever is currently
 * displayed — including a stale pinned bracket-form text such as
 * `[强制压缩中>>>]` left behind by an interrupted/failed compaction, or a
 * lingering random working status (the non-important guard inside
 * {@link publishUiStatus} refuses to overwrite a `[`-prefixed text, so such
 * residue would otherwise stick on the badge).
 *
 * The client's `paintTurnStatus` treats the empty text as a CLEAR: it puts the
 * harness's own running label back and disconnects its DOM observer, so the
 * badge returns to its official appearance until the next liveUi push.
 *
 * Call ONCE at the END of a conversation (the `agent/status` idle transition —
 * see hooks/idle.js, where it runs on EVERY idle exit path: turn-end
 * compaction committed, nothing committed, compaction disabled, no backend).
 * This REPLACES the former conversation-START forced override
 * (`publishWorkingOnStart`, removed 2026-09): the badge is now cleared at
 * conversation end rather than re-primed with a fresh working pair at
 * conversation start.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @returns {Promise<void>}
 */
export async function publishEnd(ctx) {
  await publishUiStatus(ctx, pinnedPayload(PHASE_END), true)
}

/**
 * Publish the pinned "[强制压缩中>>>]" status. Call BEFORE a `compactNow` /
 * `compactRegion` invocation. Passes `isImportant=true` so the pinned
 * bracket-form message can overwrite whatever is currently displayed (including
 * another pinned text).
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @returns {Promise<void>}
 */
export async function publishCompressing(ctx) {
  await publishUiStatus(ctx, pinnedPayload(PHASE_COMPRESSING), true)
}

/**
 * How long after the pinned "[压缩完成!]" DONE banner is published before the
 * forced fallback kicks in and paints a fresh random working status back on
 * the badge (with `isImportant=true`). 3000 ms.
 *
 * Note: this is the plugin's SINGLE-USE TIMER — a deliberate, documented
 * exception to the collection rule "plugins are pure host listeners that do
 * not introduce timers". See the `dsh-force-compact` AGENTS.md deviation note.
 */
const DONE_FALLBACK_MS = 3000

/**
 * Publish the pinned "[压缩完成!]" status. Call AFTER a `compactNow` /
 * `compactRegion` invocation commits. After {@link DONE_FALLBACK_MS} (3 s) a
 * forced fallback (`isImportant=true`) overwrites the DONE banner with a fresh
 * random working status, restoring the usual working appearance regardless
 * of whether a subsequent `llm/stream` fires in the interim. We paint a
 * FRESH random working status (not the literal pre-compression text, which is
 * no longer recoverable from the settings store — it was already overwritten
 * by the COMPRESSING/DONE banners): the intent is "back to a normal working
 * look", which a freshly-drawn working status satisfies.
 *
 * Passes `isImportant=true` for the initial DONE push: reaching `publishDone`
 * PRECEDED BY `publishCompressing`, which has already written the pinned red
 * `[强制压缩中>>>]` bracket-form text. Without `isImportant=true` the gate inside
 * {@link publishUiStatus} (which refuses non-important pushes over a currently
 * displayed `[`-bracket text) would see our OWN still-displayed `compressing`
 * banner and bail out, so the `[压缩完成!]` banner would silently never be written
 * and the 3 s fallback would jump straight from COMPRESSING to a fresh working
 * status — the DONE banner never appearing at all. Since a DONE push can only
 * follow a `compressing` push from THIS plugin, there is no manually-set custom
 * banner to protect, and overriding our own prior banner is exactly intended.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @returns {Promise<void>}
 */
export async function publishDone(ctx) {
  await publishUiStatus(ctx, pinnedPayload(PHASE_DONE), true)
  setTimeout(() => {
    void publishUiStatus(ctx, randomWorkingStatus(), true)
  }, DONE_FALLBACK_MS)
}
