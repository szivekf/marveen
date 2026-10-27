// PR #1964 (Telegram approve/reject buttons) rebased onto a develop that has the owner-session rule
// for approving (kanban 80d0e3c6, approvals-approve-owner-only.test.ts).
// The PR's own tests run with NO dashboard login, where the bare token still counts as the owner,
// so they cannot tell whether the rebase kept the two rules apart. Pinned here, with a login present:
//   1. the button endpoint (POST /api/approvals/:id/telegram) is the plugin's, called with the
//      shared token; the callback nonce is what proves the press. It must keep working when a login
//      exists (an owner-session check on it would leave every button dead in a real install);
//   2. that exception is the nonce, nothing else: a wrong nonce decides nothing;
//   3. the reserved owner:telegram: attribution stays off the PATCH, even for the owner session:
//      a dashboard click must not be recorded as a button press.
import { describe, it, expect, vi, afterAll } from 'vitest'
import { spawnSync } from 'node:child_process'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const OWNER_TG = '1000000001'
const sendSpy = vi.hoisted(() => vi.fn(async () => 4242))
vi.mock('../config.js', async (importOriginal) => ({ ...(await importOriginal<typeof import('../config.js')>()), MAIN_AGENT_ID: 'marveen', TELEGRAM_BOT_TOKEN: 'test-token', ALLOWED_CHAT_ID: '1000000001', CHANNEL_PROVIDER: 'telegram' }))
vi.mock('../owner-chat.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../owner-chat.js')>()),
  resolveOwnerChatId: () => '1000000001',
  resolveAlertOwnerChat: () => ({ chatId: '1000000001' }),
}))
vi.mock('../web/telegram.js', async (importOriginal) => ({ ...(await importOriginal<typeof import('../web/telegram.js')>()), sendTelegramMessage: sendSpy }))

import * as db from '../db.js'
import { tryHandleApprovals } from '../web/routes/approvals.js'

const td = mkdtempSync(join(tmpdir(), 'approvals-tg-owner-login-'))
afterAll(() => rmSync(td, { recursive: true, force: true }))
const store = join(td, 'store'); mkdirSync(store, { recursive: true })
writeFileSync(join(store, 'autonomy-config.json'), JSON.stringify({ categories: [{ key: 'email_send', label: 'Email', level: 2, locked: false }] }))
db.initDatabase(join(store, 'claudeclaw.db'))
// A dashboard login exists (the normal state): the bare token is no longer the owner.
// (Looked up by name, so a tree without it fails OL0 with NO-LOGIN instead of an import error.)
const ownerUser = (db as Record<string, any>).createDashboardUser?.('owner', 'x'.repeat(60))

type Auth = { kind: 'token' | 'session'; agent?: string; user?: string }
const TOKEN: Auth = { kind: 'token', agent: 'soma' }
const OWNER: Auth = { kind: 'session', user: 'owner' }
const MSG = 777

const GATE = join(process.cwd(), 'scripts', 'hooks', 'email-approval-gate.py')
let letterNo = 0
function letter() {
  letterNo++
  return { tool_name: 'mcp__claude_ai_Gmail__send_message', tool_input: { to: ['idegen@pelda.hu'], subject: `TG gomb ${letterNo}`, body: `Kedves Ügyfelünk! Ez a(z) ${letterNo}. gombos mérés.` } }
}
function gate(payload: unknown) {
  const r = spawnSync('python3', [GATE], { input: JSON.stringify(payload), env: { ...process.env, EMAIL_APPROVAL_GATE_STORE: store, OUTGOING_COPY_GATE_RULES: join(store, 'no-rules.json') }, encoding: 'utf-8' })
  return { code: r.status, err: r.stderr }
}
function anchorOf(payload: unknown): string {
  const g = gate(payload)
  expect(g.code).toBe(2)
  const a = (g.err.match(/[0-9a-f]{64}/) ?? [])[0]
  expect(a).toBeTruthy()
  return a as string
}

const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex')
const newNonce = () => randomBytes(16).toString('base64url')

