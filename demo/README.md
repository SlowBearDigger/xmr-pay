# xmr-pay live demo

A real checkout that verifies a Monero payment on-chain (stagenet), plus a
mainnet tip widget with no backend. It uses the parent checkout through a local npm dependency.

## Run it locally

```
cd demo
npm ci             # installs this checkout and the locked monero-ts dependency
npm start          # http://localhost:8780
```

Click **Try it**: a real stagenet proof is submitted and verified live.

## Host it (pick one)

The verify function uses `monero-ts` (WASM), which is slow to **cold-start**.
That makes an always-on Node host the reliable choice; pure serverless can time
out on the first call.

### Render / Railway / Fly  ·  recommended

A normal Node web service: no per-request timeout to fight.

- Root directory: repository root
- Build: `cd demo && npm ci && npm run build`
- Start: `cd demo && node server.js`
- Set `HOST=0.0.0.0` only when the platform requires binding its ingress interface.

For Render, select `demo/render.yaml` as the Blueprint path and leave the service
root directory unset. Files outside a configured root directory are unavailable
at build time; see [Render monorepo support](https://render.com/docs/monorepo-support).

### Your own VPS

```
cd demo && npm ci && npm start
```

Put nginx/caddy in front for TLS. Keep the verifier bound behind the proxy.

### Vercel

Import the full Git repository, set the project root to `demo`, use `npm ci` as
the install command, and enable **Include source files outside of the Root
Directory in the Build Step**. See the [Vercel monorepo FAQ](https://vercel.com/docs/monorepos/monorepo-faq).
Uploading only the `demo` directory omits its local parent dependency.

Check the host's current function limits. WASM startup and node requests may
exceed a short timeout; an always-on process avoids repeated cold starts.

## Configure

| env var | default |
|---|---|
| `XMR_NETWORK` | `stagenet` |
| `XMR_ADDRESS` | the demo stagenet subaddress |
| `XMR_NODES` | comma-separated stagenet nodes |
| `PORT` | `8780` (standalone server) |

To point the demo at mainnet and your own order, set `XMR_NETWORK=mainnet`,
`XMR_ADDRESS=…`, `XMR_NODES=…` and edit the order/amount in `verify-handler.js`.

The demo uses `file:..` and `install-links=true` to install a packed copy of the
parent source alongside its dependencies. Keep the full repository available to
the build. After changing parent sources, reinstall the demo before testing.
It does not wait for the new library version to appear on npm.

The widget file is copied from the installed `xmr-pay` package at build time
(`npm run build`), so there's one source of truth.
