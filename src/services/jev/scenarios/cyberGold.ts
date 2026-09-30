/**
 * Model golds for cyber mode, named by their place in the cyber policy rather
 * than by model id, so a label keeps meaning the same thing if the policy's
 * models change (`CYBER_MODELS` in utils/model/cyber.ts).
 *
 * The policy (docs/cyber-mode.md): review and verify go to the lead, easy work
 * to the cheap model, hard work and design to the worker.
 */
import { CYBER_MODELS } from '../../../utils/model/cyber.js'
import type { ModelGold } from '../benchmark.js'

/** Review and verify. */
export const CYBER_LEAD: ModelGold = { anyOf: [CYBER_MODELS.lead] }
/** Easy and moderate implementation and research. */
export const CYBER_EASY: ModelGold = { anyOf: [CYBER_MODELS.easy] }
/** Hard work and design. */
export const CYBER_WORKER: ModelGold = { anyOf: [CYBER_MODELS.worker] }
/** A review whose implementer already runs on the lead's family: any other. */
export const CYBER_NOT_LEAD: ModelGold = { anyOf: [CYBER_MODELS.worker, CYBER_MODELS.easy] }
