import request from "supertest";
import { BSM, PublicKey, PrivateKey, Signature, Transaction, Utils } from "@bsv/sdk";
import { buildApp } from "../src/app";
import { Config } from "../src/config";
import {
    WabClient, WabError,
    WabIdentityRequest, WabIdentityResponse,
    WabSignRequest, WabSignResponse,
} from "../src/services/WabClient";
import { OverlayClient, OverlayError } from "../src/services/OverlayClient";
import { SponsorWallet } from "../src/services/SponsorWallet";
import { PROTO_B, PROTO_MAP, PROTO_AIP } from "../src/services/BitcoinSchemaBuilder";

/**
 * Manual OP_RETURN pushdata parser. Returns each pushed chunk as a raw
 * byte buffer so canonical-AIP preimage reconstruction is byte-exact
 * (utf8 round-tripping would corrupt non-ASCII or signature bytes).
 */
function parseOpReturnPushes(hex: string): Buffer[] {
    if (!hex.startsWith("006a")) throw new Error("not an OP_FALSE OP_RETURN script");
    const chunks: Buffer[] = [];
    let i = 4;
    while (i < hex.length) {
        const byte = parseInt(hex.substring(i, i + 2), 16);
        i += 2;
        let len = 0;
        if (byte >= 0x01 && byte <= 0x4b) {
            len = byte;
        } else if (byte === 0x4c) {
            len = parseInt(hex.substring(i, i + 2), 16);
            i += 2;
        } else if (byte === 0x4d) {
            const h = hex.substring(i, i + 4);
            len = parseInt(h.match(/../g)!.reverse().join(""), 16);
            i += 4;
        } else if (byte === 0x4e) {
            const h = hex.substring(i, i + 8);
            len = parseInt(h.match(/../g)!.reverse().join(""), 16);
            i += 8;
        } else {
            continue;
        }
        const dataHex = hex.substring(i, i + len * 2);
        i += len * 2;
        chunks.push(Buffer.from(dataHex, "hex"));
    }
    return chunks;
}

function pushesAsUtf8(pushes: Buffer[]): string[] {
    return pushes.map(b => b.toString("utf8"));
}

const TEST_PRIV = PrivateKey.fromString("a".repeat(64), 16);
const TEST_PUB = TEST_PRIV.toPublicKey();
const TEST_ADDR = TEST_PRIV.toAddress("mainnet") as string;

class FakeWab extends WabClient {
    public lastSignRequest?: WabSignRequest;
    public lastIdentityRequest?: WabIdentityRequest;
    public override async marginIdentity(req: WabIdentityRequest): Promise<WabIdentityResponse> {
        this.lastIdentityRequest = req;
        if (req.id_token === "REJECT_401") throw new WabError(401, "WAB rejected token");
        if (req.id_token === "WAB_DOWN") throw new WabError(503, "upstream timeout");
        return {
            signing_address: TEST_ADDR,
            signing_pubkey: TEST_PUB.toString(),
            provider: "google",
        };
    }
    public override async marginSign(req: WabSignRequest): Promise<WabSignResponse> {
        this.lastSignRequest = req;
        if (req.id_token === "REJECT_401") throw new WabError(401, "WAB rejected token");
        if (req.id_token === "WAB_DOWN") throw new WabError(503, "upstream timeout");
        if (req.id_token === "SIGN_DOWN") throw new WabError(503, "sign upstream down");
        const enc = req.message_encoding ?? "utf8";
        const messageBytes = Utils.toArray(req.message, enc);
        const sig = BSM.sign(messageBytes, TEST_PRIV, "base64") as string;
        return {
            signature: sig,
            signing_address: TEST_ADDR,
            signing_pubkey: TEST_PUB.toString(),
            provider: "google",
        };
    }
    constructor() { super("http://fake-wab"); }
}

class FakeOverlay extends OverlayClient {
    public submitCalls: { beefHex: string; topics: string[] }[] = [];
    public mode: "ok" | "no-admit" | "http-500" = "ok";
    constructor() { super("http://fake-overlay"); }
    public override async submit(beefHex: string, topics: string[] = ["peck-schema"]) {
        this.submitCalls.push({ beefHex, topics });
        if (this.mode === "no-admit") {
            throw new OverlayError(200, "overlay admitted no outputs (test)");
        }
        if (this.mode === "http-500") {
            throw new OverlayError(500, "overlay 500 (test)");
        }
        return {
            httpStatus: 200,
            steak: { "peck-schema": { outputsToAdmit: [0], coinsToRetain: [] } },
        };
    }
}

/**
 * Build a sponsor wallet seeded from a signed parent TX with one
 * 100k-sat P2PKH output to TEST_ADDR. Mirrors a real funding TX.
 */
