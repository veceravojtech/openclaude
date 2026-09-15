import type { Command } from '../../commands.js'

const account = {
  type: 'local-jsx',
  name: 'account',
  description: 'List, switch, add or remove Claude accounts',
  argumentHint: '[add | remove <email> | <email>]',
  load: () => import('./account.js'),
} satisfies Command

export default account
