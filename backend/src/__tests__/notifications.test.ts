import { describe, expect, it } from "vitest";
import { Address, Keypair, nativeToScVal, xdr } from "@stellar/stellar-sdk";
import { decodeEventFields, type ContractEventLike } from "../lib/events";
import { EVENT_TOPIC_FIELDS } from "../indexer";
import {
  applyEventNotifications,
  notificationRecipients,
  notificationText,
  type NotificationJob,
  type NotificationRow,
  type NotificationStores,
} from "../indexer";

const CLIENT = Keypair.random().publicKey();
const FREELANCER = Keypair.random().publicKey();
const CONTRACT = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM";

/** Build an `#[contractevent]`-shaped event: name in topic0, data in the map. */
function makeEvent(
  name: string,
  data: Record<string, xdr.ScVal>,
  ledger = 10,
  topics: xdr.ScVal[] = [],
): ContractEventLike {
  return {
    id: `evt-${ledger}`,
    ledger,
    topic: [xdr.ScVal.scvSymbol(name), ...topics],
    value: xdr.ScVal.scvMap(
      Object.entries(data).map(
        ([key, val]) => new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(key), val }),
      ),
    ),
  };
}

/** The decoded fields of an event, the way `dispatchEvent` computes them. */
function fields(event: ContractEventLike, name: string): Record<string, unknown> {
  return decodeEventFields(event, EVENT_TOPIC_FIELDS[name] ?? []);
}

const JOB: NotificationJob = {
  id: "job-1",
  asset: "USDC",
  client: { stellarAddress: CLIENT },
  freelancer: { stellarAddress: FREELANCER },
};

/** In-memory stand-in for the notification store, keyed on the primary key. */
class FakeNotificationStore implements NotificationStores {
  readonly jobs: Array<NotificationJob & { escrowId: bigint }> = [];
  readonly rows = new Map<string, NotificationRow>();

  /** Pre-seed the mirrored job, without which nothing can be addressed. */
  seedJob(escrowId: bigint, overrides: Partial<NotificationJob> = {}): void {
    this.jobs.push({ escrowId, ...JOB, ...overrides });
  }

  job = {
    findUnique: async (_args: {
      where: { escrowId: bigint };
      include: { client: true; freelancer: true };
    }): Promise<NotificationJob | null> => {
      const job = this.jobs.find((candidate) => candidate.escrowId === _args.where.escrowId);
      return job ?? null;
    },
  };

  notification = {
    createMany: async (args: {
      data: NotificationRow[];
      skipDuplicates?: boolean;
    }): Promise<{ count: number }> => {
      let count = 0;
      for (const row of args.data) {
        // Mirrors the real `skipDuplicates`: an id that already exists is left
        // alone, which is what makes a replayed event idempotent.
        if (this.rows.has(row.id) && args.skipDuplicates) continue;
        this.rows.set(row.id, row);
        count++;
      }
      return { count };
    },
  };
}

describe("notificationText", () => {
  it("renders a funded amount in whole units of the job's asset", () => {
    // 25_000_000 base units at 7 decimals.
    expect(notificationText("funded", { amount: 25_000_000n }, "USDC")).toEqual({
      title: "Escrow funded",
      body: "2.5 USDC is now held in escrow — work can start.",
    });
  });

  it("names the milestone that was released", () => {
    expect(
      notificationText("milestone_released", { index: 1, amount: 1_000_000n }, "USDC"),
    ).toEqual({
      title: "Milestone 2 released",
      body: "Milestone 2 · 0.1 USDC released to the freelancer.",
    });
  });

  it("covers a dispute being opened and resolved, with the split", () => {
    expect(notificationText("dispute_opened", {}, "USDC")).toEqual({
      title: "Dispute opened",
      body: "The escrow is frozen pending arbitration.",
    });
    expect(
      notificationText(
        "dispute_resolved",
        { client_share: 5_000_000n, freelancer_share: 5_000_000n },
        "USDC",
      ),
    ).toEqual({
      title: "Dispute resolved",
      body: "The arbitrators ruled. Client 0.5 USDC, freelancer 0.5 USDC.",
    });
  });

  it("tells the client an escrow was refunded", () => {
    expect(notificationText("refunded", { amount: 3_000_000n }, "USDC")).toEqual({
      title: "Escrow refunded",
      body: "0.3 USDC was refunded to the client.",
    });
  });

  it("stays readable when the event carries no amount", () => {
    expect(notificationText("funded", {}, "USDC")).toEqual({
      title: "Escrow funded",
      body: "The escrow is funded — work can start.",
    });
  });

  it("returns nothing for events users are not told about", () => {
    // `created` is the client's own action; `rated` happens with both parties
    // present; the rest are bookkeeping.
    for (const name of ["created", "rated", "milestones_updated", "raised", "approved"]) {
      expect(notificationText(name, { amount: 1n }, "USDC")).toBeNull();
    }
  });

  it("falls back to the raw amount for an unregistered asset", () => {
    expect(notificationText("funded", { amount: 25_000_000n }, "DOGE")?.body).toContain(
      "25000000 DOGE",
    );
  });
});

