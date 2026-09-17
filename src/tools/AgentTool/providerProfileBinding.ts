import { getGlobalConfig, type ProviderProfile } from '../../utils/config.js'
import { getProviderProfiles } from '../../utils/providerProfiles.js'
import { isCodexBaseUrl } from '../../services/api/providerConfig.js'
import {
  buildCodexProfileEnv,
  type ProfileEnv,
} from '../../utils/providerProfile.js'

/**
 * Error used by AgentTool to reject a provider_profile binding on a spawn
 * that will run in-process. An in-process teammate shares the leader's
 * process, so there is no child environment to inject into; falling through
 * silently would reproduce the exact bug this binding exists to fix (the
 * teammate inheriting the leader's provider env and hanging).
 */
export const PROVIDER_PROFILE_IN_PROCESS_ERROR =
  'provider_profile cannot be used for in-process spawns: an in-process teammate shares the leader process, so its provider environment cannot be overridden. Spawn a pane teammate instead.';

/** Env keys that must never reach the spawn command line. */
const CREDENTIAL_KEY_PATTERN = /API_KEY|TOKEN|SECRET/;

function listProfilesForError(profiles: readonly ProviderProfile[]): string {
  return profiles
    .map(profile => `${profile.id} (${profile.name})`)
    .join(', ');
}

function findProfileByRef(
  ref: string,
  profiles: readonly ProviderProfile[],
): ProviderProfile | undefined {
  const trimmed = ref.trim();
  if (!trimmed) return undefined;
  // Id first: ids are the stable unique handle, names can collide.
  const byId = profiles.find(profile => profile.id === trimmed);
  if (byId) return byId;
  const wanted = trimmed.toLowerCase();
  return profiles.find(profile => profile.name.trim().toLowerCase() === wanted);
}

/**
 * Resolve a provider profile reference (id or name) into the env vars a
 * spawned teammate needs to run on that profile's provider instead of
 * inheriting the leader's.
 *
 * Only Codex/OAuth profiles are supported: API-key profiles already route
 * through findProviderProfileRouteForModel + applyAgentProviderOverrideToEnv,
 * and an OAuth profile has no API key for that path to carry — which is
 * exactly why teammates pinned to Codex hang today.
 *
 * The returned env is spliced into an `env KEY=VALUE ...` command string,
 * which is visible in the local process table. It therefore must contain no
 * credential material: any key matching /API_KEY|TOKEN|SECRET/ is stripped
 * defensively, even if the codex env builder emits one. Auth is resolved by
 * the child itself from secure storage at request time.
 */
export function resolveProviderProfileEnv(
  ref: string,
  options?: {
    profiles?: ProviderProfile[];
    /** Injectable for tests; defaults to the real codex env builder. */
    buildCodexEnv?: () => ProfileEnv | null;
  },
): Record<string, string> {
  const profiles = options?.profiles ?? getProviderProfiles(getGlobalConfig());
  if (profiles.length === 0) {
    throw new Error(
      'No provider profiles are configured. Create one with /provider before binding a teammate to provider_profile.',
    );
  }

  const profile = findProfileByRef(ref, profiles);
  if (!profile) {
    throw new Error(
      `Unknown provider profile '${ref}'. Available profiles: ${listProfilesForError(profiles)}.`,
    );
  }

  if (!isCodexBaseUrl(profile.baseUrl)) {
    // Deliberately unsupported, and deliberately silent about the key.
    // Non-codex profiles already work through model routing
    // (findProviderProfileRouteForModel), and half-supporting them here would
    // fork the routing logic. Point the caller at the supported path.
    throw new Error(
      `provider_profile supports Codex (OAuth) profiles only; '${profile.name}' is not one. For API-key providers, pass the model instead and let model routing resolve the provider.`,
    );
  }

  const buildCodexEnv = options?.buildCodexEnv ?? (() => buildCodexProfileEnv({}));
  const codexEnv = buildCodexEnv();
  if (!codexEnv) {
    throw new Error(
      `Codex credentials could not be resolved for profile '${profile.name}'. Run the OAuth login for the Codex provider and try again.`,
    );
  }
  if (codexEnv.CODEX_CREDENTIAL_SOURCE !== 'oauth') {
    throw new Error(
      `Profile '${profile.name}' is a Codex profile but is not in OAuth credential mode; per-teammate provider binding only supports OAuth codex profiles.`,
    );
  }

  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(codexEnv)) {
    if (value === undefined || value === '') continue;
    if (CREDENTIAL_KEY_PATTERN.test(key)) continue;
    env[key] = value;
  }

  // CLAUDE_CODE_USE_OPENAI is load-bearing, not redundant. Without it the
  // child's startup wipes everything above: because the shared global config
  // still names the leader's profile, applyActiveProviderProfileFromConfig
  // takes the clear branch and clearProviderProfileEnvFromProcessEnv deletes
  // every PROFILE_ENV_KEYS entry — including OPENAI_BASE_URL and
  // OPENAI_MODEL. The only escape is the early return gated by
  // hasCompleteProviderSelection (providerProfiles.ts:1378), which requires
  // a CLAUDE_CODE_USE_* flag AND a concrete base URL/model. The base URL is
  // injected; the flag is this line.
  env.CLAUDE_CODE_USE_OPENAI = '1';

  return env;
}
