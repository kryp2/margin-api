# margin-api

[![CI](https://github.com/kryp2/margin-api/actions/workflows/ci.yml/badge.svg)](https://github.com/kryp2/margin-api/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Open%20BSV-blue.svg)](LICENSE)

Orchestrator service for the Margin browser extension. It canonicalizes a target URL, builds a Bitcoin Schema draft, and produces a canonical AIP-signed `OP_RETURN` by coordinating two-phase signing with the Wallet Authentication Backend (WAB), then broadcasts the resulting transaction through an overlay service using a sponsor wallet.

## How it works

A single `POST /post` request drives the full pipeline:

1. Canonicalize the submitted URL into a stable context URN.
2. Resolve the user's signing identity from WAB (`/auth/margin/identity`) — no signing yet.
3. Assemble the canonical AIP preimage (B + MAP + AIP header) with the resolved pubkey.
4. Send the preimage to WAB (`/auth/margin/sign`) for a `sha256`/DER signature (BRC-77 lane).
5. Append the signature to finalize the `OP_RETURN` script.
6. Build the transaction with the sponsor wallet and submit it to the overlay.

This two-phase split is required because the canonical AIP preimage must include the signing identity before the signature is computed.

## Endpoints

- `GET /health` — liveness plus sponsor-wallet status (address, balance, readiness).
- `POST /post` — body `{ url, comment, id_token }`; returns `{ txid, script_hex, context_urn, signing_address, signing_pubkey, app }`. Rate-limited and capped at a 500-character comment (free tier).

## Development

```bash
npm install      # install dependencies
npm run dev      # run locally with ts-node-dev (auto-reload)
npm run build    # compile TypeScript to dist/
npm test         # run the Jest test suite
npm run lint     # type-check only (tsc --noEmit)
```

## Configuration

All configuration comes from environment variables (see `src/config.ts`):

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `8080` | HTTP listen port |
| `BSV_NETWORK` | `main` | `main` or `test` |
| `WAB_BASE_URL` | `https://wab.peck.to` | Wallet Authentication Backend |
| `OVERLAY_BASE_URL` | `https://overlay.peck.to` | Overlay service base URL |
| `OVERLAY_TOPIC` | `peck-schema` | Overlay topic to submit to |
| `MARGIN_APP_NAME` | `margin` | App name written into the MAP record |
| `CORS_ORIGINS` | `*` | Comma-separated allowed origins, or `*` |

The sponsor wallet is configured via the `SPONSOR_PRIVATE_KEY_HEX`, `SPONSOR_INITIAL_UTXO`, and `SPONSOR_PARENT_TX_HEX` secrets.

## Deployment

A `Dockerfile` (multi-stage Node 20 build) and `cloudbuild.yaml` are provided for building and deploying to Cloud Run.

## License

[Open BSV License](LICENSE).
