# Agent Notes

- Use the globally installed `wrangler` command in this repo. Do not use `npx wrangler`; in this environment `npx wrangler` may try to install a different Wrangler version and can produce misleading KV results.
- For Cloudflare commands that need a writable Wrangler home in sandboxed sessions, use `WRANGLER_HOME=/private/tmp/wrangler-home wrangler ...`.
