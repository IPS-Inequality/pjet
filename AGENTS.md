# AGENTS.md

## Local development

Use port `8080` for local development. Before starting the server, check whether
that port is already in use and reuse or stop a stale PJET process rather than
starting a second copy on another port.

```sh
HOST=127.0.0.1 PORT=8080 npm run serve
```

Generated databases, caches, screenshots, credentials, and machine-specific
configuration must remain untracked. Use the `PJET_*` environment variables
documented in the README to locate local or external-volume data.

## Deployment hygiene

The files in `deploy/` are templates. Keep production hostnames, origin IP
addresses, credentials, account identifiers, and operational runbooks outside
the public repository. Configure secrets through the deployment environment;
never add them to a Caddyfile, service unit, `.env` file, or commit.

Run the documented checks before a release and do not deploy data caches or
SQLite databases from a development machine.