async function buildFundedSponsor(): Promise<SponsorWallet> {
    const { P2PKH } = require("@bsv/sdk");
    // Outer dummy TX: we never serialize it, just use its outputs.
    const dummy = new Transaction();
    dummy.addOutput({ lockingScript: new P2PKH().lock(TEST_ADDR), satoshis: 200_000 });

    // Parent TX: spends the dummy, pays TEST_ADDR 100k. Signed so .id() works.
    const parent = new Transaction();
    parent.addInput({
        sourceTransaction: dummy,
        sourceOutputIndex: 0,
        unlockingScriptTemplate: new P2PKH().unlock(TEST_PRIV),
    });
    parent.addOutput({ lockingScript: new P2PKH().lock(TEST_ADDR), satoshis: 100_000 });
    await parent.sign();

    const wallet = new SponsorWallet(TEST_PRIV, "main");
    wallet.seed({
        txid: parent.id("hex") as string,
        vout: 0,
        satoshis: 100_000,
        sourceTransaction: parent,
    });
    return wallet;
}

const config: Config = {
    port: 0,
    wabBaseUrl: "http://fake-wab",
    overlayBaseUrl: "http://fake-overlay",
    overlayTopic: "peck-schema",
    network: "main",
    appName: "margin",
    corsOrigins: "*",
};

interface Setup {
    wab: FakeWab;
    overlay: FakeOverlay;
    sponsor: SponsorWallet | null;
    app: ReturnType<typeof buildApp>;
}

async function setup(opts: { withSponsor?: boolean; overlayMode?: FakeOverlay["mode"] } = {}): Promise<Setup> {
    const wab = new FakeWab();
    const overlay = new FakeOverlay();
    if (opts.overlayMode) overlay.mode = opts.overlayMode;
    const sponsor = opts.withSponsor === false ? null : await buildFundedSponsor();
    const app = buildApp(config, { wab, overlay, sponsor });
    return { wab, overlay, sponsor, app };
}

describe("GET /health", () => {
    it("returns service info with sponsor status", async () => {
        const { app } = await setup();
        const res = await request(app).get("/health");
        expect(res.status).toBe(200);
        expect(res.body.ok).toBe(true);
        expect(res.body.service).toBe("margin-api");
        expect(res.body.network).toBe("main");
        expect(res.body.sponsor).toMatchObject({
            address: TEST_ADDR,
            balance_sats: 100_000,
            ready: true,
        });
    });

    it("reports null sponsor when not configured", async () => {
        const { app } = await setup({ withSponsor: false });
        const res = await request(app).get("/health");
        expect(res.body.sponsor).toBeNull();
    });
});

describe("POST /post — input validation", () => {
    it("400 on missing url", async () => {
        const { app } = await setup();
        const res = await request(app).post("/post").send({ comment: "hi", id_token: "t" });
        expect(res.status).toBe(400);
    });
    it("400 on missing comment", async () => {
        const { app } = await setup();
        const res = await request(app).post("/post").send({ url: "https://example.com/", id_token: "t" });
        expect(res.status).toBe(400);
    });
    it("400 on missing id_token", async () => {
        const { app } = await setup();
        const res = await request(app).post("/post").send({ url: "https://example.com/", comment: "hi" });
        expect(res.status).toBe(400);
    });
    it("400 on invalid url scheme", async () => {
        const { app } = await setup();
        const res = await request(app).post("/post").send({
            url: "javascript:alert(1)", comment: "hi", id_token: "t"
        });
        expect(res.status).toBe(400);
    });
    it("400 on comment > 500 chars (free tier limit)", async () => {
        const { app } = await setup();
        const res = await request(app).post("/post").send({
            url: "https://example.com/", comment: "x".repeat(501), id_token: "t"
        });
        expect(res.status).toBe(400);
    });
});

