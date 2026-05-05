/**
 * Thin HTTP client for WAB's /auth/margin/* endpoints.
 *
 * Margin-api never holds private keys. The canonical-AIP flow is:
 *   1) marginIdentity(id_token)            → signing_address + pubkey
 *   2) build canonical AIP preimage locally (needs the address)
 *   3) marginSign({id_token, message=preimageHex, encoding="hex"}) → signature
 */

export interface WabIdentityRequest {
    id_token: string;
}

export interface WabIdentityResponse {
    signing_address: string;  // P2PKH derived from OAuth sub
    signing_pubkey: string;   // compressed pubkey hex
    provider: string;         // "google"
}

export interface WabSignRequest {
    id_token: string;
    /** Bytes to sign, encoded per `message_encoding`. WAB is opaque to what
     *  these bytes represent — for canonical AIP this is the concatenation
     *  of all preceding pushdata-bytes in the OP_RETURN. */
    message: string;
    message_encoding?: "utf8" | "hex" | "base64";
}

export interface WabSignResponse {
    signature: string;        // BSM base64
    signing_address: string;  // P2PKH derived from OAuth sub
    signing_pubkey: string;   // compressed pubkey hex
    provider: string;         // "google"
}

export class WabError extends Error {
    constructor(public readonly status: number, message: string) {
        super(message);
        this.name = "WabError";
    }
}

export class WabClient {
    constructor(private readonly baseUrl: string) {}

    async marginIdentity(req: WabIdentityRequest): Promise<WabIdentityResponse> {
        const url = `${this.baseUrl.replace(/\/+$/, "")}/auth/margin/identity`;
        const res = await fetch(url, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(req),
        });
        if (!res.ok) {
            const detail = await res.text().catch(() => "");
            throw new WabError(res.status, `WAB margin/identity failed: ${res.status} ${detail}`);
        }
        return await res.json() as WabIdentityResponse;
    }

    async marginSign(req: WabSignRequest): Promise<WabSignResponse> {
        const url = `${this.baseUrl.replace(/\/+$/, "")}/auth/margin/sign`;
        const res = await fetch(url, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(req),
        });
        if (!res.ok) {
            const detail = await res.text().catch(() => "");
            throw new WabError(res.status, `WAB margin/sign failed: ${res.status} ${detail}`);
        }
        return await res.json() as WabSignResponse;
    }
}