// A pending email_send row with its buttons bound, the way the PR's notifier leaves it. Written
// straight to the DB (no POST), so no owner notification runs. The PR's DB helpers are looked up by
// name: on a develop without the PR they are missing, and the test says so instead of a bare
// import error.
function boundRow(contentHash: string) {
  const setHashes = (db as Record<string, unknown>).setApprovalCallbackNonceHashes
  const setMsg = (db as Record<string, unknown>).setApprovalTelegramMessageId
  expect(typeof setHashes, 'NO-1964-DB: setApprovalCallbackNonceHashes is missing (PR #1964 not in this tree)').toBe('function')
  expect(typeof setMsg, 'NO-1964-DB: setApprovalTelegramMessageId is missing (PR #1964 not in this tree)').toBe('function')
  const id = randomUUID()
  db.createApproval({ id, agent_id: 'soma', category: 'email_send', action_description: 'gombos', content_hash: contentHash, timeout_at: Math.floor(Date.now() / 1000) + 600 })
  const nonce = newNonce()
  const rejectNonce = newNonce()
  expect((setHashes as (i: string, h: { approved: string; rejected: string }) => boolean)(id, { approved: sha(nonce), rejected: sha(rejectNonce) })).toBe(true)
  expect((setMsg as (i: string, m: number) => boolean)(id, MSG)).toBe(true)
  return { id, nonce, rejectNonce }
}

async function call(method: 'POST' | 'PATCH', path: string, body: unknown, auth: Auth, headers: Record<string, string> = {}) {
  const out: { status: number; body: any } = { status: 0, body: null }
  const res: any = { writeHead(s: number) { out.status = s; return res }, end(c?: string) { if (c) out.body = JSON.parse(c) } }
  const str = JSON.stringify(body)
  const req: any = { headers, on(ev: string, cb: (c?: Buffer) => void) { if (ev === 'data') cb(Buffer.from(str)); if (ev === 'end') cb() } }
  const url = new URL(`http://localhost${path}`)
  const handled = await tryHandleApprovals({ req, res, path: url.pathname, method, url, auth } as any)
  expect(handled, `NO-1964-ROUTE: ${method} ${url.pathname} is not handled`).toBe(true)
  await new Promise((r) => setImmediate(r))
  return out
}
const press = (id: string, nonce: string | undefined, status: 'approved' | 'rejected' = 'approved', over: Record<string, unknown> = {}) => call('POST', `/api/approvals/${id}/telegram`, {
  status, resolved_by: `owner:telegram:${OWNER_TG}`, telegram_message_id: MSG,
  telegram_chat_id: OWNER_TG, telegram_chat_type: 'private', callback_nonce: nonce, callback_protocol: 1, ...over,
}, TOKEN)

