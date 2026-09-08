import { c as _c } from "react-compiler-runtime";
import React, { useMemo } from 'react';
import type { DeepImmutable } from 'src/types/utils.js';
import { useElapsedTime } from '../../hooks/useElapsedTime.js';
import type { KeyboardEvent } from '../../ink/events/keyboard-event.js';
import { Box, Text, useTheme } from '../../ink.js';
import { useKeybindings } from '../../keybindings/useKeybinding.js';
import { getEmptyToolPermissionContext } from '../../Tool.js';
import type { LocalAgentTaskState } from '../../tasks/LocalAgentTask/LocalAgentTask.js';
import { getTools } from '../../tools.js';
import { formatNumber } from '../../utils/format.js';
import { extractTag } from '../../utils/messages.js';
import { Byline } from '../design-system/Byline.js';
import { Dialog } from '../design-system/Dialog.js';
import { KeyboardShortcutHint } from '../design-system/KeyboardShortcutHint.js';
import { UserPlanMessage } from '../messages/UserPlanMessage.js';
import { renderToolActivity } from './renderToolActivity.js';
import { getTaskStatusColor, getTaskStatusIcon } from './taskStatusUtils.js';
type Props = {
  agent: DeepImmutable<LocalAgentTaskState>;
  onDone: () => void;
  onKillAgent?: () => void;
  onBack?: () => void;
  onForeground?: () => void;
};
export function AsyncAgentDetailDialog(t0) {
  const $ = _c(56);
  const {
    agent,
    onDone,
    onKillAgent,
    onBack,
    onForeground
  } = t0;
  // Mirrors the /tasks list ruling: when the live agent view is reachable,
  // Enter opens it — the auto-skipped single-task pane must not be the one place
  // where Enter means "close". Under CLAUDE_CODE_DISABLE_AGENT_VIEW the parent
  // withholds onForeground, so Enter falls back to closing exactly as before.
  const confirmAction = onForeground ?? onDone;
  const [theme] = useTheme();
  let t1;
  if ($[0] === Symbol.for("react.memo_cache_sentinel")) {
    t1 = getTools(getEmptyToolPermissionContext());
    $[0] = t1;
  } else {
    t1 = $[0];
  }
  const tools = t1;
  const elapsedTime = useElapsedTime(agent.startTime, agent.status === "running", 1000, agent.totalPausedMs ?? 0);
  let t2;
  if ($[1] !== confirmAction) {
    t2 = {
      "confirm:yes": confirmAction
    };
    $[1] = confirmAction;
    $[2] = t2;
  } else {
    t2 = $[2];
  }
  let t3;
  if ($[3] === Symbol.for("react.memo_cache_sentinel")) {
    t3 = {
      context: "Confirmation"
    };
    $[3] = t3;
  } else {
    t3 = $[3];
  }
  useKeybindings(t2, t3);
  let t4;
  if ($[4] !== agent.status || $[5] !== onBack || $[6] !== onDone || $[7] !== onForeground || $[8] !== onKillAgent) {
    t4 = e => {
      if (e.key === " ") {
        e.preventDefault();
        onDone();
      } else {
        if (e.key === "left" && onBack) {
          e.preventDefault();
          onBack();
        } else {
          if (e.key === "x" && agent.status === "running" && onKillAgent) {
            e.preventDefault();
            onKillAgent();
          } else {
            if (e.key === "f" && onForeground) {
              e.preventDefault();
              onForeground();
            }
          }
        }
      }
    };
    $[4] = agent.status;
    $[5] = onBack;
    $[6] = onDone;
    $[7] = onForeground;
    $[8] = onKillAgent;
    $[9] = t4;
  } else {
    t4 = $[9];
  }
  const handleKeyDown = t4;
  let t5;
  if ($[10] !== agent.prompt) {
    t5 = extractTag(agent.prompt, "plan");
    $[10] = agent.prompt;
    $[11] = t5;
  } else {
    t5 = $[11];
  }
  const planContent = t5;
  const displayPrompt = agent.prompt.length > 300 ? agent.prompt.substring(0, 297) + "\u2026" : agent.prompt;
  const tokenCount = agent.result?.totalTokens ?? agent.progress?.tokenCount;
  const toolUseCount = agent.result?.totalToolUseCount ?? agent.progress?.toolUseCount;
  const t6 = agent.selectedAgent?.agentType ?? "agent";
  const t7 = agent.description || "Async agent";
  let t8;
  if ($[12] !== t6 || $[13] !== t7) {
    t8 = <Text>{t6} ›{" "}{t7}</Text>;
    $[12] = t6;
    $[13] = t7;
    $[14] = t8;
  } else {
    t8 = $[14];
  }
  const title = t8;
  let t9;
  if ($[15] !== agent.status) {
    t9 = agent.status !== "running" && <Text color={getTaskStatusColor(agent.status)}>{getTaskStatusIcon(agent.status)}{" "}{agent.status === "completed" ? "Completed" : agent.status === "failed" ? "Failed" : "Stopped"}{" \xB7 "}</Text>;
    $[15] = agent.status;
    $[16] = t9;
  } else {
    t9 = $[16];
  }
  let t10;
  if ($[17] !== tokenCount) {
    t10 = tokenCount !== undefined && tokenCount > 0 && <> · {formatNumber(tokenCount)} tokens</>;
    $[17] = tokenCount;
    $[18] = t10;
  } else {
    t10 = $[18];
  }
  let t11;
  if ($[19] !== toolUseCount) {
    t11 = toolUseCount !== undefined && toolUseCount > 0 && <>{" "}· {toolUseCount} {toolUseCount === 1 ? "tool" : "tools"}</>;
    $[19] = toolUseCount;
    $[20] = t11;
  } else {
    t11 = $[20];
  }
  let t12;
  if ($[21] !== elapsedTime || $[22] !== t10 || $[23] !== t11) {
    t12 = <Text dimColor={true}>{elapsedTime}{t10}{t11}</Text>;
    $[21] = elapsedTime;
    $[22] = t10;
    $[23] = t11;
    $[24] = t12;
  } else {
    t12 = $[24];
  }
  let t13;
  if ($[25] !== t12 || $[26] !== t9) {
    t13 = <Text>{t9}{t12}</Text>;
    $[25] = t12;
    $[26] = t9;
    $[27] = t13;
  } else {
    t13 = $[27];
  }
  const subtitle = t13;
  let t14;
  if ($[28] !== agent.status || $[29] !== onBack || $[30] !== onForeground || $[31] !== onKillAgent) {
    t14 = exitState => exitState.pending ? <Text>Press {exitState.keyName} again to exit</Text> : <Byline>{onBack && <KeyboardShortcutHint shortcut={"\u2190"} action="go back" />}{onForeground && <KeyboardShortcutHint shortcut="Enter/f" action="view agent" />}<KeyboardShortcutHint shortcut={onForeground ? "Esc/Space" : "Esc/Enter/Space"} action="close" />{agent.status === "running" && onKillAgent && <KeyboardShortcutHint shortcut="x" action="stop" />}</Byline>;
    $[28] = agent.status;
    $[29] = onBack;
    $[30] = onForeground;
    $[31] = onKillAgent;
    $[32] = t14;
  } else {
    t14 = $[32];
  }
  let t15;
  if ($[33] !== agent.progress || $[34] !== agent.status || $[35] !== theme) {
    t15 = agent.status === "running" && agent.progress?.recentActivities && agent.progress.recentActivities.length > 0 && <Box flexDirection="column"><Text bold={true} dimColor={true}>Progress</Text>{agent.progress.recentActivities.map((activity, i) => <Text key={i} dimColor={i < agent.progress.recentActivities.length - 1} wrap="truncate-end">{i === agent.progress.recentActivities.length - 1 ? "\u203A " : "  "}{renderToolActivity(activity, tools, theme)}</Text>)}</Box>;
    $[33] = agent.progress;
    $[34] = agent.status;
    $[35] = theme;
    $[36] = t15;
  } else {
    t15 = $[36];
  }
  let t16;
  if ($[37] !== displayPrompt || $[38] !== planContent) {
    t16 = planContent ? <Box marginTop={1}><UserPlanMessage addMargin={false} planContent={planContent} /></Box> : <Box flexDirection="column" marginTop={1}><Text bold={true} dimColor={true}>Prompt</Text><Text wrap="wrap">{displayPrompt}</Text></Box>;
    $[37] = displayPrompt;
    $[38] = planContent;
    $[39] = t16;
  } else {
    t16 = $[39];
  }
  let t17;
  if ($[40] !== agent.error || $[41] !== agent.status) {
    t17 = agent.status === "failed" && agent.error && <Box flexDirection="column" marginTop={1}><Text bold={true} color="error">Error</Text><Text color="error" wrap="wrap">{agent.error}</Text></Box>;
    $[40] = agent.error;
    $[41] = agent.status;
    $[42] = t17;
  } else {
    t17 = $[42];
  }
  let t18;
  if ($[43] !== t15 || $[44] !== t16 || $[45] !== t17) {
    t18 = <Box flexDirection="column">{t15}{t16}{t17}</Box>;
    $[43] = t15;
    $[44] = t16;
    $[45] = t17;
    $[46] = t18;
  } else {
    t18 = $[46];
  }
  let t19;
  if ($[47] !== onDone || $[48] !== subtitle || $[49] !== t14 || $[50] !== t18 || $[51] !== title) {
    t19 = <Dialog title={title} subtitle={subtitle} onCancel={onDone} color="background" inputGuide={t14}>{t18}</Dialog>;
    $[47] = onDone;
    $[48] = subtitle;
    $[49] = t14;
    $[50] = t18;
    $[51] = title;
    $[52] = t19;
  } else {
    t19 = $[52];
  }
  let t20;
  if ($[53] !== handleKeyDown || $[54] !== t19) {
    t20 = <Box flexDirection="column" tabIndex={0} autoFocus={true} onKeyDown={handleKeyDown}>{t19}</Box>;
    $[53] = handleKeyDown;
    $[54] = t19;
    $[55] = t20;
  } else {
    t20 = $[55];
  }
  return t20;
}
