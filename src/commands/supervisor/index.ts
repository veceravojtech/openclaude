import type { Command } from '../../commands.js'

export default {
  type: 'local',
  name: 'supervisor',
  description:
    'Supervisor mode: delegate work to teammates instead of doing it yourself',
  argumentHint: '[on|off|strict|soft]',
  supportsNonInteractive: true,
  load: () => import('./supervisor.js'),
} satisfies Command