describe('the button endpoint with a dashboard login present (rebased onto develop)', () => {
  it('OL0: a dashboard login exists, so the bare token is not the owner (without it OL1 would prove nothing)', () => {
    expect(ownerUser?.id, 'NO-LOGIN: createDashboardUser is missing or made no user').toBeTruthy()
    expect((db.getDb().prepare('SELECT COUNT(*) AS n FROM dashboard_users').get() as { n: number }).n).toBeGreaterThan(0)
  })

  it('OL1: the plugin press under the shared token with the right nonce approves, and the gate opens for that letter', async () => {
    const p = letter()
    const row = boundRow(anchorOf(p))
    const r = await press(row.id, row.nonce)
    expect(r.status).toBe(200)
    expect(r.body.ok).toBe(true)
    expect(db.getApproval(row.id)?.status).toBe('approved')
    expect(db.getApproval(row.id)?.resolved_by).toBe(`owner:telegram:${OWNER_TG}`)
    expect(gate(p).code).toBe(0)
  })

  it('OL2: the same press with a wrong nonce (or the reject nonce on approve) is 403 bad_nonce; the row stays pending and the gate shut', async () => {
    const p = letter()
    const row = boundRow(anchorOf(p))
    const wrong = await press(row.id, newNonce())
    expect(wrong.status).toBe(403)
    expect(wrong.body.reason).toBe('bad_nonce')
    const crossed = await press(row.id, row.rejectNonce)
    expect(crossed.status).toBe(403)
    expect(crossed.body.reason).toBe('bad_nonce')
    expect(db.getApproval(row.id)?.status).toBe('pending')
    expect(gate(p).code).toBe(2)
  })

  it('OL3: the owner session may not PATCH-approve with the reserved owner:telegram: attribution (400, row stays pending)', async () => {
    const p = letter()
    const id = randomUUID()
    db.createApproval({ id, agent_id: 'soma', category: 'email_send', action_description: 'kattintas', content_hash: anchorOf(p), timeout_at: Math.floor(Date.now() / 1000) + 600 })
    const r = await call('PATCH', `/api/approvals/${id}`, { status: 'approved', resolved_by: `owner:telegram:${OWNER_TG}` }, OWNER)
    expect(r.status).toBe(400)
    expect(db.getApproval(id)?.status).toBe('pending')
    expect(gate(p).code).toBe(2)
  })

  it('OL5: the race, both orders -- exactly one decision wins, and the loser reports no success', async () => {
    // a) the owner decides on the dashboard first; the later button press is 409 already_resolved, ok false
    const p1 = letter()
    const a = boundRow(anchorOf(p1))
    expect((await call('PATCH', `/api/approvals/${a.id}`, { status: 'approved', resolved_by: 'dashboard' }, OWNER)).status).toBe(200)
    const late = await press(a.id, a.nonce)
    expect(late.status).toBe(409)
    expect(late.body.ok).toBe(false)
    expect(late.body.reason).toBe('already_resolved')
    expect(db.getApproval(a.id)?.resolved_by).toBe('dashboard')
    // b) the button decides first; a later dashboard reject is 409 and the row stays approved by the button
    const p2 = letter()
    const b = boundRow(anchorOf(p2))
    expect((await press(b.id, b.nonce)).status).toBe(200)
    expect((await call('PATCH', `/api/approvals/${b.id}`, { status: 'rejected', resolved_by: 'dashboard' }, OWNER)).status).toBe(409)
    expect(db.getApproval(b.id)?.status).toBe('approved')
    expect(db.getApproval(b.id)?.resolved_by).toBe(`owner:telegram:${OWNER_TG}`)
    // c) a second press of the same (spent) button decides nothing
    const again = await press(b.id, b.nonce)
    expect(again.status).toBe(409)
    expect(again.body.ok).toBe(false)
  })

  it('OL6: a right nonce of ANOTHER row decides nothing: 403 bad_nonce, both rows stay pending', async () => {
    const pa = letter(); const pb = letter()
    const a = boundRow(anchorOf(pa))
    const b = boundRow(anchorOf(pb))
    const r = await press(b.id, a.nonce)
    expect(r.status).toBe(403)
    expect(r.body.reason).toBe('bad_nonce')
    expect(db.getApproval(a.id)?.status).toBe('pending')
    expect(db.getApproval(b.id)?.status).toBe('pending')
    expect(gate(pb).code).toBe(2)
  })

  it('OL7: the reject button rejects (200), and the gate stays shut for that letter', async () => {
    const p = letter()
    const row = boundRow(anchorOf(p))
    const r = await press(row.id, row.rejectNonce, 'rejected')
    expect(r.status).toBe(200)
    expect(db.getApproval(row.id)?.status).toBe('rejected')
    expect(gate(p).code).toBe(2)
  })

  it('OL7b: a repeated reject press (the first answer lost) is 409 already_resolved, and its outcome line says rejected, never approved or sendable', async () => {
    const p = letter()
    const row = boundRow(anchorOf(p))
    expect((await press(row.id, row.rejectNonce, 'rejected')).status).toBe(200)
    const again = await press(row.id, row.rejectNonce, 'rejected')
    expect(again.status).toBe(409)
    expect(again.body.ok).toBe(false)
    expect(again.body.reason).toBe('already_resolved')
    expect(again.body.status).toBe('rejected')
    expect(String(again.body.outcome_text ?? '')).not.toMatch(/Jóváhagyva|küldhető/)
    expect(db.getApproval(row.id)?.status).toBe('rejected')
    expect(gate(p).code).toBe(2)
  })

  it('OL8 (INVARIANS): the generic category consume never takes an email_send row (wrong_category), approved or not', async () => {
    const id = randomUUID()
    db.createApproval({ id, agent_id: 'soma', category: 'email_send', action_description: 'generic', content_hash: 'cd'.repeat(32), timeout_at: Math.floor(Date.now() / 1000) + 600 })
    expect((await call('PATCH', `/api/approvals/${id}`, { status: 'approved', resolved_by: 'dashboard' }, OWNER)).status).toBe(200)
    const r = db.consumeCategoryApproval({ id, category: 'email_send', contentHash: 'cd'.repeat(32), consumer: 'test', windowSeconds: 1800 })
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('wrong_category')
    expect(db.getApproval(id)?.consumed_at ?? null).toBeNull()
  })

  it('OL9: the shared token WITHOUT a nonce decides nothing (400 bad_request), the row stays pending and the gate shut', async () => {
    const p = letter()
    const row = boundRow(anchorOf(p))
    const r = await press(row.id, undefined)
    expect(r.status).toBe(400)
    expect(r.body.ok).toBe(false)
    expect(db.getApproval(row.id)?.status).toBe('pending')
    expect(gate(p).code).toBe(2)
  })

  it('OL10: the right nonce after the request expired decides nothing: 409 expired, never approved, the gate shut', async () => {
    const p = letter()
    const row = boundRow(anchorOf(p))
    db.getDb().prepare('UPDATE approvals SET timeout_at = ? WHERE id = ?').run(Math.floor(Date.now() / 1000) - 1, row.id)
    const r = await press(row.id, row.nonce)
    expect(r.status).toBe(409)
    expect(r.body.reason).toBe('expired')
    expect(db.getApproval(row.id)?.status).not.toBe('approved')
    expect(gate(p).code).toBe(2)
  })

  it('OL11: only the owner\'s private chat: a group chat, a chat that is not the presser, and a stranger are 403; the row stays pending', async () => {
    const p = letter()
    const row = boundRow(anchorOf(p))
    const group = await press(row.id, row.nonce, 'approved', { telegram_chat_id: '-1001234567890', telegram_chat_type: 'supergroup' })
    expect(group.status).toBe(403)
    expect(group.body.reason).toBe('chat_mismatch')
    const other = await press(row.id, row.nonce, 'approved', { telegram_chat_id: '3000000003', telegram_chat_type: 'private' })
    expect(other.status).toBe(403)
    expect(other.body.reason).toBe('chat_mismatch')
    const stranger = await press(row.id, row.nonce, 'approved', { resolved_by: 'owner:telegram:2000000002', telegram_chat_id: '2000000002' })
    expect(stranger.status).toBe(403)
    expect(stranger.body.reason).toBe('not_owner')
    expect(db.getApproval(row.id)?.status).toBe('pending')
    expect(gate(p).code).toBe(2)
  })

  it('OL12: the shared-token API (list and single row) never hands out a nonce or its hash', async () => {
    const p = letter()
    const row = boundRow(anchorOf(p))
    const one = await call('GET' as 'POST', `/api/approvals/${row.id}`, undefined, TOKEN)
    const list = await call('GET' as 'POST', '/api/approvals?limit=500', undefined, TOKEN)
    for (const out of [one, list]) {
      const raw = JSON.stringify(out.body)
      expect(out.status === 0 || out.status === 200).toBe(true)
      expect(raw).toContain(row.id)
      for (const secret of [row.nonce, row.rejectNonce, sha(row.nonce), sha(row.rejectNonce)]) expect(raw).not.toContain(secret)
      expect(raw).not.toMatch(/callback_nonce/)
    }
  })

  it('OL4 (INVARIANS, 80d0e3c6): the shared token still cannot PATCH-approve when a login exists (403 owner_session_required)', async () => {
    const id = randomUUID()
    db.createApproval({ id, agent_id: 'soma', category: 'email_send', action_description: 'token', content_hash: 'ab'.repeat(32), timeout_at: Math.floor(Date.now() / 1000) + 600 })
    const r = await call('PATCH', `/api/approvals/${id}`, { status: 'approved', resolved_by: 'dashboard' }, TOKEN)
    expect(r.status).toBe(403)
    expect(r.body.code).toBe('owner_session_required')
    expect(db.getApproval(id)?.status).toBe('pending')
  })
})
