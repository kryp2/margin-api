/**
 * PostController — orchestrates the Margin post pipeline (canonical AIP).
 *
 *   client → POST /post {url, comment, id_token}
 *      ↓
 *   canonicalize URL via @margin/url-canon
 *      ↓
 *   WAB /auth/margin/identity   ← derive address (no signing yet)
 *      ↓
 *   buildMarginPreimage()       ← assemble B + MAP + AIP-header, compute preimage
 *      ↓
 *   WAB /auth/margin/sign       ← BSM-sign canonical preimage hex
 *      ↓
 *   appendMarginSignature()     ← finalize OP_RETURN
 *      ↓
 *   return {script_hex, signing_address, context_urn, …}
 *
 * Broadcast is intentionally NOT in this endpoint. Caller (extension or
 * margin-api /broadcast in a future iteration) builds the TX with sponsor
 * UTXOs and submits to the broadcaster.
 */

import { Request, Response } from "express";
import { toContextUrn, InvalidUrlError } from "../lib/urlCanon";
import { WabClient, WabError } from "../services/WabClient";
import { buildMarginPreimage, appendMarginSignature } from "../services/BitcoinSchemaBuilder";
import { SponsorWallet, NoSeededUtxoError, InsufficientFundsError } from "../services/SponsorWallet";
import { OverlayClient, OverlayError } from "../services/OverlayClient";
import { Config } from "../config";

export class PostController {
    constructor(
        private readonly wab: WabClient,
        private readonly config: Config,
        private readonly sponsor: SponsorWallet | null,
        private readonly overlay: OverlayClient,
    ) {}

    /**
     * POST /post
     * Body: { url: string, comment: string, id_token: string }
     * Response: { script_hex, context_urn, signing_address, signing_pubkey, app }
     */
    public post = async (req: Request, res: Response): Promise<void> => {
        const { url, comment, id_token } = req.body ?? {};

        if (typeof url !== "string" || !url) {
            res.status(400).json({ error: "url is required" });
            return;
        }
        if (typeof comment !== "string" || comment.length === 0) {
            res.status(400).json({ error: "comment is required" });
            return;
        }
        if (typeof id_token !== "string" || !id_token) {
            res.status(400).json({ error: "id_token is required" });
            return;
        }
        if (comment.length > 500) {
            // Free tier limit per SPEC §7.3. Premium expansion handled separately.
            res.status(400).json({ error: "comment exceeds free-tier limit of 500 characters" });
            return;
        }

        let contextUrn: string;
        try {
            contextUrn = toContextUrn(url);
        } catch (e) {
            if (e instanceof InvalidUrlError) {
                res.status(400).json({ error: e.message });
                return;
            }
            throw e;
        }

        // Phase 1: get the user's signing address from WAB. Required up-front
        // because the canonical AIP preimage includes signing_address before
        // the signature is computed.
        let identity;
        try {
            identity = await this.wab.marginIdentity({ id_token });
        } catch (e) {
            if (e instanceof WabError) {
                if (e.status >= 400 && e.status < 500) {
                    res.status(e.status).json({ error: "WAB rejected identity request", detail: e.message });
                } else {
                    console.error("[PostController] WAB upstream error (identity):", e);
                    res.status(502).json({ error: "WAB upstream error" });
                }
                return;
            }
            throw e;
        }

        // Phase 2: build canonical AIP preimage with the resolved pubkey.
        // BRC-77 lane (peck-social-v1 §2.2 v1.1) — pubkey-hex in signing-
        // identifier slot, sha256 (not BSM-magic) over preimage, raw DER sig.
        const { script, preimageHex } = buildMarginPreimage({
            content: comment,
            contextUrn,
            app: this.config.appName,
            signingPubKeyHex: identity.signing_pubkey,
        });

        // Phase 3: send the canonical preimage bytes to WAB. WAB applies sha256
        // internally and signs — DER signature covers sha256(preimage), which
        // matches what peck-indexer-go's verifyAIPBRC77 reconstructs.
        let wabResp;
        try {
            wabResp = await this.wab.marginSign({
                id_token,
                message: preimageHex,
                message_encoding: "hex",
                signature_format: "ecdsa-der",
            });
        } catch (e) {
            if (e instanceof WabError) {
                if (e.status >= 400 && e.status < 500) {
                    res.status(e.status).json({ error: "WAB rejected sign request", detail: e.message });
                } else {
                    console.error("[PostController] WAB upstream error (sign):", e);
                    res.status(502).json({ error: "WAB upstream error" });
                }
                return;
            }
            throw e;
        }

        // Sanity: WAB should return the same pubkey from identity and sign —
        // both derive from the same OAuth sub. Mismatch means token swap.
        if (wabResp.signing_pubkey !== identity.signing_pubkey) {
            console.error(
                "[PostController] WAB pubkey mismatch between identity and sign — possible token swap",
            );
            res.status(500).json({ error: "WAB returned mismatched signing pubkeys" });
            return;
        }

        // Phase 4: append signature to finalize the script.
        appendMarginSignature(script, wabResp.signature);

        // Phase 5: broadcast via sponsor wallet → overlay.
        if (!this.sponsor || !this.sponsor.hasUtxo()) {
            res.status(503).json({
                error: "sponsor wallet not available — margin-api cannot broadcast right now",
            });
            return;
        }

        let build;
        try {
            build = await this.sponsor.buildSpendingTo(script);
        } catch (e) {
            if (e instanceof InsufficientFundsError) {
                res.status(503).json({ error: "sponsor wallet out of funds" });
                return;
            }
            if (e instanceof NoSeededUtxoError) {
                res.status(503).json({ error: "sponsor wallet has no UTXO state" });
                return;
            }
            throw e;
        }

        try {
            await this.overlay.submit(build.beefHex, [this.config.overlayTopic]);
        } catch (e) {
            if (e instanceof OverlayError) {
                console.error("[PostController] overlay rejected:", e.message);
                res.status(502).json({ error: "overlay rejected broadcast", detail: e.message });
                return;
            }
            throw e;
        }

        // Overlay accepted + admitted — commit the new UTXO chain.
        this.sponsor.advance(build.changeUtxo);

        res.json({
            txid: build.txid,
            script_hex: script.toHex(),
            context_urn: contextUrn,
            signing_address: identity.signing_address,
            signing_pubkey: identity.signing_pubkey,
            app: this.config.appName,
        });
    };
}
