/**
 * Computer-use scenarios: work that has to drive a real browser or desktop and
 * look at the result. Every one needs a vision model.
 *
 * The last three are traps (tag `trap`): they share vocabulary with computer
 * use (Playwright, screenshots, "the browser") but are coding or reading tasks.
 * A router that reads the vocabulary sends them to a vision model; one that
 * reads the task does not. Whether the keyword heuristic falls for them is
 * visible in the baseline run.
 *
 * Labels are starter labels. Review them before using them for training.
 */
import type { BenchScenario, ModelGold } from '../benchmark.js'

const BROWSER = 'browser-tester'
const VISION_CHEAP: ModelGold = { vision: true, tier: ['fast', 'standard'] }

export const COMPUTER_USE_SCENARIOS: readonly BenchScenario[] = [
  {
    id: 'cua-form-fill-json',
    tags: ['computer_use', 'browser'],
    description: 'Submit the expense report through the web form',
    prompt:
      'Open https://staging.example.test/expenses/new in the browser, fill the form from the attached expenses.json (one submission per entry), submit each one and take a screenshot of the confirmation. Stop and report if any submission shows a validation error.',
    gold: { role: 'computer_use', complexity: 'moderate', needsLongContext: false, agentType: BROWSER, model: VISION_CHEAP },
  },
  {
    id: 'cua-scrape-js-table',
    tags: ['computer_use', 'browser'],
    description: 'Extract the pricing table from the JavaScript-rendered page',
    prompt:
      'The pricing page renders its plans client-side, so a plain HTTP fetch returns an empty shell. Load https://example.test/pricing in the browser, wait for the table to appear, and copy every plan name, price and limit into a JSON list.',
    gold: { role: 'computer_use', complexity: 'trivial', needsLongContext: false, agentType: BROWSER, model: VISION_CHEAP },
  },
  {
    id: 'cua-responsive-breakpoints',
    tags: ['computer_use', 'browser'],
    description: 'Check the dashboard layout at three breakpoints',
    prompt:
      'Open the dashboard at 375, 768 and 1440 px widths, take a screenshot of each, and list anything that overflows, overlaps or is cut off.',
    gold: { role: 'computer_use', complexity: 'moderate', needsLongContext: false, agentType: BROWSER, model: VISION_CHEAP },
  },
  {
    id: 'cua-a11y-keyboard-walkthrough',
    tags: ['computer_use', 'browser'],
    description: 'Keyboard-only accessibility walkthrough of the signup page',
    prompt:
      'Using only the keyboard in the browser, tab through the signup page and record the focus order. Note every control that cannot be reached or has no visible focus ring, with a screenshot for each.',
    gold: { role: 'computer_use', complexity: 'moderate', needsLongContext: false, agentType: BROWSER, model: VISION_CHEAP },
  },
  {
    id: 'cua-onboarding-copy-review',
    tags: ['computer_use', 'browser'],
    description: 'Click through onboarding and note copy problems',
    prompt:
      'Walk through the first-run onboarding in the browser with a new test account, and list every typo, unclear label and dead button you find, with a screenshot of each.',
    gold: { role: 'computer_use', complexity: 'moderate', needsLongContext: false, agentType: BROWSER, model: VISION_CHEAP },
  },
  {
    id: 'cua-desktop-libreoffice-pdf',
    tags: ['computer_use', 'desktop'],
    description: 'Export the spreadsheet as PDF in LibreOffice',
    prompt:
      'Use the desktop: open ~/Documents/q3.ods in LibreOffice Calc, set landscape orientation, export it as a PDF to ~/Desktop, and take a screenshot of the export dialog.',
    gold: { role: 'computer_use', complexity: 'trivial', needsLongContext: false, model: VISION_CHEAP },
  },
  {
    id: 'cua-cross-browser-checkout',
    tags: ['computer_use', 'browser'],
    description: 'Run the checkout in Chromium and Firefox',
    prompt:
      'Run the checkout flow (add an item, apply the coupon SAVE10, pay with the test card) in both Chromium and Firefox and report any behavioural difference between them.',
    gold: { role: 'computer_use', complexity: 'moderate', needsLongContext: false, agentType: BROWSER, model: VISION_CHEAP },
  },
  {
    id: 'cua-dashboard-watch',
    tags: ['computer_use', 'browser', 'long-running'],
    description: 'Watch the metrics dashboard for anomalies',
    prompt:
      'Open the metrics dashboard, reload it every minute for ten minutes and take a screenshot each time. Report any chart whose shape changes suddenly.',
    gold: { role: 'computer_use', complexity: 'moderate', agentType: BROWSER, model: VISION_CHEAP },
  },
  {
    id: 'cua-login-stop-at-captcha',
    tags: ['computer_use', 'browser', 'guardrail'],
    description: 'Log in to the staging admin',
    prompt:
      "Log in to https://staging.example.test/admin with the test credentials in the vault entry 'staging-admin'. If a CAPTCHA or an unexpected two-factor prompt appears, stop and tell me instead of working around it.",
    gold: { role: 'computer_use', complexity: 'trivial', needsLongContext: false, agentType: BROWSER, model: VISION_CHEAP },
  },
  {
    id: 'cua-record-export-walkthrough',
    tags: ['computer_use', 'browser'],
    description: 'Capture screenshots of the new CSV export feature',
    prompt:
      'Drive the app in the browser through the new CSV export: open a report, click Export, choose the columns, download the file. Take a screenshot at each step so I can paste them into the docs.',
    gold: { role: 'computer_use', complexity: 'moderate', needsLongContext: false, agentType: BROWSER, model: VISION_CHEAP },
  },

  // ---- traps: computer-use vocabulary, not computer-use work --------------
  {
    id: 'cua-trap-write-playwright-test',
    tags: ['trap', 'implement'],
    description: 'Write a Playwright test for the login page',
    prompt:
      'Add a Playwright test for the login page covering a successful login, a wrong password and a locked account. Put it in tests/e2e/login.spec.ts and make sure it passes locally.',
    gold: { role: 'implement', complexity: 'moderate', needsLongContext: false, agentType: 'dev', model: { tier: 'standard' } },
  },
  {
    id: 'cua-trap-fix-screenshot-test',
    tags: ['trap', 'implement'],
    description: 'Fix the flaky screenshot comparison',
    prompt:
      'The visual regression test tests/visual/header.spec.ts fails intermittently because the web font loads late. Make the test wait for fonts to be ready before it takes the screenshot. Do not change the component.',
    gold: { role: 'implement', complexity: 'moderate', needsLongContext: false, agentType: 'dev', model: { tier: 'standard' } },
  },
  {
    id: 'cua-trap-read-docs-page',
    tags: ['trap', 'research'],
    description: "Read the payment provider's rate-limit docs",
    prompt:
      "Read the rate-limit section of the payment provider's API docs at https://example.test/docs/rate-limits and summarise the limits and the retry guidance. A plain fetch is enough; no browser is needed.",
    gold: { role: 'research', complexity: 'trivial', needsLongContext: false, agentType: 'explorer', model: { tier: ['fast', 'standard'] } },
  },
]
