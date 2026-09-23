import { expect, test } from '@playwright/test'

test('adds a pot and defers its next check', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'Add plant' }).click()
  await page.getByLabel('Species').fill('Monstera deliciosa')
  await page.getByLabel(/Nickname/).fill('Kitchen Monstera')
  await page.getByRole('button', { name: /add plant/i }).click()
  await expect(page.getByRole('button', { name: 'Open Kitchen Monstera' }).first()).toBeVisible()
  await page.getByRole('button', { name: 'Not watered', exact: true }).first().click()
  await page.getByRole('button', { name: 'In 2 days', exact: true }).click()
  await expect(page.getByText(/will be checked again/i)).toBeVisible()
})
