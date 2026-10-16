# Contributing

Read [the architecture](docs/ARCHITECTURE.md) first.
Use Linux, Node 22.19+, and the exact Pi 1.3.0 development dependencies.

```sh
npm ci
npm run release:check
```

The checks use isolated temporary histories/configuration and fake local models.
Fresh-install checks fetch Pi from npm and install a locally packed extension;
they make no paid model calls. Python 3 and a PTY-capable environment are required.

Keep core lifecycle and safety separate from optional feature modules. Add a config
toggle, lifecycle cleanup, enabled/disabled coverage, and documentation for optional
features. Avoid runtime dependencies without a concrete justification.

`dist/` is generated and shipped for Pi's Git installer, which omits development
dependencies. Run `npm run build` after source changes and include generated output.
CI rejects stale generated modules. Do not edit generated files directly.

Describe the behavior changed, why, and the checks you ran. Use temporary data for
bug reports. Never include auth files, real conversations, or private host logs.
Discuss API or dependency changes before implementation. Treat other contributors
respectfully; focus reviews on code and observable behavior.

See [release instructions](docs/RELEASING.md) for publication requirements.
