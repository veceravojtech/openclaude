import { c as _c } from "react-compiler-runtime";
import * as React from 'react';
import { Box, Text } from '../ink.js';
import { type AppState, useAppState } from '../state/AppState.js';
import { getViewedTeammateTask } from '../state/selectors.js';
import { getRegisteredAgentName } from '../state/teammateViewHelpers.js';
import { getSubLeadPath } from '../tasks/InProcessTeammateTask/InProcessTeammateTask.js';
import type { LocalAgentTaskState } from '../tasks/LocalAgentTask/LocalAgentTask.js';
import { getAgentColor } from '../tools/AgentTool/agentColorManager.js';
import { toInkColor } from '../utils/ink.js';
import { KeyboardShortcutHint } from './design-system/KeyboardShortcutHint.js';
import { OffscreenFreeze } from './OffscreenFreeze.js';

/**
 * Header shown when viewing a teammate's transcript.
 * Displays teammate name (colored), task description, and exit hint.
 *
 * Also covers a viewed local_agent (opened from the /tasks dialog or the agent
 * panel). Those are not InProcessTeammates, so getViewedTeammateTask misses
 * them and the header used to render nothing at all. Their handle comes from
 * the shared getRegisteredAgentName reverse lookup; with no registered name the
 * description stands in for the handle — unprefixed, because a description is
 * not a handle — and is not repeated on the detail line.
 *
 * A viewed teammate is named by its path down the team tree —
 * `team-lead › supervisor › worker-1`: the root lead, then one segment per
 * sub-lead above it (getSubLeadPath), then its own name. A member of the root
 * team is therefore `team-lead › supervisor`, which is what makes the sub-team
 * a teammate belongs to readable from the header alone.
 *
 * Hand-maintained react-compiler output: slots 0-13 plus 26-27 (both appended
 * later, at the end of the array) are the teammate branch, 14-25 the local-agent
 * branch. Renumber and re-audit if you add a memoized value.
 */