describe("POST /post — happy path", () => {
    it("returns assembled OP_RETURN, broadcasts, returns txid", async () => {
        const { app, wab, overlay, sponsor } = await setup();
        const res = await request(app).post("/post").send({
            url: "HTTPS://Example.COM/Article?utm_source=newsletter",
            comment: "First Margin comment ever 🌀",
            id_token: "valid-token",
        });

        expect(res.status).toBe(200);
        expect(res.body.context_urn).toBe("url:https://example.com/Article");
        expect(res.body.signing_address).toBe(TEST_ADDR);
        expect(res.body.signing_pubkey).toBe(TEST_PUB.toString());
        expect(res.body.app).toBe("margin");
        expect(typeof res.body.script_hex).toBe("string");
        expect(typeof res.body.txid).toBe("string");
        expect(res.body.txid).toMatch(/^[0-9a-f]{64}$/);

        // Margin-api asked WAB for identity first
        expect(wab.lastIdentityRequest?.id_token).toBe("valid-token");
        // Then asked WAB to sign canonical preimage hex
        expect(wab.lastSignRequest?.message_encoding).toBe("hex");
        expect(wab.lastSignRequest?.message).toMatch(/^[0-9a-f]+$/);

        // Overlay was called once with the BEEF
        expect(overlay.submitCalls.length).toBe(1);
        expect(overlay.submitCalls[0].topics).toEqual(["peck-schema"]);
        expect(overlay.submitCalls[0].beefHex).toMatch(/^[0-9a-f]+$/);

        // Sponsor wallet advanced — balance dropped by exactly the fee
        expect(sponsor!.currentBalance()).toBeLessThan(100_000);
        expect(sponsor!.currentBalance()).toBeGreaterThan(99_500);  // small fee for ~349-byte script
    });

    it("script_hex contains B + MAP + AIP in canonical order", async () => {
        const { app } = await setup();
        const res = await request(app).post("/post").send({
            url: "https://example.com/foo",
            comment: "Hello world",
            id_token: "valid-token",
        });
        expect(res.status).toBe(200);

        const pushes = pushesAsUtf8(parseOpReturnPushes(res.body.script_hex));
        expect(pushes[0]).toBe(PROTO_B);
        expect(pushes[1]).toBe("Hello world");
        expect(pushes[5]).toBe(PROTO_MAP);
        expect(pushes[14]).toBe(PROTO_AIP);
        expect(pushes[15]).toBe("BITCOIN_ECDSA");
        expect(pushes[16]).toBe(TEST_ADDR);
    });

    it("AIP signature verifies canonically against signing_address", async () => {
        const { app } = await setup();
        const comment = "Verify me on chain";
        const res = await request(app).post("/post").send({
            url: "https://example.com/article",
            comment,
            id_token: "valid-token",
        });

        const pushes = parseOpReturnPushes(res.body.script_hex);
        const signatureB64 = pushes[pushes.length - 1].toString("utf8");
        const preimageBytes: number[] = [];
        for (let i = 0; i < pushes.length - 1; i++) preimageBytes.push(...pushes[i]);

        const sig = Signature.fromCompact(signatureB64, "base64");
        const pubKey = PublicKey.fromString(res.body.signing_pubkey);
        expect(BSM.verify(preimageBytes, sig, pubKey)).toBe(true);
        expect(pubKey.toAddress("mainnet")).toBe(res.body.signing_address);
    });

    it("never writes the OAuth handle into the script payload", async () => {
        const { app } = await setup();
        const res = await request(app).post("/post").send({
            url: "https://example.com/x",
            comment: "no PII please",
            id_token: "valid-token",
        });
        const pushes = pushesAsUtf8(parseOpReturnPushes(res.body.script_hex));
        for (const p of pushes) {
            expect(p).not.toMatch(/@/);
            expect(p.toLowerCase()).not.toContain("oauth");
            expect(p.toLowerCase()).not.toContain("google");
            expect(p.toLowerCase()).not.toContain("sub:");
        }
    });
});

describe("POST /post — WAB error propagation", () => {
    it("forwards 401 from WAB unchanged (identity stage)", async () => {
        const { app } = await setup();
        const res = await request(app).post("/post").send({
            url: "https://example.com/", comment: "hi", id_token: "REJECT_401",
        });
        expect(res.status).toBe(401);
    });

    it("masks WAB 5xx as 502 (identity stage)", async () => {
        const { app } = await setup();
        const res = await request(app).post("/post").send({
            url: "https://example.com/", comment: "hi", id_token: "WAB_DOWN",
        });
        expect(res.status).toBe(502);
    });
});

describe("POST /post — broadcast layer", () => {
    it("returns 503 when sponsor wallet is not configured", async () => {
        const { app } = await setup({ withSponsor: false });
        const res = await request(app).post("/post").send({
            url: "https://example.com/", comment: "hi", id_token: "valid",
        });
        expect(res.status).toBe(503);
    });

    it("returns 502 when overlay rejects (no admission)", async () => {
        const { app, sponsor } = await setup({ overlayMode: "no-admit" });
        const before = sponsor!.currentBalance();
        const res = await request(app).post("/post").send({
            url: "https://example.com/", comment: "hi", id_token: "valid",
        });
        expect(res.status).toBe(502);
        // UTXO chain NOT advanced on failure
        expect(sponsor!.currentBalance()).toBe(before);
    });

    it("returns 502 when overlay HTTP 500", async () => {
        const { app, sponsor } = await setup({ overlayMode: "http-500" });
        const before = sponsor!.currentBalance();
        const res = await request(app).post("/post").send({
            url: "https://example.com/", comment: "hi", id_token: "valid",
        });
        expect(res.status).toBe(502);
        expect(sponsor!.currentBalance()).toBe(before);
    });

    it("two consecutive successful posts chain UTXOs correctly", async () => {
        const { app, sponsor, overlay } = await setup();
        const before = sponsor!.currentBalance();

        const res1 = await request(app).post("/post").send({
            url: "https://example.com/a", comment: "first", id_token: "valid",
        });
        expect(res1.status).toBe(200);
        const balance1 = sponsor!.currentBalance();
        expect(balance1).toBeLessThan(before);

        const res2 = await request(app).post("/post").send({
            url: "https://example.com/b", comment: "second", id_token: "valid",
        });
        expect(res2.status).toBe(200);
        expect(sponsor!.currentBalance()).toBeLessThan(balance1);

        // Different txids, two overlay submits
        expect(res1.body.txid).not.toBe(res2.body.txid);
        expect(overlay.submitCalls.length).toBe(2);
    });
});
