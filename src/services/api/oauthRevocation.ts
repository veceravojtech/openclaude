/**
 * The wire shape of an OAuth grant revocation.
 *
 * This lives in its own leaf module, with no imports, because the same
 * response is classified in four other places and two of them cannot reach
 * `errors.ts`: `utils/http.ts` and `utils/fastMode.ts` ship in the SDK bundle,
 * and `errors.ts` transitively pulls in `config.ts` (~1300 modules), which
 * breaks that bundle — see the warning above `withOAuth401Retry`. `errors.ts`
 * re-exports this next to the APIError-typed `isOAuthGrantRevokedError`, so
 * callers that already depend on it keep a single import.
 *
 * The API reports one condition in at least two spellings:
 *
 *   403 "OAuth token has been revoked"
 *   401 "OAuth access token has been revoked."
 *
 * Matching only the first, and only on 403, is what let a dead grant fall
 * through to the generic 401 branch of the retry policy and collect ten
 * attempts of exponential backoff instead of the /login it actually needed.
 * The optional qualifier is the only part that varies, so it is the only part
 * the pattern relaxes — a looser match would swallow unrelated OAuth errors
 * (organization not allowed, scope failures) that are classified elsewhere.
 */
const OAUTH_GRANT_REVOKED_PATTERN =
  /OAuth (?:(?:access|refresh) )?token has been revoked/i

/**
 * True when `text` carries an OAuth-grant-revoked message in any spelling.
 *
 * `text` is matched as a substring source, not compared: an `APIError.message`
 * is the whole JSON body, and an axios error body is raw response text.
 */
export function isOAuthGrantRevokedMessage(
  text: string | null | undefined,
): boolean {
  return text != null && OAUTH_GRANT_REVOKED_PATTERN.test(text)
}
