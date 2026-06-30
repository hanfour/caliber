// packages/db/tests/schemaParity.test.ts
//
// Unit test: asserts that `evaluationReportScoreColumns` (the shared scoring
// column set) is a subset of BOTH `evaluationReports` AND
// `evaluationReportsByKey`. Catches future column drift between the two tables
// without needing a real database.
import { describe, it, expect } from 'vitest'
import { evaluationReports } from '../src/schema/evaluationReports.js'
import {
  evaluationReportsByKey,
  evaluationReportScoreColumns,
} from '../src/schema/evaluationReportsByKey.js'

describe('evaluationReportScoreColumns parity', () => {
  const sharedKeys = Object.keys(evaluationReportScoreColumns)

  it('shared keys are a subset of evaluationReports columns', () => {
    const reportCols = Object.keys(evaluationReports)
    for (const key of sharedKeys) {
      expect(reportCols, `evaluationReports is missing shared column: ${key}`).toContain(key)
    }
  })

  it('shared keys are a subset of evaluationReportsByKey columns', () => {
    const byKeyCols = Object.keys(evaluationReportsByKey)
    for (const key of sharedKeys) {
      expect(byKeyCols, `evaluationReportsByKey is missing shared column: ${key}`).toContain(key)
    }
  })

  it('evaluationReportsByKey has the per-key extra columns', () => {
    const byKeyCols = Object.keys(evaluationReportsByKey)
    expect(byKeyCols).toContain('apiKeyId')
    expect(byKeyCols).toContain('keyNameSnapshot')
  })
})