export function TeammateViewHeader() {
  const $ = _c(28);
  const viewedTeammate = useAppState(_temp);
  const viewedAgent = useAppState(_temp2);
  const agentNameRegistry = useAppState(_temp3);
  if (viewedTeammate) {
    let t0;
    if ($[0] !== viewedTeammate.identity.color) {
      t0 = toInkColor(viewedTeammate.identity.color);
      $[0] = viewedTeammate.identity.color;
      $[1] = t0;
    } else {
      t0 = $[1];
    }
    const nameColor = t0;
    let t1;
    if ($[2] === Symbol.for("react.memo_cache_sentinel")) {
      t1 = <Text>Viewing </Text>;
      $[2] = t1;
    } else {
      t1 = $[2];
    }
    // Ancestors dimmed, the teammate's own name in its colour: the whole line
    // reads as one path, and the agent still stands out in it.
    const ancestors = [ROOT_LEAD_LABEL, ...getSubLeadPath(viewedTeammate.identity.teamName)].map(_temp4).join("");
    let t2;
    if ($[3] !== nameColor || $[4] !== viewedTeammate.identity.agentName || $[27] !== ancestors) {
      t2 = <><Text dimColor={true}>{ancestors}</Text><Text color={nameColor} bold={true}>{viewedTeammate.identity.agentName}</Text></>;
      $[3] = nameColor;
      $[4] = viewedTeammate.identity.agentName;
      $[27] = ancestors;
      $[5] = t2;
    } else {
      t2 = $[5];
    }
    let t3;
    // Escape interrupts a busy teammate's turn and returns from an idle one
    // (useBackgroundTaskNavigation), so the hint follows the idle flag.
    if ($[6] !== viewedTeammate.isIdle) {
      t3 = <Text dimColor={true}>{" \xB7 "}<KeyboardShortcutHint shortcut="esc" action={viewedTeammate.isIdle ? "return" : "interrupt, esc again to return"} /></Text>;
      $[6] = viewedTeammate.isIdle;
      $[26] = t3;
    } else {
      t3 = $[26];
    }
    let t4;
    if ($[7] !== t2) {
      t4 = <Box>{t1}{t2}{t3}</Box>;
      $[7] = t2;
      $[8] = t4;
    } else {
      t4 = $[8];
    }
    let t5;
    if ($[9] !== viewedTeammate.prompt) {
      t5 = <Text dimColor={true}>{viewedTeammate.prompt}</Text>;
      $[9] = viewedTeammate.prompt;
      $[10] = t5;
    } else {
      t5 = $[10];
    }
    let t6;
    if ($[11] !== t4 || $[12] !== t5) {
      t6 = <OffscreenFreeze><Box flexDirection="column" marginBottom={1}>{t4}{t5}</Box></OffscreenFreeze>;
      $[11] = t4;
      $[12] = t5;
      $[13] = t6;
    } else {
      t6 = $[13];
    }
    return t6;
  }
  if (viewedAgent) {
    const agentName = getRegisteredAgentName({
      agentNameRegistry
    }, viewedAgent.id);
    const label = agentName === undefined ? viewedAgent.description : `@${agentName}`;
    // Without a registered name the label above already IS the description —
    // fall back to it here only when the handle occupies the first line, so the
    // two lines never render the same string twice.
    const detail = viewedAgent.prompt || (agentName === undefined ? undefined : viewedAgent.description);
    let t7;
    if ($[14] === Symbol.for("react.memo_cache_sentinel")) {
      t7 = <Text>Viewing </Text>;
      $[14] = t7;
    } else {
      t7 = $[14];
    }
    let t8;
    if ($[15] !== label || $[16] !== viewedAgent.agentType) {
      // getAgentColor returns a theme key already — never route it through
      // toInkColor, which would turn it into the bogus `ansi:<themeKey>`.
      t8 = <Text color={getAgentColor(viewedAgent.agentType) ?? "cyan_FOR_SUBAGENTS_ONLY"} bold={true}>{label}</Text>;
      $[15] = label;
      $[16] = viewedAgent.agentType;
      $[17] = t8;
    } else {
      t8 = $[17];
    }
    let t9;
    if ($[18] === Symbol.for("react.memo_cache_sentinel")) {
      t9 = <Text dimColor={true}>{" \xB7 "}<KeyboardShortcutHint shortcut="esc" action="return" /></Text>;
      $[18] = t9;
    } else {
      t9 = $[18];
    }
    let t10;
    if ($[19] !== t8) {
      t10 = <Box>{t7}{t8}{t9}</Box>;
      $[19] = t8;
      $[20] = t10;
    } else {
      t10 = $[20];
    }
    let t11;
    if ($[21] !== detail) {
      t11 = detail === undefined ? null : <Text dimColor={true}>{detail}</Text>;
      $[21] = detail;
      $[22] = t11;
    } else {
      t11 = $[22];
    }
    let t12;
    if ($[23] !== t10 || $[24] !== t11) {
      t12 = <OffscreenFreeze><Box flexDirection="column" marginBottom={1}>{t10}{t11}</Box></OffscreenFreeze>;
      $[23] = t10;
      $[24] = t11;
      $[25] = t12;
    } else {
      t12 = $[25];
    }
    return t12;
  }
  return null;
}
/** The lead of the root team, as the spinner tree also labels it. */
const ROOT_LEAD_LABEL = 'team-lead';
const PATH_SEPARATOR = ' \u203A ';
function _temp4(segment: string) {
  return `${segment}${PATH_SEPARATOR}`;
}
function _temp(s: AppState) {
  return getViewedTeammateTask(s);
}
function _temp2(s: AppState): LocalAgentTaskState | undefined {
  // Granular and reference-stable: returns the task object itself, never a
  // freshly allocated wrapper the way getActiveAgentForInput does.
  const id = s.viewingAgentTaskId;
  if (!id) {
    return undefined;
  }
  const task = s.tasks[id];
  return task?.type === 'local_agent' ? task : undefined;
}
function _temp3(s: AppState) {
  return s.agentNameRegistry;
}
