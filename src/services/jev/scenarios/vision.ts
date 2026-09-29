/**
 * Vision scenarios that are NOT computer use: the task hands the teammate an
 * image and needs a model that can read it, but no browser or desktop is
 * driven.
 *
 * The dispatcher's hard rule is "computer_use needs vision"; for every other
 * role vision is not enforced, and JEV has no question for it. A router that
 * picks a non-vision model for these tasks fails them, so these scenarios
 * measure whether "there is an attached image" reaches the model choice at all.
 * Every gold here requires vision.
 *
 * Labels are starter labels. Review them before using them for training.
 */
import type { BenchScenario } from '../benchmark.js'

export const VISION_SCENARIOS: readonly BenchScenario[] = [
  {
    id: 'vis-diagnose-broken-dashboard',
    tags: ['research', 'vision'],
    description: 'Diagnose the broken dashboard from the screenshot',
    prompt:
      'The attached screenshot (screenshots/dash-broken.png) shows the dashboard after the deploy. Describe what looks wrong and which component is most likely responsible.',
    gold: {
      role: 'research',
      complexity: 'moderate',
      needsLongContext: false,
      agentType: 'explorer',
      model: { vision: true, tier: 'standard' },
    },
  },
  {
    id: 'vis-wireframe-to-component',
    tags: ['implement', 'vision'],
    description: 'Build the component from the wireframe',
    prompt:
      'Implement the React component shown in the attached wireframe (design/settings-panel.png): layout, labels and states, using our existing Button and Toggle components.',
    gold: {
      role: 'implement',
      complexity: 'moderate',
      needsLongContext: false,
      agentType: 'dev',
      model: { vision: true, tier: 'standard' },
    },
  },
  {
    id: 'vis-read-console-photo',
    tags: ['research', 'vision', 'trivial'],
    description: 'Read the error from the photo of the server console',
    prompt:
      'The attached photo of a server console (photos/console.jpg) shows a kernel error. Transcribe the error text and tell me what it means.',
    gold: {
      role: 'research',
      complexity: 'trivial',
      needsLongContext: false,
      agentType: 'explorer',
      model: { vision: true, tier: ['fast', 'standard'] },
    },
  },
  {
    id: 'vis-compare-mockups',
    tags: ['review', 'vision'],
    description: 'Compare the two checkout mockups',
    prompt:
      'Compare design/v1.png and design/v2.png of the checkout page: list every difference in layout, copy and colour, and say which changes might hurt accessibility.',
    gold: {
      role: 'review',
      complexity: 'moderate',
      needsLongContext: false,
      agentType: 'code-reviewer',
      model: { vision: true, tier: 'deep' },
    },
  },
  {
    id: 'vis-extract-chart-values',
    tags: ['research', 'vision'],
    description: 'Extract the values from the chart image',
    prompt:
      'Page 3 of the quarterly PDF is a bar chart saved as reports/q2-p3.png. Extract the approximate value of each bar into a CSV.',
    gold: {
      role: ['research', 'implement'],
      complexity: ['trivial', 'moderate'],
      needsLongContext: false,
      agentType: ['data-analyst', 'explorer'],
      model: { vision: true, tier: ['fast', 'standard'] },
    },
  },
  {
    id: 'vis-diagram-to-docs',
    tags: ['implement', 'vision', 'docs'],
    description: 'Turn the architecture diagram into text',
    prompt:
      'Describe the architecture in the attached diagram (docs/img/arch.png) as text for docs/architecture.md: the components, the arrows, and what each arrow carries.',
    gold: {
      role: 'implement',
      complexity: 'moderate',
      needsLongContext: false,
      agentType: ['tech-writer', 'dev'],
      model: { vision: true, tier: 'standard' },
    },
  },
]
