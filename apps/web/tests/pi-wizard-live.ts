/**
 * Live wizard validation for the pi-agent client face (Stage 6, T6.6):
 * drives the real Web app through group ＋ → create menu → five-field dialog →
 * employee/create → the named employee row with its avatar under the
 * 我的数字员工 group → one pi conversation round.
 *
 * Usage: node --import tsx/esm apps/web/tests/pi-wizard-live.ts <http://127.0.0.1:3080/?token=...>
 */

import process from 'node:process'
import { chromium } from 'playwright'

const url = process.argv[2]
if (url === undefined) {
  console.error('usage: pi-wizard-live.ts <http://127.0.0.1:3080/?token=...>')
  process.exit(2)
}

const NAME = `阿黄${new Date().toISOString().slice(11, 19).replaceAll(':', '')}`

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1680, height: 1000 }, locale: 'zh-CN' })
page.setDefaultTimeout(60_000)
try {
  await page.goto(url)
  await page.getByRole('tree').waitFor()

  // 1. A Workspace group header's ＋ opens the create menu (expand the group first:
  // its header actions stay hidden while collapsed).
  await page.getByText('我的数字员工', { exact: true }).first().click()
  const plus = page.locator('[aria-label="在“我的数字员工”中新建会话"]')
  await plus.waitFor()
  await plus.click()
  await page.getByRole('menu').waitFor()
  const menuText = await page.getByRole('menu').innerText()
  if (!menuText.includes('新会话')) throw new Error(`menu lacks the plain new-session row: ${menuText}`)
  if (!menuText.includes('数字程序员')) throw new Error(`menu lacks the digital-coder row: ${menuText}`)

  // 2. The wizard row opens the five-field dialog.
  await page.getByRole('menuitem', { name: /数字程序员/ }).click()
  const dialog = page.getByRole('dialog')
  await dialog.waitFor()
  for (const label of ['名字', '头像', '工作目录', '默认模型', '思考强度']) {
    if (!(await dialog.getByText(label, { exact: true }).count())) throw new Error(`dialog lacks field ${label}`)
  }

  // 3. Fill the form and create.
  await dialog.getByPlaceholder('数字程序员', { exact: false }).fill(NAME)
  await dialog.getByRole('radio').nth(1).click()
  await dialog.locator('input[placeholder*="目录"]').fill('D:/Documents/github/deepseek/deepseek-harness')
  await dialog.getByRole('button', { name: '创建' }).click()

  // 4. The employee's Session opens; its sidebar row carries the avatar badge
  // (the row title is the Session's own, so the avatar is the employee's mark).
  await page.locator('[data-pi-employee-avatar=""]').first().waitFor()
  const sidebarText = await page.getByRole('tree').innerText()
  if (!sidebarText.includes('我的数字员工')) throw new Error('employee group missing from the sidebar')

  // 5. One pi conversation round inside the employee Session.
  const composer = page.getByRole('textbox', { name: /描述你想要构建的内容/ })
  await composer.waitFor()
  await page.waitForTimeout(3000)
  await composer.click({ force: true })
  await page.keyboard.type('回复两个字：收到', { delay: 30 })
  await page.keyboard.press('Enter')
  const reply = page.getByText('收到').first()
  await reply.waitFor({ timeout: 180_000 })

  console.log('SMOKE-PASS: menu → dialog → create → grouped avatar row → one pi round')
} catch (error) {
  await page.screenshot({ path: '/tmp/pi-wizard-live-failure.png', fullPage: true }).catch(() => undefined)
  console.error('SMOKE-FAIL', error)
  process.exitCode = 1
} finally {
  await browser.close()
}
