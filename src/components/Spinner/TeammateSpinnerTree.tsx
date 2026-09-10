import { c as _c } from "react-compiler-runtime";
import figures from 'figures';
import * as React from 'react';
import { Box, Text, type TextProps } from '../../ink.js';
import { useAppState } from '../../state/AppState.js';
import { getRunningTeammatesSorted } from '../../tasks/InProcessTeammateTask/InProcessTeammateTask.js';
import type { TeammateSelection } from '../../tasks/InProcessTeammateTask/teammateSelection.js';
import { formatNumber } from '../../utils/format.js';
import { getParentTeamName, getTeamDepth } from '../../utils/swarm/teamHelpers.js';
import { TeammateSpinnerLine } from './TeammateSpinnerLine.js';
import { TEAMMATE_SELECT_HINT } from './teammateSelectHint.js';
type Props = {
  /**
   * Which row is selected, keyed by task id — never a position. A row leaving
   * or arriving no longer re-points this at a different teammate, which is the
   * whole reason the positional selectedIndex it replaced was hard to use.
   */
  selection?: TeammateSelection | null;
  isInSelectionMode?: boolean;
  allIdle?: boolean;
  /** Leader's active verb (when leader is actively processing) */
  leaderVerb?: string;
  /** Leader's token count (when leader is actively processing) */
  leaderTokenCount?: number;
  /** Leader's idle status text (when leader is idle, e.g. "✻ Idle for 3s") */
  leaderIdleText?: string;
};
/** Columns of indent per level of sub-team below the root team. */
const SUB_TEAM_INDENT = 2;
export function TeammateSpinnerTree(t0) {
  const $ = _c(61);
  const {
    selection,
    isInSelectionMode,
    allIdle,
    leaderVerb,
    leaderTokenCount,
    leaderIdleText
  } = t0;
  const tasks = useAppState(_temp);
  const viewingAgentTaskId = useAppState(_temp2);
  const showTeammateMessagePreview = useAppState(_temp3);
  let T0;
  let isHideSelected;
  let t1;
  let t2;
  let t3;
  let t4;
  let t5;
  if ($[0] !== allIdle || $[1] !== isInSelectionMode || $[2] !== leaderIdleText || $[3] !== leaderTokenCount || $[4] !== leaderVerb || $[5] !== selection || $[6] !== showTeammateMessagePreview || $[7] !== tasks || $[8] !== viewingAgentTaskId) {
    t5 = Symbol.for("react.early_return_sentinel");
    bb0: {
      // Every row the tree draws: running teammates plus the ones still inside
      // their 30s grace window, in the one shared depth-first order.
      const teammateTasks = getRunningTeammatesSorted(tasks);
      // NO early return any more. The tree used to answer `null` here at zero
      // rows, which is what made it vanish the moment the last teammate ended;
      // the panel that owns the mount (TeammateTreePanel) is the only gate now,
      // and at zero rows this renders the team-lead row plus one muted line.
      // The early-return sentinel above and its slot ($[15]) are kept exactly as
      // the compiler emitted them rather than renumbering all 61 slots — the same
      // trade U8 made for the unused slot 9 in BackgroundTaskStatus.
      const isLeaderForegrounded = viewingAgentTaskId === undefined;
      const isLeaderSelected = isInSelectionMode && selection?.kind === "leader";
      const isLeaderHighlighted = isLeaderForegrounded || isLeaderSelected;
      isHideSelected = isInSelectionMode === true && selection?.kind === "hide";
      T0 = Box;
      t1 = "column";
      t2 = 1;
      const t6 = isLeaderSelected ? "suggestion" : undefined;
      const t7 = isLeaderSelected ? figures.pointer : " ";
      let t8;
      if ($[16] !== isLeaderHighlighted || $[17] !== t6 || $[18] !== t7) {
        t8 = <Text color={t6} bold={isLeaderHighlighted}>{t7}</Text>;
        $[16] = isLeaderHighlighted;
        $[17] = t6;
        $[18] = t7;
        $[19] = t8;
      } else {
        t8 = $[19];
      }
      const t9 = !isLeaderHighlighted;
      const t10 = isLeaderHighlighted ? "\u2552\u2550" : "\u250C\u2500";
      let t11;
      if ($[20] !== isLeaderHighlighted || $[21] !== t10 || $[22] !== t9) {
        t11 = <Text dimColor={t9} bold={isLeaderHighlighted}>{t10}{" "}</Text>;
        $[20] = isLeaderHighlighted;
        $[21] = t10;
        $[22] = t9;
        $[23] = t11;
      } else {
        t11 = $[23];
      }
      const t12 = isLeaderSelected ? "suggestion" : "cyan_FOR_SUBAGENTS_ONLY";
      let t13;
      if ($[24] !== isLeaderHighlighted || $[25] !== t12) {
        t13 = <Text bold={isLeaderHighlighted} color={t12}>team-lead</Text>;
        $[24] = isLeaderHighlighted;
        $[25] = t12;
        $[26] = t13;
      } else {
        t13 = $[26];
      }
      let t14;
      if ($[27] !== isLeaderForegrounded || $[28] !== leaderVerb) {
        t14 = !isLeaderForegrounded && leaderVerb && <Text dimColor={true}>: {leaderVerb}…</Text>;
        $[27] = isLeaderForegrounded;
        $[28] = leaderVerb;
        $[29] = t14;
      } else {
        t14 = $[29];
      }
      let t15;
      if ($[30] !== isLeaderForegrounded || $[31] !== leaderIdleText || $[32] !== leaderVerb) {
        t15 = !isLeaderForegrounded && !leaderVerb && leaderIdleText && <Text dimColor={true}>: {leaderIdleText}</Text>;
        $[30] = isLeaderForegrounded;
        $[31] = leaderIdleText;
        $[32] = leaderVerb;
        $[33] = t15;
      } else {
        t15 = $[33];
      }
      let t16;
      if ($[34] !== isLeaderHighlighted || $[35] !== leaderTokenCount) {
        t16 = leaderTokenCount !== undefined && leaderTokenCount > 0 && <Text dimColor={!isLeaderHighlighted}>{" "}· {formatNumber(leaderTokenCount)} tokens</Text>;
        $[34] = isLeaderHighlighted;
        $[35] = leaderTokenCount;
        $[36] = t16;
      } else {
        t16 = $[36];
      }
      let t17;
      if ($[37] !== isLeaderHighlighted) {
        t17 = isLeaderHighlighted && <Text dimColor={true}> · {TEAMMATE_SELECT_HINT}</Text>;
        $[37] = isLeaderHighlighted;
        $[38] = t17;
      } else {
        t17 = $[38];
      }
      let t18;
      if ($[39] !== isLeaderForegrounded || $[40] !== isLeaderSelected) {
        t18 = isLeaderSelected && !isLeaderForegrounded && <Text dimColor={true}> · enter to view</Text>;
        $[39] = isLeaderForegrounded;
        $[40] = isLeaderSelected;
        $[41] = t18;
      } else {
        t18 = $[41];
      }
      if ($[42] !== t11 || $[43] !== t13 || $[44] !== t14 || $[45] !== t15 || $[46] !== t16 || $[47] !== t17 || $[48] !== t18 || $[49] !== t8) {
        t3 = <Box paddingLeft={3}>{t8}{t11}{t13}{t14}{t15}{t16}{t17}{t18}</Box>;
        $[42] = t11;
        $[43] = t13;
        $[44] = t14;
        $[45] = t15;
        $[46] = t16;
        $[47] = t17;
        $[48] = t18;
        $[49] = t8;
        $[50] = t3;
      } else {
        t3 = $[50];
      }
      // F5: which (name, team) pairs actually have a row, so a sub-team whose
      // lead is gone can be given a placeholder at the lead's own position
      // instead of letting its members nest under the previous root sibling.
      // Derived from the rows themselves — no disk read, no team file.
      const drawnRows = new Set<string>();
      for (const drawn of teammateTasks) {
        drawnRows.add(teamRowKey(drawn.identity.agentName, drawn.identity.teamName));
      }
      // One placeholder per absent lead, however many members it has.
      const placeholderKeys = new Set<string>();
      t4 = teammateTasks.length === 0 ? <EmptyTeammatesRow /> : teammateTasks.map((teammate, index) => {
        // Depth-first order (getRunningTeammatesSorted) already puts a sub-team
        // straight under the teammate that leads it; the indent is what makes
        // that visible. A root-team member renders exactly as before — no
        // wrapper at all, indent 0 — so only nested rows change shape.
        // An identity carrying no team name counts as a root-team member too:
        // getTeamDepth is never asked about it, so an indent can never take the
        // spinner render down. Computed inside this map callback, which the
        // compiler does not memoize, so no cache slot moves.
        const teamName = teammate.identity.teamName;
        const indent = teamName ? (getTeamDepth(teamName) - 1) * SUB_TEAM_INDENT : 0;
        // The line is told its own indent as well as wrapped in it: those
        // columns are spent before the row starts, so they have to come off the
        // row's width budget or a deep row overruns the terminal.
        const line = <TeammateSpinnerLine key={teammate.id} teammate={teammate} isLast={!isInSelectionMode && index === teammateTasks.length - 1} isSelected={isInSelectionMode === true && selection?.kind === "teammate" && selection.taskId === teammate.id} isForegrounded={viewingAgentTaskId === teammate.id} allIdle={allIdle} showPreview={showTeammateMessagePreview} indent={indent} />;
        const row = indent > 0 ? <Box key={teammate.id} paddingLeft={indent}>{line}</Box> : line;
        // Each sub-lead above this row that has no row of its own gets a dimmed
        // `@name · not running` placeholder at ITS indent, outermost first, so
        // the nesting still reads down the real tree. Render-only: a placeholder
        // is never part of getRunningTeammatesSorted: that array is the one every
        // surface agrees on, and a synthetic entry would appear in all of them.
        const absentLeads: React.ReactNode[] = [];
        for (const lead of leadChain(teamName)) {
          const key = teamRowKey(lead.leadName, lead.leadTeam);
          if (drawnRows.has(key) || placeholderKeys.has(key)) {
            continue;
          }
          placeholderKeys.add(key);
          absentLeads.push(<AbsentLeadRow key={`absent-${key}`} name={lead.leadName} indent={(getTeamDepth(lead.leadTeam) - 1) * SUB_TEAM_INDENT} />);
        }
        if (absentLeads.length === 0) {
          return row;
        }
        return <React.Fragment key={`row-${teammate.id}`}>{absentLeads}{row}</React.Fragment>;
      });
    }
    $[0] = allIdle;
    $[1] = isInSelectionMode;
    $[2] = leaderIdleText;
    $[3] = leaderTokenCount;
    $[4] = leaderVerb;
    $[5] = selection;
    $[6] = showTeammateMessagePreview;
    $[7] = tasks;
    $[8] = viewingAgentTaskId;
    $[9] = T0;
    $[10] = isHideSelected;
    $[11] = t1;
    $[12] = t2;
    $[13] = t3;
    $[14] = t4;
    $[15] = t5;
  } else {
    T0 = $[9];
    isHideSelected = $[10];
    t1 = $[11];
    t2 = $[12];
    t3 = $[13];
    t4 = $[14];
    t5 = $[15];
  }
  if (t5 !== Symbol.for("react.early_return_sentinel")) {
    return t5;
  }
  let t6;
  if ($[51] !== isHideSelected || $[52] !== isInSelectionMode) {
    t6 = isInSelectionMode && <HideRow isSelected={isHideSelected} />;
    $[51] = isHideSelected;
    $[52] = isInSelectionMode;
    $[53] = t6;
  } else {
    t6 = $[53];
  }
  let t7;
  if ($[54] !== T0 || $[55] !== t1 || $[56] !== t2 || $[57] !== t3 || $[58] !== t4 || $[59] !== t6) {
    t7 = <T0 flexDirection={t1} marginTop={t2}>{t3}{t4}{t6}</T0>;
    $[54] = T0;
    $[55] = t1;
    $[56] = t2;
    $[57] = t3;
    $[58] = t4;
    $[59] = t6;
    $[60] = t7;
  } else {
    t7 = $[60];
  }
  return t7;
}
/**
 * Identity of a row for the absent-sub-lead lookup: the pair that names a
 * teammate inside the tree. A row whose identity carries no team name belongs to
 * the root team, keyed on '' — the same tolerance orderTeammatesDepthFirst and
 * getSubLeadPath apply.
 */
