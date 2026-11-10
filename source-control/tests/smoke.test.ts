import { expect, test } from 'claude-code/testing'

test('the module loads', async $ => {
  expect(typeof $.ui.mount).toBe('function')
})
