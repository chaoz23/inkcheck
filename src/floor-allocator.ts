export interface FloorServiceAccount {
  pass: string;
  active: boolean;
  promisedCumulative: number;
  floorGrantedCumulative: number;
  releasedCumulative: number;
  grantedCumulative: number;
  debt: number;
  credit: number;
}

export interface FloorAllocation {
  grants: number[];
  floorGrants: number[];
  effectiveFloorShare: number;
  accounts: FloorServiceAccount[];
}

interface MutableFloorAccount {
  pass: string;
  active: boolean;
  promised: number;
  floorGranted: number;
  released: number;
  granted: number;
}

const EPSILON = 1e-9;

/** Stateful integer allocator for auditable cumulative minimum service. */
export class CumulativeFloorAllocator {
  private readonly accounts: MutableFloorAccount[];
  private floorPool = 0;

  constructor(passes: string[], private readonly requestedFloorShare = 0.08) {
    this.accounts = passes.map((pass) => ({
      pass,
      active: true,
      promised: 0,
      floorGranted: 0,
      released: 0,
      granted: 0,
    }));
  }

  allocate(total: number, desiredWeights: number[], active: boolean[]): FloorAllocation {
    if (!Number.isSafeInteger(total) || total < 0) throw new RangeError("total must be a non-negative integer");
    if (desiredWeights.length !== this.accounts.length || active.length !== this.accounts.length) {
      throw new RangeError("weights and active flags must match the pass count");
    }

    for (let i = 0; i < this.accounts.length; i++) {
      const account = this.accounts[i];
      if (account.active && !active[i]) {
        account.released += Math.max(0, account.promised - account.floorGranted - account.released);
      }
      account.active = active[i];
    }

    const activeIndices = active.flatMap((isActive, i) => (isActive ? [i] : []));
    const grants = this.accounts.map(() => 0);
    const floorGrants = this.accounts.map(() => 0);
    if (total === 0 || activeIndices.length === 0) return this.result(grants, floorGrants, 0);

    const effectiveFloorShare = Math.min(this.requestedFloorShare, 1 / activeIndices.length);
    for (const i of activeIndices) this.accounts[i].promised += total * effectiveFloorShare;
    this.floorPool += total * effectiveFloorShare * activeIndices.length;

    const floorSlots = Math.min(total, Math.floor(this.floorPool + EPSILON));
    this.floorPool -= floorSlots;
    for (let slot = 0; slot < floorSlots; slot++) {
      const i = activeIndices.reduce((best, candidate) =>
        this.floorDebt(candidate) > this.floorDebt(best) + EPSILON ? candidate : best
      );
      floorGrants[i]++;
      this.accounts[i].floorGranted++;
    }

    const desired = splitInteger(
      total,
      activeIndices.map((i) => Math.max(0, desiredWeights[i] ?? 0))
    );
    for (let a = 0; a < activeIndices.length; a++) grants[activeIndices[a]] = desired[a];
    for (const recipient of activeIndices) {
      while (grants[recipient] < floorGrants[recipient]) {
        const donor = activeIndices
          .filter((i) => grants[i] > floorGrants[i])
          .sort((a, b) =>
            (grants[b] - floorGrants[b]) - (grants[a] - floorGrants[a]) || a - b
          )[0];
        if (donor === undefined) throw new Error("cumulative floor grant plan is not reconcilable");
        grants[donor]--;
        grants[recipient]++;
      }
    }

    for (let i = 0; i < grants.length; i++) this.accounts[i].granted += grants[i];
    return this.result(grants, floorGrants, effectiveFloorShare);
  }

  private floorDebt(i: number): number {
    const account = this.accounts[i];
    return account.promised - account.floorGranted - account.released;
  }

  private result(grants: number[], floorGrants: number[], effectiveFloorShare: number): FloorAllocation {
    return {
      grants,
      floorGrants,
      effectiveFloorShare,
      accounts: this.accounts.map((account, i) => {
        const balance = this.floorDebt(i);
        return {
          pass: account.pass,
          active: account.active,
          promisedCumulative: account.promised,
          floorGrantedCumulative: account.floorGranted,
          releasedCumulative: account.released,
          grantedCumulative: account.granted,
          debt: Math.max(0, balance),
          credit: Math.max(0, -balance),
        };
      }),
    };
  }
}

function splitInteger(total: number, weights: number[]): number[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  const normalized = sum > 0 ? weights.map((weight) => weight / sum) : weights.map(() => 1 / weights.length);
  const exact = normalized.map((weight) => total * weight);
  const result = exact.map(Math.floor);
  let remaining = total - result.reduce((a, b) => a + b, 0);
  const order = exact
    .map((value, i) => ({ i, remainder: value - Math.floor(value) }))
    .sort((a, b) => b.remainder - a.remainder || a.i - b.i);
  for (let i = 0; remaining > 0; i = (i + 1) % order.length) {
    result[order[i].i]++;
    remaining--;
  }
  return result;
}
