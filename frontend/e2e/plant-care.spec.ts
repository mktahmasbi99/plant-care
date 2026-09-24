import { expect, test } from '@playwright/test'

test('brand returns to Today from every page', async ({ page }) => {
  await page.goto('/')
  const brand = page.getByRole('button', { name: 'Go to Today' })
  const today = page.getByRole('heading', { name: 'Today' })

  await page.getByRole('button', { name: 'Settings' }).click()
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Install app' })).toBeVisible()
  await brand.click()
  await expect(today).toBeVisible()

  await page.getByRole('button', { name: 'Fertilizer' }).click()
  await expect(page.getByRole('heading', { name: 'Fertilizer', exact: true })).toBeVisible()
  await brand.click()
  await expect(today).toBeVisible()

  await page.getByRole('button', { name: 'Add plant' }).click()
  await expect(page.getByRole('heading', { name: 'Add plant' })).toBeVisible()
  await brand.click()
  await expect(today).toBeVisible()

  const plantName = `Logo navigation ${Date.now()}`
  await page.getByRole('button', { name: 'Add plant' }).click()
  await page.getByLabel('Species').fill(plantName)
  await page.getByRole('button', { name: /add plant/i }).last().click()
  await page.getByRole('button', { name: `Open ${plantName}` }).click()
  await expect(page.getByRole('heading', { name: plantName, level: 1 })).toBeVisible()
  await brand.click()
  await expect(today).toBeVisible()
})

test('adds a pot and snoozes its learned watering signal', async ({ page }) => {
  await page.goto('/')
  const dashboard = await (await page.request.get('/api/dashboard')).json()
  const daysAgo = (days: number) => {
    const value = new Date(`${dashboard.server_date}T12:00:00Z`)
    value.setUTCDate(value.getUTCDate() - days)
    return value.toISOString().slice(0, 10)
  }
  await page.getByRole('button', { name: 'Add plant' }).click()
  await page.getByLabel('Species').fill('Monstera deliciosa')
  await page.getByLabel(/Nickname/).fill('Kitchen Monstera')
  await page.getByLabel(/Last watered/).fill(daysAgo(28))
  await page.getByRole('button', { name: /add plant/i }).click()
  await expect(page.getByRole('button', { name: 'Open Kitchen Monstera' }).last()).toBeVisible()
  const plants = await (await page.request.get('/api/plants')).json()
  const id = Math.max(
    ...plants
      .filter((plant: { nickname: string }) => plant.nickname === 'Kitchen Monstera')
      .map((plant: { id: number }) => plant.id),
  )
  const watering = await page.request.post(`/api/plants/${id}/waterings`, {
    data: { care_date: daysAgo(14) },
  })
  expect(watering.ok()).toBeTruthy()
  await page.reload()
  const card = page
    .locator('article.plant-card')
    .filter({ has: page.getByRole('button', { name: 'Open Kitchen Monstera' }) })
    .last()
  await expect(card.getByText('Around the usual interval')).toBeVisible()
  await expect(card.getByRole('button', { name: 'Not watered' })).toHaveCount(0)
  await card.getByRole('button', { name: 'Snooze' }).click()
  await page.getByRole('button', { name: 'In 2 days', exact: true }).click()
  await expect(card.getByText(/Snoozed until/)).toBeVisible()
})