describe("notificationRecipients", () => {
  it("tells both parties once each", () => {
    expect(notificationRecipients(JOB).sort()).toEqual([CLIENT, FREELANCER].sort());
  });

  it("handles a job with no freelancer assigned yet", () => {
    expect(notificationRecipients({ ...JOB, freelancer: null })).toEqual([CLIENT]);
  });

  it("does not duplicate a party that is somehow both", () => {
    expect(
      notificationRecipients({
        ...JOB,
        freelancer: { stellarAddress: CLIENT },
      }),
    ).toEqual([CLIENT]);
  });
});

describe("applyEventNotifications", () => {
  it("writes one row per participant, keyed on the event and the address", async () => {
    const db = new FakeNotificationStore();
    db.seedJob(7n);
    const event = makeEvent("funded", { escrow_id: nativeToScVal(7n, { type: "u64" }) });

    const told = await applyEventNotifications(db, event, "funded", fields(event, "funded"));

    expect(told).toBe(2);
    expect([...db.rows.keys()].sort()).toEqual([`evt-10:${CLIENT}`, `evt-10:${FREELANCER}`].sort());
    const row = db.rows.get(`evt-10:${FREELANCER}`);
    expect(row).toMatchObject({
      address: FREELANCER,
      type: "funded",
      title: "Escrow funded",
      escrowId: 7n,
      jobId: "job-1",
    });
  });

  it("reads the amount and the escrow id from a real event shape", async () => {
    // Both live in the data map for `funded`; for `milestone_released` the escrow
    // id is the #[topic] field instead, which is the trap docs/EVENTS.md warns
    // about — decoding only the value map would give this handler no escrow.
    const db = new FakeNotificationStore();
    db.seedJob(7n);
    const event = makeEvent(
      "milestone_released",
      {
        index: nativeToScVal(0, { type: "u32" }),
        amount: nativeToScVal(15_000_000n, { type: "i128" }),
      },
      42,
      [nativeToScVal(7n, { type: "u64" })],
    );

    const told = await applyEventNotifications(
      db,
      event,
      "milestone_released",
      fields(event, "milestone_released"),
    );

    expect(told).toBe(2);
    expect(db.rows.get(`evt-42:${CLIENT}`)?.body).toBe(
      "Milestone 1 · 1.5 USDC released to the freelancer.",
    );
  });

  it("is idempotent: replaying an event does not duplicate the feed", async () => {
    const db = new FakeNotificationStore();
    db.seedJob(7n);
    const event = makeEvent("refunded", { escrow_id: nativeToScVal(7n, { type: "u64" }) });

    await applyEventNotifications(db, event, "refunded", fields(event, "refunded"));
    await applyEventNotifications(db, event, "refunded", fields(event, "refunded"));

    // A cursor rewind re-processes the same ledger.
    expect(db.rows.size).toBe(2);
  });

  it("does nothing for an event users are not told about", async () => {
    const db = new FakeNotificationStore();
    db.seedJob(7n);
    const event = makeEvent("created", { escrow_id: nativeToScVal(7n, { type: "u64" }) });

    expect(await applyEventNotifications(db, event, "created", fields(event, "created"))).toBe(0);
    expect(db.rows.size).toBe(0);
  });

  it("does nothing when the escrow has no off-chain job to address the row to", async () => {
    const db = new FakeNotificationStore();
    const event = makeEvent("funded", { escrow_id: nativeToScVal(9n, { type: "u64" }) });

    expect(await applyEventNotifications(db, event, "funded", fields(event, "funded"))).toBe(0);
    expect(db.rows.size).toBe(0);
  });

  it("does nothing for an event with no escrow id", async () => {
    // `approved` carries only a dispute id in its topic.
    const db = new FakeNotificationStore();
    db.seedJob(7n);
    const event = makeEvent("approved", { arbitrator: Address.fromString(CLIENT).toScVal() });

    expect(await applyEventNotifications(db, event, "approved", {})).toBe(0);
    expect(db.rows.size).toBe(0);
  });

  it("composes the key from the ledger when RPC gave the event no id", async () => {
    const db = new FakeNotificationStore();
    db.seedJob(7n);
    const event: ContractEventLike = {
      ledger: 5,
      topic: [xdr.ScVal.scvSymbol("funded")],
      value: nativeToScVal(CONTRACT),
    };

    await applyEventNotifications(db, event, "funded", { escrow_id: 7n });

    expect([...db.rows.keys()]).toContain(`5-funded-7:${CLIENT}`);
  });
});
