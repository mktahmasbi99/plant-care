import { expect, test } from '@playwright/test'

test('adds a plant and records a Monday round watering', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: /add your first plant/i }).click()
  await page.getByLabel('Species').fill('Monstera deliciosa')
  await page.getByLabel(/Nickname/).fill('Kitchen Monstera')
  await page.getByRole('button', { name: /add plant/i }).click()
  await expect(page.getByRole('button', { name: 'Open Kitchen Monstera' }).first()).toBeVisible()
  await page.getByRole('button', { name: 'Watered', exact: true }).first().click()
  await expect(page.getByText(/marked watered/i)).toBeVisible()
})
