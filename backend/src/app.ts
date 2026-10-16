import express from "express";
import helmet from "helmet";
import cors from "cors";
import rateLimit from "express-rate-limit";

import { config } from "./config";
import { isAllowedOrigin, parseList } from "./lib/access";
import { jsonReplacer } from "./lib/json";
import { errorHandler } from "./middleware/errorHandler";
import { usersRouter } from "./routes/users";
import { directoryRouter } from "./routes/directory";
import { jobsRouter } from "./routes/jobs";
import { escrowRouter } from "./routes/escrow";
import { disputesRouter } from "./routes/disputes";
import { reputationRouter } from "./routes/reputation";
import { notificationsRouter } from "./routes/notifications";

export function createApp() {
  const app = express();

  app.use(helmet());

  // CORS_ORIGIN is a comma-separated allowlist of browser origins. When it is
  // unset we keep the permissive development behaviour, but saying so out loud
  // in production beats silently exposing the API to every origin.
  const allowedOrigins = parseList(config.CORS_ORIGIN);
  if (allowedOrigins.length === 0 && config.NODE_ENV === "production") {
    console.warn(
      "[cors] CORS_ORIGIN is unset in production — every origin may call this API. " +
        "Set it to your frontend origin, e.g. CORS_ORIGIN=https://your-app.vercel.app",
    );
  }
  app.use(
    cors({
      origin: (origin, callback) =>
        isAllowedOrigin(origin ?? undefined, allowedOrigins)
          ? callback(null, true)
          : callback(null, false),
    }),
  );

  app.use(express.json());
  // Prisma rows carry BigInt ids, which `JSON.stringify` throws on; without this
  // any route that returns a job or dispute row would 500 after a successful write.
  app.set("json replacer", jsonReplacer);
  app.use(rateLimit({ windowMs: 60_000, max: 100 }));

  app.get("/health", (_req, res) => res.json({ status: "ok" }));

  // The directory is `GET /api/users` (issue #68) and the profile/ auth routes
  // live on the same base path. Both are mounted: `usersRouter` has no `/`
  // route, so a directory listing falls through to the router below it, while
  // `/api/users/challenge` and `/api/users/:address` are still matched first.
  app.use("/api/users", usersRouter);
  app.use("/api/users", directoryRouter);
  app.use("/api/jobs", jobsRouter);
  app.use("/api/escrow", escrowRouter);
  app.use("/api/disputes", disputesRouter);
  app.use("/api/reputation", reputationRouter);
  app.use("/api/notifications", notificationsRouter);

  app.use(errorHandler);

  return app;
}
