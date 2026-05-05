import express, { Request, Response } from "express";
import bodyParser from "body-parser";
import cors from "cors";
import rateLimit from "express-rate-limit";
import { Config } from "./config";
import { WabClient } from "./services/WabClient";
import { OverlayClient } from "./services/OverlayClient";
import { SponsorWallet } from "./services/SponsorWallet";
import { PostController } from "./controllers/PostController";

export interface AppDeps {
    wab?: WabClient;
    overlay?: OverlayClient;
    sponsor?: SponsorWallet | null;
}

export function buildApp(config: Config, deps: AppDeps = {}) {
    const wab = deps.wab ?? new WabClient(config.wabBaseUrl);
    const overlay = deps.overlay ?? new OverlayClient(config.overlayBaseUrl);
    const sponsor = deps.sponsor ?? null;

    const app = express();

    app.use(cors({
        origin: config.corsOrigins === "*" ? true : config.corsOrigins.split(",").map(s => s.trim()),
    }));
    app.use(bodyParser.json({ limit: "32kb" }));

    const postLimiter = rateLimit({
        windowMs: 60 * 1000,
        max: 10,
        standardHeaders: true,
        legacyHeaders: false,
        message: { error: "Too many post attempts, slow down." },
    });

    app.get("/health", (_req: Request, res: Response) => {
        res.json({
            ok: true,
            service: "margin-api",
            network: config.network,
            sponsor: sponsor ? {
                address: sponsor.address(),
                balance_sats: sponsor.currentBalance(),
                ready: sponsor.hasUtxo(),
            } : null,
        });
    });

    const postController = new PostController(wab, config, sponsor, overlay);
    app.post("/post", postLimiter, postController.post);

    return app;
}
