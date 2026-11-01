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
  await page.getByLabel(/Started on/).fill(daysAgo(28))
  await page.getByRole('button', { name: /add plant/i }).click()
  await expect(page.getByRole('button', { name: 'Open Kitchen Monstera' }).last()).toBeVisible()
  const plants = await (await page.request.get('/api/plants')).json()
  const id = Math.max(
    ...plants
      .filter((plant: { nickname: string }) => plant.nickname === 'Kitchen Monstera')
      .map((plant: { id: number }) => plant.id),
  )
  expect(plants.find((plant: { id: number }) => plant.id === id).started_on).toBe(daysAgo(28))
  const watering = await page.request.post(`/api/plants/${id}/waterings`, {
    data: { care_date: daysAgo(14) },
  })
  expect(watering.ok()).toBeTruthy()
  await page.goto('/')
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

test('keeps notes, photos, and watering actions tied to the selected day', async ({ page }) => {
  await page.goto('/')
  const dashboard = await (await page.request.get('/api/dashboard')).json()
  const activeDate = dashboard.server_date as string
  const nickname = `Daily records ${Date.now()}`
  const created = await page.request.post('/api/plants', {
    data: { species: 'Monstera deliciosa', nickname },
  })
  expect(created.ok()).toBeTruthy()
  await page.reload()

  const card = page.locator('article.plant-card').filter({
    has: page.getByRole('button', { name: `Open ${nickname}` }),
  })
  await card.getByRole('button', { name: `Add note for ${nickname} on ${activeDate}` }).click()
  const editor = page.getByRole('dialog', { name: nickname })
  const note = editor.getByRole('textbox', { name: `Note for ${nickname} on ${activeDate}` })
  await expect(note).toBeVisible()
  await expect(editor.locator('input[type="date"]')).toHaveCount(0)
  await note.fill('A note for the selected day.')
  await editor.getByRole('button', { name: 'Save' }).click()
  await expect(card.getByRole('button', { name: `Edit note for ${nickname} on ${activeDate}` })).toHaveAttribute('aria-pressed', 'true')

  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p6kAAAAASUVORK5CYII=',
    'base64',
  )
  const photoInput = card.locator('input[type="file"]')
  await photoInput.setInputFiles({ name: 'leaf.png', mimeType: 'image/png', buffer: png })
  await expect(card.getByRole('button', { name: `Add photo for ${nickname} on ${activeDate}; 1 saved` })).toBeVisible()
  await photoInput.setInputFiles({ name: 'leaf-again.png', mimeType: 'image/png', buffer: png })
  await expect(card.getByRole('button', { name: `Add photo for ${nickname} on ${activeDate}; 2 saved` })).toBeVisible()

  await card.getByRole('button', { name: 'Watered' }).click()
  await expect(card.getByRole('button', { name: 'Undo' })).toBeVisible()
  await card.getByRole('button', { name: 'Undo' }).click()
  await expect(card.getByRole('button', { name: 'Watered' })).toBeVisible()

  await page.getByRole('button', { name: 'Previous day' }).click()
  const previousDate = await (await page.request.get('/api/config')).json().then((config) => {
    const date = new Date(`${config.today}T12:00:00Z`)
    date.setUTCDate(date.getUTCDate() - 1)
    return date.toISOString().slice(0, 10)
  })
  await expect(card.getByRole('button', { name: `Add note for ${nickname} on ${previousDate}` })).toBeVisible()
  await card.getByRole('button', { name: `Add note for ${nickname} on ${previousDate}` }).click()
  const previousEditor = page.getByRole('dialog', { name: nickname })
  await previousEditor.getByRole('textbox', { name: `Note for ${nickname} on ${previousDate}` }).fill('A separate note from yesterday.')
  await previousEditor.getByRole('button', { name: 'Save' }).click()

  await page.getByRole('button', { name: 'Next day' }).click()
  await card.getByRole('button', { name: `Open ${nickname}` }).click()
  await page.getByRole('button', { name: 'Plant notebook' }).click()
  await expect(page.getByText('A note for the selected day.')).toBeVisible()
  await expect(page.getByText('A separate note from yesterday.')).toBeVisible()
  await page.evaluate(() => window.scrollTo(0, 0))
  await page.getByRole('button', { name: 'Plant photos' }).click()
  const dayLabel = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(`${activeDate}T12:00:00`))
  await expect(page.getByRole('button', { name: `View photo from ${dayLabel}` })).toHaveCount(2)
  await page.getByRole('button', { name: `Photo options for ${dayLabel}` }).first().click()
  await page.getByRole('menuitem', { name: 'Set as profile photo' }).click()
  const plants = await (await page.request.get('/api/plants')).json()
  const current = plants.find((plant: { nickname: string }) => plant.nickname === nickname)
  expect(current.profile_photo_source_id).toEqual(expect.any(Number))

  await page.getByRole('button', { name: 'Plant photos' }).click()
  await page.evaluate(() => window.scrollTo(0, 0))
  await page.getByRole('button', { name: 'Edit plant' }).click()
  await page.getByRole('button', { name: 'Choose profile photo' }).click()
  await page.getByLabel('Plant profile photo').setInputFiles({ name: 'new-profile.png', mimeType: 'image/png', buffer: png })
  await expect(page.getByText('new-profile.png')).toBeVisible()
  const profileUpload = page.waitForResponse((response) => response.url().includes('/profile-photo') && response.request().method() === 'PUT')
  await page.getByRole('button', { name: 'Save changes' }).click()
  expect((await profileUpload).ok()).toBeTruthy()
  const updated = await (await page.request.get('/api/plants')).json()
  expect(updated.find((plant: { nickname: string }) => plant.nickname === nickname).profile_photo_source_id).toBeNull()
})

test('reordering cards requires a press and hold on the drag handle', async ({ page }) => {
  await page.goto('/')
  const existing = await (await page.request.get('/api/plants')).json()
  for (const plant of existing) await page.request.post(`/api/plants/${plant.id}/archive`)
  const create = async (name: string) => {
    const response = await page.request.post('/api/plants', { data: { species: name, nickname: name } })
    expect(response.ok()).toBeTruthy()
  }
  const suffix = Date.now()
  await create(`Hold first ${suffix}`)
  await create(`Hold second ${suffix}`)
  await page.goto('/')
  const first = page.locator('article.plant-card').filter({ has: page.getByRole('button', { name: `Open Hold first ${suffix}` }) })
  const second = page.locator('article.plant-card').filter({ has: page.getByRole('button', { name: `Open Hold second ${suffix}` }) })
  const order = async () => page.locator('.card-main').evaluateAll((buttons) => buttons.map((button) => button.getAttribute('aria-label')))
  const handle = first.getByRole('button', { name: `Reorder Hold first ${suffix}` })
  const source = await handle.boundingBox()
  const target = await second.boundingBox()
  if (!source || !target) throw new Error('Plant cards are not visible for reordering.')

  await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2)
  await page.mouse.down()
  await page.waitForTimeout(100)
  await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2)
  await page.mouse.up()
  let currentOrder = await order()
  expect(currentOrder.indexOf(`Open Hold first ${suffix}`)).toBeLessThan(currentOrder.indexOf(`Open Hold second ${suffix}`))

  await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2)
  await page.mouse.down()
  await page.waitForTimeout(500)
  await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 8 })
  await page.mouse.up()
  currentOrder = await order()
  expect(currentOrder.indexOf(`Open Hold second ${suffix}`)).toBeLessThan(currentOrder.indexOf(`Open Hold first ${suffix}`))
})
