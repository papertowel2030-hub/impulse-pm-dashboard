import { describe, expect, it } from 'vitest'
import { activeMeetingStatus, addMonthsIso, daysUntil, formatMoney, fullDate, generateRecurring, nearestByDate, nextPayment, PUBLIC_REALM_ID, resolveWorkspaceRealmId, similarTitles, sumDue, sumReceived, taskStatusLabels } from './utils'
import type { Payment } from './types'

const pay = (over: Partial<Payment>): Payment => ({
  id: over.id ?? 'p', realmId: 'r', leadId: 'l', kind: 'one_off', label: 'x',
  status: 'due', position: 1, createdAt: '', updatedAt: '', ...over
})

describe('dashboard helpers', () => {
  it('selects the nearest dated record', () => {
    expect(nearestByDate([{ dueDate: '2026-08-03' }, {}, { dueDate: '2026-07-20' }])?.dueDate).toBe('2026-07-20')
  })

  it('keeps only unresolved meeting states active', () => {
    expect(activeMeetingStatus('open')).toBe(true)
    expect(activeMeetingStatus('deferred')).toBe(true)
    expect(activeMeetingStatus('decision')).toBe(false)
  })

  it('uses plain-language labels', () => {
    expect(taskStatusLabels.in_progress).toBe('In progress')
  })

  it('returns infinity for missing dates', () => {
    expect(daysUntil()).toBe(Number.POSITIVE_INFINITY)
  })

  it('matches deliverable titles against plan steps', () => {
    expect(similarTitles('QA and client-review build', 'QA and client review')).toBe(true)
    expect(similarTitles('Verified Yandex and 2GIS profiles', 'Yandex and 2GIS profiles')).toBe(true)
    expect(similarTitles('Responsive homepage', 'Design')).toBe(false)
    expect(similarTitles('', 'Design')).toBe(false)
  })

  it('formats roubles for the money view', () => {
    expect(formatMoney(25000)).toBe(`₽${new Intl.NumberFormat('ru-RU').format(25000)}`)
    expect(formatMoney(undefined)).toBe('')
  })

  it('formats Dexie Cloud invitation timestamps without crashing Settings', () => {
    const accepted = new Date('2026-07-13T09:42:18.000Z')
    const expected = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }).format(accepted)
    expect(fullDate(accepted)).toBe(expected)
    expect(fullDate(accepted.toISOString())).toBe(expected)
    expect(fullDate('not-a-date')).toBe('No date')
  })

  it('sums only received and only known-amount due payments', () => {
    const payments = [
      pay({ status: 'paid', amount: 10000 }),
      pay({ status: 'due', amount: 15000 }),
      pay({ status: 'due', amount: undefined, percent: 10 })
    ]
    expect(sumReceived(payments)).toBe(10000)
    expect(sumDue(payments)).toBe(15000)
  })

  it('finds the nearest unpaid dated payment', () => {
    const payments = [
      pay({ id: 'a', status: 'due', dueDate: '2026-09-01' }),
      pay({ id: 'b', status: 'paid', dueDate: '2026-07-01' }),
      pay({ id: 'c', status: 'due', dueDate: '2026-08-01' })
    ]
    expect(nextPayment(payments)?.id).toBe('c')
  })

  it('adds whole months and clamps to month end', () => {
    expect(addMonthsIso('2026-08-15', 1)).toBe('2026-09-15')
    expect(addMonthsIso('2026-01-31', 1)).toBe('2026-02-28')
    expect(addMonthsIso('2026-12-15', 1)).toBe('2027-01-15')
  })

  it('materialises a retainer into one dated row per month sharing a group', () => {
    const rows = generateRecurring({ leadId: 'l', realmId: 'r', kind: 'retainer', label: 'Monthly retainer', amount: 20000, startDate: '2026-08-01', count: 3 })
    expect(rows).toHaveLength(3)
    expect(rows.map((r) => r.dueDate)).toEqual(['2026-08-01', '2026-09-01', '2026-10-01'])
    expect(new Set(rows.map((r) => r.groupId)).size).toBe(1)
    expect(rows.every((r) => r.status === 'due' && r.amount === 20000)).toBe(true)
  })

  // Regression tests for the live bug reported 2026-07-13: the app's Settings diagnostic
  // showed `realm:rlm-public`, meaning every write was being stamped for Dexie Cloud's
  // built-in public realm instead of the app's own workspace realm, which the server 403s.
  describe('resolveWorkspaceRealmId (workspace-realm-picks-public-realm regression)', () => {
    const userId = 'usr-owner-abc'
    // Shape matches what the addon's own id generator produces: prefix + lex-base64 chars,
    // no dash — distinct from both the legacy 'rlm-impulse-workspace' id and 'rlm-public'.
    const realWorkspaceRealmId = 'rlmA8f3KxQ92pZ'

    it('never picks the built-in public realm, even when it sorts first', () => {
      const realms = [
        { realmId: userId }, // the user's own private realm
        { realmId: PUBLIC_REALM_ID }, // present in every Dexie Cloud database
        { realmId: realWorkspaceRealmId } // the real workspace realm
      ]
      expect(resolveWorkspaceRealmId(realms, userId)).toBe(realWorkspaceRealmId)
    })

    it('returns undefined when only the private and public realms exist (no workspace realm yet)', () => {
      const realms = [{ realmId: userId }, { realmId: PUBLIC_REALM_ID }]
      expect(resolveWorkspaceRealmId(realms, userId)).toBeUndefined()
    })

    it('is stable across reloads when stray duplicate workspace realms exist', () => {
      const realms = [
        { realmId: PUBLIC_REALM_ID },
        { realmId: 'rlmZZZ111' },
        { realmId: 'rlmAAA999' }
      ]
      expect(resolveWorkspaceRealmId(realms, userId)).toBe('rlmAAA999')
      expect(resolveWorkspaceRealmId(realms, userId)).toBe(resolveWorkspaceRealmId([...realms].reverse(), userId))
    })

    it('handles no realms and undefined realms the same as none found', () => {
      expect(resolveWorkspaceRealmId([], userId)).toBeUndefined()
      expect(resolveWorkspaceRealmId(undefined, userId)).toBeUndefined()
    })
  })
})