function teamRowKey(agentName: string, teamName: string | undefined): string {
  return `${agentName}\u0000${teamName ?? ''}`;
}

/**
 * The sub-leads above `teamName`, outermost first, each with the team it is a
 * member OF: `email/supervisor/worker-1` →
 * `[{supervisor, email}, {worker-1, email/supervisor}]`.
 *
 * Walks up with getParentTeamName exactly as getSubLeadPath does, so the
 * separator stays teamHelpers' business; this variant keeps the parent team as
 * well as the segment, because the placeholder has to be drawn at the lead's own
 * depth. An absent or root team name yields no ancestors.
 */
function leadChain(teamName: string | undefined): Array<{
  leadName: string;
  leadTeam: string;
}> {
  if (!teamName) {
    return [];
  }
  const chain: Array<{
    leadName: string;
    leadTeam: string;
  }> = [];
  let team = teamName;
  let parent = getParentTeamName(team);
  while (parent !== undefined) {
    chain.unshift({
      leadName: team.slice(parent.length + 1),
      leadTeam: parent
    });
    team = parent;
    parent = getParentTeamName(team);
  }
  return chain;
}

/**
 * A sub-team whose lead has no row of its own — it was never spawned, it
 * crashed, or its grace window has closed. Drawn at the lead's position so its
 * members nest under it instead of under an unrelated sibling.
 *
 * Hand-written, deliberately NOT react-compiler output: it has no cache slots,
 * so it cannot fall out of step with the 61-slot map of the component above. Its
 * inputs are two primitives and it renders three Text nodes.
 */
