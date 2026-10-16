/**
 * jobs.ts
 *
 * GET  /api/jobs          — list jobs (filterable by status, client, freelancer)
 * POST /api/jobs          — create a job (off-chain record; escrow funded separately)
 * GET  /api/jobs/:id      — get single job with milestones
 * PUT  /api/jobs/:id/assign — client assigns a freelancer
 */

import { Router } from "express";
import { z } from "zod";
import type { JobStatus } from "@prisma/client";
import { prisma } from "../db";
import { requireAuth } from "../middleware/auth";
import { validate } from "../middleware/validate";
import { AppError } from "../middleware/errorHandler";
import {
  formatAmount,
  getAsset,
  sumAmounts,
  toBaseUnits,
  UnknownAssetError,
  type AssetInfo,
} from "../lib/assets";
import { createJobSchema } from "../lib/schemas";

export const jobsRouter = Router();

// GET /api/jobs
jobsRouter.get("/", async (req, res, next) => {
  try {
    const { status, client, freelancer, page = "1", limit = "20" } = req.query;
    const jobs = await prisma.job.findMany({
      where: {
        // `?status=` is a Prisma enum column, so the value has to be narrowed to
        // `JobStatus` rather than cast to `any` — an invalid value is then a
        // Prisma validation error, not a silently erased type (issue #54).
        ...(status ? { status: String(status) as JobStatus } : {}),
        ...(client ? { client: { stellarAddress: String(client) } } : {}),
        ...(freelancer ? { freelancer: { stellarAddress: String(freelancer) } } : {}),
      },
      include: { milestones: true, client: true, freelancer: true },
      orderBy: { createdAt: "desc" },
      skip: (Number(page) - 1) * Number(limit),
      take: Number(limit),
    });
    res.json(jobs);
  } catch (err) {
    next(err);
  }
});

// POST /api/jobs
jobsRouter.post("/", requireAuth, validate(createJobSchema), async (req, res, next) => {
  try {
    const { title, description, milestones, expiresAt, asset } = req.body as z.infer<
      typeof createJobSchema
    >;

    let assetInfo: AssetInfo;
    try {
      assetInfo = getAsset(asset);
    } catch (err) {
      if (err instanceof UnknownAssetError) throw new AppError(400, err.message);
      throw err;
    }

    const client = await prisma.user.findUnique({
      where: { stellarAddress: res.locals.stellarAddress },
    });
    if (!client) throw new AppError(404, "User not found — call /api/users/auth first");

    // Sum in the asset's integer base units and format once. Adding whole-unit
    // decimals as JavaScript numbers carries float error into the DECIMAL(65,30)
    // column: two `0.1` milestones became `0.30000000000000004`, which is what
    // GET /api/jobs then returned and the dashboard displayed.
    const totalAmountUsdc = formatAmount(
      sumAmounts(milestones.map((m) => m.amountUsdc), assetInfo.decimals),
      assetInfo.decimals,
    );

    const job = await prisma.job.create({
      data: {
        title,
        description,
        asset: assetInfo.symbol,
        totalAmountUsdc,
        clientId: client.id,
        expiresAt: expiresAt ? new Date(expiresAt) : undefined,
        milestones: {
          create: milestones.map((m, i) => ({
            index: i,
            // Store each amount at the asset's own precision so the milestones
            // and the total are consistent with the on-chain base units.
            amountUsdc: formatAmount(
              toBaseUnits(m.amountUsdc, assetInfo.decimals),
              assetInfo.decimals,
            ),
            description: m.description,
            deadline: m.deadline ? new Date(m.deadline) : undefined,
          })),
        },
      },
      include: { milestones: true },
    });

    res.status(201).json(job);
  } catch (err) {
    next(err);
  }
});

// GET /api/jobs/:id
jobsRouter.get("/:id", async (req, res, next) => {
  try {
    const job = await prisma.job.findUnique({
      where: { id: req.params.id },
      include: { milestones: true, client: true, freelancer: true, disputes: true, ratings: true },
    });
    if (!job) throw new AppError(404, "Job not found");
    res.json(job);
  } catch (err) {
    next(err);
  }
});

// PUT /api/jobs/:id/assign
jobsRouter.put("/:id/assign", requireAuth, async (req, res, next) => {
  try {
    const job = await prisma.job.findUnique({ where: { id: req.params.id }, include: { client: true } });
    if (!job) throw new AppError(404, "Job not found");
    if (job.client.stellarAddress !== res.locals.stellarAddress) {
      throw new AppError(403, "Only the client can assign a freelancer");
    }

    const { freelancerAddress } = req.body as { freelancerAddress: string };
    const freelancer = await prisma.user.findUnique({ where: { stellarAddress: freelancerAddress } });
    if (!freelancer) throw new AppError(404, "Freelancer not found");

    const updated = await prisma.job.update({
      where: { id: req.params.id },
      data: { freelancerId: freelancer.id },
    });
    res.json(updated);
  } catch (err) {
    next(err);
  }
});
