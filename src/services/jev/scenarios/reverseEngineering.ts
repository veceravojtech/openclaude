/**
 * Reverse-engineering scenarios: analysing binaries, firmware, protocols and
 * obfuscated code. All are framed as authorized, analysis-oriented work — CTF
 * challenge files, devices and products we own, samples already quarantined in
 * a sandbox — because the point is to test routing, not to describe an attack.
 *
 * In cyber mode (`/cyber on`) the dispatcher never asks JEV. It reads role and
 * complexity from keywords and applies a fixed policy (docs/cyber-mode.md):
 * review and verify go to GLM 5.3, easy work to DeepSeek V4 Pro, hard work to
 * Opus 4.6, and design counts as deep. `gold.cyberModel` records where that
 * policy SHOULD send each task given its true difficulty, so a run with
 * `--cyber` shows where keyword complexity sends hard work to the cheap model.
 *
 * Labels are starter labels. Review them before using them for training.
 */
import type { BenchScenario } from '../benchmark.js'
import { CYBER_EASY, CYBER_LEAD, CYBER_NOT_LEAD, CYBER_WORKER } from './cyberGold.js'

const ANALYST = 'binary-analyst'

export const REVERSE_ENGINEERING_SCENARIOS: readonly BenchScenario[] = [
  {
    id: 're-decompile-crackme',
    tags: ['research', 'reverse-engineering', 'ctf'],
    description: 'Decompile and document the validation routine in the crackme',
    prompt:
      'This is a CTF crackme (challenge files in ctf/crackme3/). Load it in Binary Ninja, decompile the validation routine, and write up in plain language what input it accepts and how the check works. Do not patch the binary.',
    gold: {
      role: 'research',
      complexity: 'moderate',
      needsLongContext: false,
      agentType: ANALYST,
      model: { tier: 'standard' },
      cyberModel: CYBER_EASY,
    },
  },
  {
    id: 're-firmware-update-check',
    tags: ['research', 'reverse-engineering', 'firmware', 'hard', 'long-context'],
    description: "Work out how the device's firmware update check works",
    prompt:
      "We own the X200 device. From the extracted firmware in fw/x200/, find the code that checks for updates, document the request format, the endpoints and how the response is verified, and note any missing signature check. Read-only: do not modify the image.",
    gold: {
      role: 'research',
      complexity: 'hard',
      needsLongContext: true,
      agentType: ANALYST,
      model: { tier: ['standard', 'deep'], minContext: 200_000 },
      cyberModel: CYBER_WORKER,
    },
  },
  {
    id: 're-protocol-from-pcap',
    tags: ['research', 'reverse-engineering', 'protocol', 'hard', 'long-context'],
    description: "Reverse the vendor's sync protocol from a packet capture",
    prompt:
      'From captures/sync.pcapng (our own client talking to our own test server), infer the message framing, the field types and the handshake, and write a protocol specification with byte-level examples.',
    gold: {
      role: ['research', 'design'],
      complexity: 'hard',
      needsLongContext: true,
      agentType: [ANALYST, 'default'],
      model: { tier: ['standard', 'deep'] },
      cyberModel: CYBER_WORKER,
    },
  },
  {
    id: 're-deobfuscate-vendor-js',
    tags: ['research', 'reverse-engineering', 'javascript', 'hard'],
    description: 'Deobfuscate the vendor analytics script',
    prompt:
      'assets/vendor.min.js is obfuscated (rotated string array, flattened control flow). Deobfuscate it far enough to list every network endpoint it calls and every piece of data it collects, so we can document it in our privacy review.',
    gold: {
      role: 'research',
      complexity: 'hard',
      needsLongContext: false,
      agentType: ['explorer', ANALYST, 'default'],
      model: { tier: ['standard', 'deep'] },
      cyberModel: CYBER_WORKER,
    },
  },
  {
    id: 're-malware-triage-notes',
    tags: ['research', 'reverse-engineering', 'malware', 'defensive', 'hard', 'long-context'],
    description: 'Triage the quarantined sample and write detection notes',
    prompt:
      'In the isolated sandbox VM, triage the ransomware sample already quarantined in samples/2024-17: identify packing, imports, persistence and network behaviour statically, and write behaviour notes our detection team can turn into YARA rules. Never run the sample outside the sandbox.',
    gold: {
      role: 'research',
      complexity: 'hard',
      needsLongContext: true,
      agentType: ANALYST,
      model: { tier: ['standard', 'deep'], minContext: 200_000 },
      cyberModel: CYBER_WORKER,
    },
  },
  {
    id: 're-patch-diff',
    tags: ['research', 'reverse-engineering', 'patch-diff', 'hard', 'long-context'],
    description: 'Diff the patched and unpatched builds to see what the fix changed',
    prompt:
      'We have libfoo 2.3.1 (vulnerable) and 2.3.2 (patched) as binaries in bindiff/. Diff them, identify the functions the patch changed and explain in words what class of bug was fixed, so we can prioritise our own upgrade.',
    gold: {
      role: 'research',
      complexity: 'hard',
      needsLongContext: true,
      agentType: ANALYST,
      model: { tier: ['standard', 'deep'], minContext: 200_000 },
      cyberModel: CYBER_WORKER,
    },
  },
  {
    id: 're-crypto-constants',
    tags: ['research', 'reverse-engineering', 'firmware'],
    description: 'Identify the cryptography used by the firmware',
    prompt:
      'From the firmware blob in fw/x200/, find the cryptographic primitives (look for S-boxes and round constants), identify the algorithms and key sizes, and say whether the key looks hard-coded.',
    gold: {
      role: 'research',
      complexity: 'moderate',
      needsLongContext: false,
      agentType: ANALYST,
      model: { tier: 'standard' },
      cyberModel: CYBER_EASY,
    },
  },
  {
    id: 're-static-only-strings',
    tags: ['research', 'reverse-engineering', 'negation'],
    description: 'Static analysis only: strings and imports of the agent',
    prompt:
      'Do not execute anything. Statically analyse bin/agent.exe and list the strings and imports that suggest persistence or network use.',
    gold: {
      role: 'research',
      complexity: 'moderate',
      needsLongContext: false,
      agentType: ANALYST,
      model: { tier: 'standard' },
      cyberModel: CYBER_EASY,
    },
  },
  {
    id: 're-write-binja-plugin',
    tags: ['implement', 'reverse-engineering', 'tooling', 'hard'],
    description: 'Write a Binary Ninja plugin that recovers Go function names',
    prompt:
      'Write a Binary Ninja plugin that recovers function names from the pclntab in stripped Go binaries and applies them, with a test against the sample in tests/go_stripped.',
    gold: {
      role: 'implement',
      complexity: 'hard',
      needsLongContext: false,
      agentType: 'dev',
      model: { tier: 'deep' },
      cyberModel: CYBER_WORKER,
    },
  },
  {
    id: 're-trace-own-app-sdk',
    tags: ['implement', 'reverse-engineering', 'tooling'],
    description: 'Add Frida tracing to our debug build for the payment SDK',
    prompt:
      'Add Frida-based tracing to our own debug build that logs every call into the payment SDK with its arguments, for the integration test harness. Keep it out of release builds.',
    gold: {
      role: 'implement',
      complexity: 'moderate',
      needsLongContext: false,
      agentType: 'dev',
      model: { tier: 'standard' },
      cyberModel: CYBER_EASY,
    },
  },
  {
    id: 're-verify-patch-removes-path',
    tags: ['verify', 'reverse-engineering', 'separation'],
    implementers: ['deepseek-v4-pro'],
    description: 'Verify the patch removes the vulnerable code path',
    prompt:
      'We patched the header parser in our own product (commit abc123). Using the pre- and post-patch builds, verify with Binary Ninja that the unchecked memcpy in parse_header is gone and that no other caller reaches the old path. Report the evidence.',
    gold: {
      role: 'verify',
      complexity: 'moderate',
      needsLongContext: false,
      agentType: [ANALYST, 'verifier'],
      model: { tier: 'standard' },
      cyberModel: CYBER_LEAD,
    },
  },
  {
    id: 're-review-analyst-notes',
    tags: ['review', 'reverse-engineering', 'separation'],
    implementers: ['glm-5.3'],
    description: "Review the analyst's reverse-engineering notes",
    prompt:
      'Review the notes in re/notes/x200-bootloader.md against the binary: check every claim about function purposes and offsets, and flag the ones that are wrong or unsupported.',
    gold: {
      role: 'review',
      complexity: 'moderate',
      needsLongContext: false,
      agentType: [ANALYST, 'code-reviewer'],
      model: { tier: 'deep' },
      // GLM wrote the notes, so the policy must fall back to another family.
      cyberModel: CYBER_NOT_LEAD,
    },
  },
  {
    id: 're-design-emulation-harness',
    tags: ['design', 'reverse-engineering', 'firmware', 'hard'],
    description: 'Design an emulation harness for the firmware',
    prompt:
      'Design how we could emulate the X200 firmware for fuzzing our own product: choose an emulator (QEMU, Unicorn or Qiling), how to model the peripherals it touches, what to hook, and what the first milestone should be. Write the plan; do not build it.',
    gold: {
      role: 'design',
      complexity: 'hard',
      needsLongContext: false,
      agentType: ['planner', 'default'],
      model: { tier: 'deep' },
      cyberModel: CYBER_WORKER,
    },
  },
  {
    id: 're-ambiguous-mystery-binary',
    tags: ['ambiguous', 'terse', 'reverse-engineering'],
    description: 'Look at this binary',
    prompt: 'Take a look at bin/mystery and tell me what it does.',
    gold: { role: 'research' },
  },
]
