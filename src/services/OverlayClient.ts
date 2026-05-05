/**
 * Client for overlay.peck.to /submit.
 *
 * Pattern from peck-broadcaster/main.py:113-161. Critical detail: overlay
 * returns 200 for an *accepted* TX even when the topic manager admits NO
 * outputs. Treating 200 as success without checking STEAK leads to silent
 * data loss (TX broadcasts but never lands in feed). We always inspect
 * outputsToAdmit.
 *
 * 409 = "already seen" — also acceptable.
 */

export interface STEAKResult {
    [topic: string]: {
        outputsToAdmit?: number[];
        coinsToRetain?: number[];
    } | undefined;
}

export interface SubmitResult {
    httpStatus: number;
    steak: STEAKResult | null;
}

export class OverlayError extends Error {
    constructor(public readonly status: number, message: string) {
        super(message);
        this.name = "OverlayError";
    }
}

export class OverlayClient {
    constructor(private readonly baseUrl: string) {}

    /**
     * POST raw BEEF bytes (hex-decoded) to /submit. Verifies that the
     * configured topic admitted at least one output. Throws OverlayError on
     * any rejection — including 200 with empty outputsToAdmit, which is the
     * silent-failure mode peck-broadcaster's comment warns about.
     */
    async submit(beefHex: string, topics: string[] = ["peck-schema"]): Promise<SubmitResult> {
        const url = `${this.baseUrl.replace(/\/+$/, "")}/submit`;
        const body = Buffer.from(beefHex, "hex");

        const res = await fetch(url, {
            method: "POST",
            headers: {
                "content-type": "application/octet-stream",
                "x-topics": JSON.stringify(topics),
            },
            body,
        });

        if (res.status !== 200 && res.status !== 409) {
            const text = await res.text().catch(() => "");
            throw new OverlayError(res.status, `overlay /submit ${res.status}: ${text.slice(0, 300)}`);
        }

        let steak: STEAKResult | null = null;
        try {
            steak = (await res.json()) as STEAKResult;
        } catch {
            // 200 with no parseable body — overlay accepted but gave us nothing
            // to verify. Treat as accepted; caller has the txid from the TX itself.
            return { httpStatus: res.status, steak: null };
        }

        const admittedAny = topics.some(t => {
            const r = steak?.[t];
            return r && Array.isArray(r.outputsToAdmit) && r.outputsToAdmit.length > 0;
        });

        if (!admittedAny) {
            throw new OverlayError(
                res.status,
                `overlay accepted TX but admitted no outputs to topics ${topics.join(",")} — schema may be malformed. STEAK: ${JSON.stringify(steak).slice(0, 300)}`,
            );
        }

        return { httpStatus: res.status, steak };
    }
}
