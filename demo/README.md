# xmr-pay live demo

A real checkout that verifies a Monero payment on-chain (stagenet), plus a
mainnet tip widget with no backend. It's the published `xmr-pay` package + one
small function — nothing faked.

## Run it locally

```
cd demo
npm install        # pulls the published xmr-pay + monero-ts
npm start          # http://localhost:8780
```

Click **Try it** — a real stagenet proof is submitted and verified live.

## Host it (pick one)

The verify function uses `monero-ts` (WASM), which is slow to **cold-start**.
That makes an always-on Node host the reliable choice; pure serverless can time
out on the first call.

### Render / Railway / Fly  ·  recommended

A normal Node web service — no per-request timeout to fight.

- Root directory: `demo`
- Build: `npm install && npm run build`
- Start: `node server.js`

Render reads `render.yaml` if you point a Blueprint at this folder.

### Your own VPS

```
cd demo && npm install && npm start
```

Put nginx/caddy in front for TLS. This is the most sovereign option.

### Vercel

```
cd demo && npx vercel        # no global install needed
```

Works, but on Hobby the first request after a cold start may exceed the
function timeout while the WASM wallet loads. Use a paid plan or prefer an
always-on host above for a snappy demo.

## Configure

| env var | default |
|---|---|
| `XMR_NETWORK` | `stagenet` |
| `XMR_ADDRESS` | the demo stagenet subaddress |
| `XMR_NODES` | comma-separated stagenet nodes |
| `PORT` | `8780` (standalone server) |

To point the demo at mainnet and your own order, set `XMR_NETWORK=mainnet`,
`XMR_ADDRESS=…`, `XMR_NODES=…` and edit the order/amount in `verify-handler.js`.

The widget file is copied from the installed `xmr-pay` package at build time
(`npm run build`), so there's one source of truth.