function AbsentLeadRow({
  name,
  indent
}: {
  name: string;
  indent: number;
}): React.ReactNode {
  return <Box paddingLeft={3 + indent}>
      <Text dimColor={true}> </Text>
      <Text dimColor={true}>{"\u251C\u2500"} </Text>
      <Text dimColor={true}>@{name} · not running</Text>
    </Box>;
}

/**
 * The empty state: what the panel shows with no teammate rows at all. One muted
 * line under the team-lead row, never `null` — the tree is a panel now, and the
 * user's rule is that it is visible every time it is enabled.
 *
 * Hand-written like AbsentLeadRow, with no cache slots and no inputs.
 */
function EmptyTeammatesRow(): React.ReactNode {
  return <Box paddingLeft={3}>
      <Text dimColor={true}> </Text>
      <Text dimColor={true}>{"\u2514\u2500"} </Text>
      <Text dimColor={true}>no teammates · Agent(name: "…") spawns one</Text>
    </Box>;
}
function _temp3(s_1) {
  return s_1.showTeammateMessagePreview;
}
function _temp2(s_0) {
  return s_0.viewingAgentTaskId;
}
function _temp(s) {
  return s.tasks;
}
function HideRow(t0) {
  const $ = _c(18);
  const {
    isSelected
  } = t0;
  const t1 = isSelected ? "suggestion" : undefined;
  const t2 = isSelected ? figures.pointer : " ";
  let t3;
  if ($[0] !== isSelected || $[1] !== t1 || $[2] !== t2) {
    t3 = <Text color={t1} bold={isSelected}>{t2}</Text>;
    $[0] = isSelected;
    $[1] = t1;
    $[2] = t2;
    $[3] = t3;
  } else {
    t3 = $[3];
  }
  const t4 = !isSelected;
  const t5 = isSelected ? "\u2558\u2550" : "\u2514\u2500";
  let t6;
  if ($[4] !== isSelected || $[5] !== t4 || $[6] !== t5) {
    t6 = <Text dimColor={t4} bold={isSelected}>{t5}{" "}</Text>;
    $[4] = isSelected;
    $[5] = t4;
    $[6] = t5;
    $[7] = t6;
  } else {
    t6 = $[7];
  }
  const t7 = !isSelected;
  let t8;
  if ($[8] !== isSelected || $[9] !== t7) {
    t8 = <Text dimColor={t7} bold={isSelected}>hide</Text>;
    $[8] = isSelected;
    $[9] = t7;
    $[10] = t8;
  } else {
    t8 = $[10];
  }
  let t9;
  if ($[11] !== isSelected) {
    t9 = isSelected && <Text dimColor={true}> · enter to collapse</Text>;
    $[11] = isSelected;
    $[12] = t9;
  } else {
    t9 = $[12];
  }
  let t10;
  if ($[13] !== t3 || $[14] !== t6 || $[15] !== t8 || $[16] !== t9) {
    t10 = <Box paddingLeft={3}>{t3}{t6}{t8}{t9}</Box>;
    $[13] = t3;
    $[14] = t6;
    $[15] = t8;
    $[16] = t9;
    $[17] = t10;
  } else {
    t10 = $[17];
  }
  return t10;
}
