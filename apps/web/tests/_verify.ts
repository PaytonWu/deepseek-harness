import process from 'node:process'
import { chromium } from 'playwright'
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1680, height: 1000 }, locale: 'zh-CN' })
await page.goto(process.argv[2]!)
await page.waitForTimeout(6000)
await page.getByText('我的数字员工', { exact: true }).first().click()
await page.waitForTimeout(1500)
const tree = await page.getByRole('tree').innerText()
console.log('TREE:', tree.replaceAll('\n', ' | '))
console.log('avatar rows:', await page.locator('[data-pi-employee-avatar=""]').count())
await browser.close()
