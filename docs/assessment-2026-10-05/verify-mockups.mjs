import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'
import process from 'node:process'
import console from 'node:console'

const require = createRequire(import.meta.url)
const { chromium } = require('C:/Users/Hp/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')
const browser = await chromium.launch({ headless: true, channel: 'msedge' })
const page = await browser.newPage()
const errors = []
page.on('pageerror', error => errors.push(error.message))
try {
  await page.goto(pathToFileURL(process.cwd() + '/docs/assessment-2026-10-05/mockup-preview.html').href)
  const frame = page.frameLocator('iframe')
  await frame.locator('#oc-directions').waitFor()
  const names = ['Copper Focus', 'Obsidian Studio', 'Plum Collective']
  for (const width of [1024, 736, 360, 320]) {
    await page.setViewportSize({ width: width + 32, height: 1200 })
    for (const name of names) {
      await frame.locator('#oc-directions').evaluate((root, selected) => {
        root.querySelectorAll('[data-variant]').forEach(section => { section.hidden = section.dataset.variant !== selected })
      }, name)
      const section = frame.locator(`[data-variant="${name}"]`)
      const overflow = await section.evaluate(root => {
        const stage = root.getBoundingClientRect()
        return [...root.querySelectorAll('*')].filter(element => {
          const rect = element.getBoundingClientRect()
          return rect.width > 0 && rect.height > 0 && (rect.right > stage.right + 2 || rect.left < stage.left - 2)
        }).map(element => ({ tag: element.tagName, className: String(element.className), text: element.textContent.slice(0, 60) }))
      })
      assert.deepEqual(overflow, [], `${name} overflows at ${width}: ${JSON.stringify(overflow)}`)
      if (width === 1024) {
        await section.locator('.oc-window').screenshot({ path: `docs/assessment-2026-10-05/${name.toLowerCase().replaceAll(' ', '-')}.png` })
      }
      console.log(`PASS: ${name} fits ${width}px without horizontal overflow`)
    }
  }
  await page.setViewportSize({ width: 1056, height: 1200 })
  const first = frame.locator('[data-variant="Copper Focus"]')
  await frame.locator('#oc-directions').evaluate(root => {
    root.querySelectorAll('[data-variant]').forEach(section => { section.hidden = section.dataset.variant !== 'Copper Focus' })
  })
  await first.locator('details').click()
  await first.getByLabel('Follow-up task').fill('Check keyboard focus')
  await first.getByRole('button', { name: 'Continue', exact: true }).click()
  await first.locator('.oc-local-status').filter({ hasText: 'Check keyboard focus' }).waitFor()
  await first.getByLabel('PROJECT AUTONOMY').selectOption('Read only')
  await first.locator('.oc-local-status').filter({ hasText: 'Read only' }).waitFor()
  assert.deepEqual(errors, [])
  console.log('PASS: route disclosure, composer, project policy, and JavaScript error checks')
} finally {
  await browser.close()
}
