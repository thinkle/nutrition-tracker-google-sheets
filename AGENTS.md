# Agent Notes

- Use the globally installed `wrangler` command in this repo. Do not use `npx wrangler`; in this environment `npx wrangler` may try to install a different Wrangler version and can produce misleading KV results.
- For Cloudflare commands that need a writable Wrangler home in sandboxed sessions, use `WRANGLER_HOME=/private/tmp/wrangler-home wrangler ...`.

## Deploying the Apps Script (GAS) backend

This repo's GAS code (Endpoints.js, StrengthTracking.js, ExerciseMapping.js,
etc.) is pushed with `clasp`, but pushing alone does **not** make it live.

1. `clasp push` — uploads local files to the Apps Script project and saves a
   new version. Low-risk, always safe to run.
2. `clasp push` does NOT update the live web app. The actual URL the
   Cloudflare proxies hit (e.g. `nutrition.tmhinkle.workers.dev` ->
   `CloudflareGasProxy.js` -> the GAS `/exec` URL) is served by a
   **versioned deployment**, which stays frozen at whatever version it was
   last deployed with. You must explicitly redeploy for changes to go live:
   `clasp deploy -i <deploymentId>` (updates that deployment's code without
   changing its URL — safe). A bare `clasp deploy` with no `-i` mints a
   *new* deployment ID with a *different* URL, which would silently break
   every Cloudflare proxy pointing at the old one — never do that here.
3. `clasp deployments` currently lists two near-duplicate versioned
   deployments (both were sitting at the same version when last checked):
   - `AKfycbzox3LwF2jBYnddsG9Rj7JLTVNr2t_CyaZe5HHyuJeqlRri0MnFvgQWcisAfiFFUjA`
   - `AKfycbxNgealN6iRkMWP5BYCFtHrd3OLZApPcdnViOVqtCBzNRGvQxnTyh_P-ymKLNQg29qg`
   Nobody remembers which one is actually live, so the established habit
   (keep doing this) is to `clasp deploy -i <id>` **both** of them after
   every push, e.g.:

   ```bash
   clasp push
   clasp deploy -i AKfycbzox3LwF2jBYnddsG9Rj7JLTVNr2t_CyaZe5HHyuJeqlRri0MnFvgQWcisAfiFFUjA -d "<description>"
   clasp deploy -i AKfycbxNgealN6iRkMWP5BYCFtHrd3OLZApPcdnViOVqtCBzNRGvQxnTyh_P-ymKLNQg29qg -d "<description>"
   ```

   Re-run `clasp deployments` first in case a third deployment has been
   added since — update all versioned (non-`@HEAD`) deployments you find,
   not just these two specific IDs from memory.
4. **Domain restriction**: `clasp deploy` fails with `Only users in the
   same domain as the script owner may deploy this script` if the
   authenticated `clasp` account isn't the script's owner (or same
   Workspace domain). Check with `clasp login --status` — if it's not the
   right account, `clasp push` still succeeds (it just saves a version) but
   deployment will fail. Ask the user to `clasp login` as the owning
   account before attempting `clasp deploy`; don't try to route around this
   (sharing/domain settings are the user's call, not something to change
   unilaterally). Once logged in as the right account, deploying is safe to
   do autonomously — it's just pushing + updating those two deployment IDs.
