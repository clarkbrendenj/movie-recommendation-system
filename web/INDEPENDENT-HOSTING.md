# Afterglow on GitHub and Cloudflare

[GitHub](https://github.com/clarkbrendenj/movie-recommendation-system) stores the
source. A Cloudflare Worker serves the full app, model assets and APIs, with D1
storing accounts, ratings, friends and lists. The app uses its own username/password
accounts; friends can visit its HTTPS URL without signing in to ChatGPT. GitHub
Pages cannot run the current server or database APIs.

This deployment is separate from the existing private Site and preserves that
Site's access policy and database. No OpenAI API key is needed.

## First deployment from your computer

Use your own Cloudflare account. From the repository's `web/` folder, with
Node.js 22.23.4 on PATH, install dependencies and sign in through Wrangler:

```powershell
npm ci --include=dev --include=optional --no-audit --no-fund
npm run build
node node_modules/wrangler/bin/wrangler.js login
node node_modules/wrangler/bin/wrangler.js whoami
```

Create the independent database once, unless it already exists:

```powershell
node node_modules/wrangler/bin/wrangler.js d1 create afterglow-db
```

Use its real database UUID and your Cloudflare account ID below. Reuse these
same IDs for later deployments so existing Afterglow accounts and ratings remain
in the same database.

```powershell
npm run hosting:prepare -- --database-id YOUR_D1_DATABASE_UUID --account-id YOUR_CLOUDFLARE_ACCOUNT_ID --name afterglow
node node_modules/wrangler/bin/wrangler.js deploy --dry-run --config .independent/wrangler.json
node node_modules/wrangler/bin/wrangler.js d1 migrations apply DB --remote --config .independent/wrangler.json
node node_modules/wrangler/bin/wrangler.js deploy --config .independent/wrangler.json
```

The preparation command only generates ignored `.independent/wrangler.json`; it
does not log in, create resources or publish. The final two commands apply pending
database migrations and publish the Worker. Use the HTTPS URL Wrangler prints.

## Later deployments from GitHub

The [Deploy Afterglow workflow](https://github.com/clarkbrendenj/movie-recommendation-system/actions/workflows/deploy-afterglow.yml)
runs **only when started manually**, on the `main` branch. Pushing source does not
publish a production update.

1. In Cloudflare, [create an API token](https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/#api-token)
   using the **Edit Cloudflare Workers** template, scoped to the account hosting
   Afterglow. Include **Account / D1 / Edit** for this workflow's database
   migrations. Cloudflare lists the [available token permissions](https://developers.cloudflare.com/fundamentals/api/reference/permissions/).
2. In the repository's [Actions secrets](https://github.com/clarkbrendenj/movie-recommendation-system/settings/secrets/actions),
   add a repository secret named `CLOUDFLARE_API_TOKEN`. Put the token there;
   keep it out of source, workflow YAML and chat. Local Wrangler OAuth login does
   not configure this GitHub secret.
3. In [Actions variables](https://github.com/clarkbrendenj/movie-recommendation-system/settings/variables/actions),
   add `CLOUDFLARE_ACCOUNT_ID` and `CF_D1_DATABASE_ID` with the same account ID and
   independent database UUID used above. These identifiers are variables, not
   credentials.
4. Open **Actions → Deploy Afterglow → Run workflow**, select `main`, and run it.
   Read the deployment step's log for the live URL.

The workflow uses Node.js 22.23.4, installs the lockfile, runs all `lib/*.test.mjs`
tests, checks TypeScript and builds before applying pending D1 migrations and
deploying the full app. Failed checks prevent migration and deployment. Runs are
serialized; a new run does not cancel one already deploying. The deployment
token is supplied only to settings validation and the Cloudflare commands.

The workflow uses repository secrets and variables directly; a GitHub
`production` environment is not required. GitHub's token has only source-read
permission. No GitHub Pages setup or separate frontend hosting is needed.

## Accounts and existing data

Friends register their own Afterglow accounts, exchange friend codes and accept
a request before joining a Together list. Passwords and session cookies belong
to this app. Email verification and automated password recovery are not included.

A newly created D1 database starts empty. The private Site's records stay in its
separate database. Moving existing ratings requires an owner-verified import and
explicit account mappings; matching names do not establish ownership. Legacy
platform-identity rows are preserved and are not automatically claimed by new
accounts. Keep database files, local runtime state and credentials out of the
public GitHub repository.

Future schema changes should append migrations. Rebuild and regenerate the
independent config before local deployments so the Worker, assets and schema
come from the same source state. The GitHub workflow performs these steps for
each manual deployment.
