/**
 * Sponsor wallet for Margin posts.
 *
 * Single in-memory UTXO model: one funded address, sequential broadcasts,
 * each TX consumes the previous change output. Pattern adapted from
 * peck-mcp/classics-actions.ts:100-128.
 *
 * The wallet is build-only — it produces a signed TX + BEEF + new change
 * UTXO descriptor. Caller (PostController) decides whether to advance the
 * UTXO state based on overlay submit success. This keeps the wallet from
 * "losing" funds when broadcast fails.
 *
 * Funding model for v1:
 *   SPONSOR_PRIVATE_KEY_HEX  — 32-byte hex
 *   SPONSOR_INITIAL_UTXO     — "txid:vout:satoshis" (the initial funding)
 *   SPONSOR_PARENT_TX_HEX    — raw hex of the funding TX (so BEEF can include it)
 *
 * After deploy, fund the sponsor address with one TX, set those env vars,
 * boot. Subsequent broadcasts chain off the in-memory state until process
 * restart, at which point the env values seed again (so the env should be
 * updated to the latest UTXO before redeploy, OR we add persistence).
 */

import { PrivateKey, Transaction, P2PKH, Script } from "@bsv/sdk";

export interface UtxoState {
    txid: string;
    vout: number;
    satoshis: number;
    /** Parent TX so BEEF can carry the input chain. */
    sourceTransaction: Transaction;
}

export interface BroadcastBuildResult {
    txid: string;
    rawHex: string;
    /** BEEF as hex — overlay /submit takes octet-stream of these bytes. */
    beefHex: string;
    /** New change UTXO if caller commits this build. */
    changeUtxo: UtxoState;
}

export class InsufficientFundsError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "InsufficientFundsError";
    }
}

export class NoSeededUtxoError extends Error {
    constructor() {
        super("sponsor wallet has no seeded UTXO");
        this.name = "NoSeededUtxoError";
    }
}

const FEE_RATE_SAT_PER_KB = 100;  // peck convention; never reduce — see feedback_never_touch_fee_rate

export class SponsorWallet {
    private currentUtxo: UtxoState | null = null;
    private buildLock: Promise<unknown> = Promise.resolve();

    constructor(
        private readonly privateKey: PrivateKey,
        private readonly network: "main" | "test",
    ) {}

    seed(utxo: UtxoState): void {
        this.currentUtxo = utxo;
    }

    advance(utxo: UtxoState): void {
        this.currentUtxo = utxo;
    }

    address(): string {
        return this.privateKey.toAddress(this.network === "main" ? "mainnet" : "testnet") as string;
    }

    currentBalance(): number {
        return this.currentUtxo?.satoshis ?? 0;
    }

    hasUtxo(): boolean {
        return this.currentUtxo !== null;
    }

    /**
     * Build + sign a TX with the OP_RETURN as the first output and change
     * back to the sponsor address. Mutex-serialized — concurrent calls are
     * queued so they don't double-spend the same UTXO.
     */
    async buildSpendingTo(opReturnScript: Script): Promise<BroadcastBuildResult> {
        const next = this.buildLock.then(() => this._build(opReturnScript));
        // Swallow rejection on the lock chain so a failed build doesn't block subsequent builds.
        this.buildLock = next.catch(() => undefined);
        return next;
    }

    private async _build(opReturnScript: Script): Promise<BroadcastBuildResult> {
        const utxo = this.currentUtxo;
        if (!utxo) throw new NoSeededUtxoError();

        const addr = this.address();
        const tx = new Transaction();
        tx.addInput({
            sourceTransaction: utxo.sourceTransaction,
            sourceOutputIndex: utxo.vout,
            unlockingScriptTemplate: new P2PKH().unlock(this.privateKey),
        });
        tx.addOutput({ lockingScript: opReturnScript, satoshis: 0 });

        // Size estimate — input ~148, OP_RETURN script len + 9 overhead, change output 34, base 10.
        const opReturnBytes = opReturnScript.toBinary().length;
        const estSize = 10 + 148 + 10 + opReturnBytes + 34;
        const fee = Math.max(20, Math.ceil(estSize * FEE_RATE_SAT_PER_KB / 1000));
        const change = utxo.satoshis - fee;
        if (change < 1) {
            throw new InsufficientFundsError(`utxo has ${utxo.satoshis} sat, fee ${fee}`);
        }

        tx.addOutput({ lockingScript: new P2PKH().lock(addr), satoshis: change });
        await tx.sign();

        const rawHex = tx.toHex();
        const txid = tx.id("hex") as string;
        // toBEEF() returns number[]; hex-encode for transport.
        const beefBytes = tx.toBEEF();
        const beefHex = Buffer.from(beefBytes).toString("hex");

        const changeUtxo: UtxoState = {
            txid,
            vout: 1,
            satoshis: change,
            sourceTransaction: tx,
        };

        return { txid, rawHex, beefHex, changeUtxo };
    }
}

/**
 * Build a SponsorWallet from process.env. Returns null if any required env
 * is missing — margin-api still runs, but POST /post returns 503 instead of
 * broadcasting. This lets us deploy and verify other layers before funding.
 */
export function loadSponsorWalletFromEnv(): SponsorWallet | null {
    const keyHex = process.env.SPONSOR_PRIVATE_KEY_HEX;
    const utxoStr = process.env.SPONSOR_INITIAL_UTXO;
    const parentHex = process.env.SPONSOR_PARENT_TX_HEX;
    if (!keyHex || !utxoStr || !parentHex) return null;

    const network = (process.env.BSV_NETWORK ?? "main") as "main" | "test";
    const wallet = new SponsorWallet(PrivateKey.fromString(keyHex, 16), network);

    const parts = utxoStr.split(":");
    if (parts.length !== 3) {
        throw new Error(`SPONSOR_INITIAL_UTXO must be "txid:vout:satoshis", got "${utxoStr}"`);
    }
    const [txid, voutStr, satsStr] = parts;
    wallet.seed({
        txid,
        vout: parseInt(voutStr, 10),
        satoshis: parseInt(satsStr, 10),
        sourceTransaction: Transaction.fromHex(parentHex),
    });

    return wallet;
}
