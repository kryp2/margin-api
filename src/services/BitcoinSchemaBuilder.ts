/**
 * Bitcoin Schema OP_RETURN builder for Margin URL-anchored comments.
 *
 * Two-phase canonical AIP:
 *   Phase 1: buildMarginPreimage() assembles everything up through the AIP
 *            block's signing_address — the "preceding pushdata" the AIP
 *            signature must cover. Returns the partial Script + a hex
 *            preimage to hand to WAB.
 *   Phase 2: appendMarginSignature() pushes the signature returned by WAB
 *            as the final pushdata, producing the complete OP_RETURN.
 *
 * The signature covers the concatenation of every preceding pushdata-content
 * byte (including the pipe-separator bytes 0x7c that delimit the protocol
 * blocks, and the AIP block's PROTO_AIP / "BITCOIN_ECDSA" / signing_address
 * fields). This matches canonical Bitcom AIP — verifiable by any compliant
 * AIP verifier — not the legacy peck.to shortcut sha256(content).
 *
 * margin-api never holds a private key. WAB derives + signs in-memory after
 * Firebase id_token verification.
 *
 * Layout produced:
 *
 *   OP_FALSE OP_RETURN
 *     <PROTO_B>
 *     <comment-text-utf8>
 *     <mime-type "text/markdown">
 *     <encoding "UTF-8">
 *   |
 *     <PROTO_MAP>
 *     "SET"
 *     "app"     <app-name>
 *     "type"    "comment"
 *     "context" <context-urn, e.g. "url:https://...">
 *   |
 *     <PROTO_AIP>
 *     "BITCOIN_ECDSA"
 *     <signing-address>          ← end of Phase 1; preimage covers up to here
 *     <signature-base64>         ← Phase 2 appends this
 *
 * Pipe-byte gotcha: "|" must be pushed as a single 0x7c byte (Script.writeBin
 * wraps the length), not as raw 0x7c — raw is OP_SWAP and breaks parsing.
 *
 * Privacy: B and MAP fields contain ONLY signing_address (via AIP) and the
 * comment + context-URN. NEVER write the OAuth handle (email, sub, name) into
 * the script — keep linkability between K1 and the OAuth account opt-in via
 * a separate cert layer, never baked into post payloads.
 */

import { Script, OP } from "@bsv/sdk";

export const PROTO_B = "19HxigV4QyBv3tHpQVcUEQyq1pzZVdoAut";
export const PROTO_MAP = "1PuQa7K62MiKCtssSLKy1kh56WWU7MtUR5";
export const PROTO_AIP = "15PciHG22SNLQJXMoSUaWVi7WSqc7hCfva";
const PIPE = 0x7c;

function toBytes(data: string | number[]): number[] {
    if (typeof data === "string") return Array.from(Buffer.from(data, "utf8"));
    return data;
}

/** Push pushdata to the script AND accumulate the content bytes into acc
 *  (the running canonical-AIP preimage). */
function pushAcc(s: Script, acc: number[], data: string | number[]): void {
    const bytes = toBytes(data);
    acc.push(...bytes);
    s.writeBin(bytes);
}

/** Pipe separator. 0x7c is written as a 1-byte pushdata to the script and
 *  appended as a single content byte to the preimage. */
function pipeAcc(s: Script, acc: number[]): void {
    acc.push(PIPE);
    s.writeBin([PIPE]);
}

export interface BuildMarginPreimageOpts {
    /** The user's comment text (UTF-8). */
    content: string;
    /** Already-canonicalized context URN, e.g. "url:https://example.com/foo". */
    contextUrn: string;
    /** App name in the MAP record — typically "margin". */
    app: string;
    /** AIP signing address fetched from WAB /auth/margin/identity. */
    signingAddress: string;
}

export interface MarginPreimageResult {
    /** Partial OP_RETURN script — needs appendMarginSignature() to complete. */
    script: Script;
    /** Hex of all preceding pushdata-content bytes — send to WAB to sign. */
    preimageHex: string;
}

/**
 * Phase 1: assemble B + MAP + AIP-header into the script and produce the
 * canonical AIP preimage as hex. Caller forwards preimageHex to WAB.
 */
export function buildMarginPreimage(opts: BuildMarginPreimageOpts): MarginPreimageResult {
    const s = new Script();
    s.writeOpCode(OP.OP_FALSE);
    s.writeOpCode(OP.OP_RETURN);
    const acc: number[] = [];

    // B section
    pushAcc(s, acc, PROTO_B);
    pushAcc(s, acc, opts.content);
    pushAcc(s, acc, "text/markdown");
    pushAcc(s, acc, "UTF-8");

    pipeAcc(s, acc);

    // MAP section
    pushAcc(s, acc, PROTO_MAP);
    pushAcc(s, acc, "SET");
    pushAcc(s, acc, "app");     pushAcc(s, acc, opts.app);
    pushAcc(s, acc, "type");    pushAcc(s, acc, "comment");
    pushAcc(s, acc, "context"); pushAcc(s, acc, opts.contextUrn);

    pipeAcc(s, acc);

    // AIP header — signature is appended in Phase 2 and is NOT part of the preimage
    pushAcc(s, acc, PROTO_AIP);
    pushAcc(s, acc, "BITCOIN_ECDSA");
    pushAcc(s, acc, opts.signingAddress);

    return {
        script: s,
        preimageHex: Buffer.from(acc).toString("hex"),
    };
}

/**
 * Phase 2: append the WAB-supplied signature as the final pushdata.
 * Returns the same Script for convenience; mutation is in-place.
 *
 * Caller-discipline note: the partial Script returned from buildMarginPreimage
 * is unsigned and not safe to broadcast. If this builder is ever exposed
 * outside margin-api, switch to an opaque "pending" type that exposes only
 * preimageHex + finalize(signature) → Script so the unsigned form can't leak.
 */
export function appendMarginSignature(script: Script, signature: string): Script {
    const sigBytes = toBytes(signature);
    script.writeBin(sigBytes);
    return script;
}
