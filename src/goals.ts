import {
  AssertionCondition,
  evaluateCondition,
  observedValues,
  parseCondition,
  validateAssertions,
} from "./assertions";

export interface GoalDefinition {
  id: string;
  description?: string;
  condition: AssertionCondition;
}

export interface GoalWitness {
  path: string[];
  choiceIndices: number[];
  observedValues: Record<string, unknown>;
  firstDiscoveredAtState: number;
  foundBy: string;
}

export interface GoalResult {
  id: string;
  description?: string;
  status: "reached" | "not_reached_within_limits" | "proven_unreachable";
  statesEvaluated: number;
  witness?: GoalWitness;
  closestObserved?: {
    distance: number;
    observedValues: Record<string, unknown>;
    path: string[];
    choiceIndices: number[];
  };
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function parseGoalDefinitions(value: unknown, at: string, issues: string[]): GoalDefinition[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    issues.push(`${at}: expected a list`);
    return undefined;
  }
  const seen = new Set<string>();
  const result: GoalDefinition[] = [];
  value.forEach((item, index) => {
    const here = `${at}[${index}]`;
    if (!record(item)) {
      issues.push(`${here}: expected a mapping`);
      return;
    }
    for (const key of Object.keys(item)) {
      if (!["id", "description", "condition"].includes(key)) issues.push(`${here}.${key}: unknown key`);
    }
    if (typeof item.id !== "string" || !/^[a-z][a-z0-9_-]{0,63}$/.test(item.id)) {
      issues.push(`${here}.id: expected 1-64 lowercase letters, numbers, _ or -`);
      return;
    }
    if (seen.has(item.id)) issues.push(`${here}.id: duplicate goal id ${item.id}`);
    seen.add(item.id);
    if (item.description !== undefined && (typeof item.description !== "string" || item.description.length > 240)) {
      issues.push(`${here}.description: expected a string of at most 240 characters`);
    }
    const parsed = parseCondition(item.condition, `${here}.condition`, issues);
    if (parsed) result.push({
      id: item.id,
      ...(typeof item.description === "string" ? { description: item.description } : {}),
      condition: parsed,
    });
  });
  return result;
}

export function validateGoals(
  goals: GoalDefinition[],
  variables: Record<string, unknown>,
  knots: string[]
): string[] {
  return validateAssertions(
    goals.map((goal) => ({ id: goal.id, description: goal.description, when: "always", condition: goal.condition })),
    variables,
    knots
  ).map((issue) => issue.replace(/^assertions\./, "goals."));
}

function operandValue(operand: { variable: string } | { literal: unknown }, variables: Record<string, unknown>): unknown {
  return "variable" in operand ? variables[operand.variable] : operand.literal;
}

/** Zero means reached; positive values are deterministic ordering hints, not probabilities. */
export function conditionDistance(condition: AssertionCondition, variables: Record<string, unknown>): number {
  if ("all" in condition) return condition.all.reduce((sum, item) => sum + conditionDistance(item, variables), 0);
  if ("any" in condition) return Math.min(...condition.any.map((item) => conditionDistance(item, variables)));
  if ("not" in condition) return evaluateCondition(condition.not, variables) ? 1 : 0;
  if (evaluateCondition(condition, variables)) return 0;
  const left = operandValue(condition.left, variables);
  const right = operandValue(condition.right, variables);
  if (typeof left === "number" && typeof right === "number") return Math.abs(left - right) + 1;
  return 1;
}

export class GoalTracker {
  private readonly evaluated = new Map<string, number>();
  private readonly witnesses = new Map<string, GoalWitness>();
  private readonly closest = new Map<string, NonNullable<GoalResult["closestObserved"]>>();

  constructor(private readonly goals: GoalDefinition[], private readonly foundBy: string) {}

  observe(observation: {
    variables: Record<string, unknown>;
    path: string[];
    choiceIndices: number[];
    state: number;
  }): void {
    for (const goal of this.goals) {
      this.evaluated.set(goal.id, (this.evaluated.get(goal.id) ?? 0) + 1);
      const distance = conditionDistance(goal.condition, observation.variables);
      const candidate = {
        distance,
        observedValues: observedValues(goal.condition, observation.variables),
        path: [...observation.path],
        choiceIndices: [...observation.choiceIndices],
      };
      const previous = this.closest.get(goal.id);
      if (!previous || distance < previous.distance || (distance === previous.distance && candidate.path.length < previous.path.length)) {
        this.closest.set(goal.id, candidate);
      }
      if (distance === 0 && !this.witnesses.has(goal.id)) {
        this.witnesses.set(goal.id, {
          path: candidate.path,
          choiceIndices: candidate.choiceIndices,
          observedValues: candidate.observedValues,
          firstDiscoveredAtState: observation.state,
          foundBy: this.foundBy,
        });
      }
    }
  }

  priority(variables: Record<string, unknown>): number {
    const unreached = this.goals.filter((goal) => !this.witnesses.has(goal.id));
    if (unreached.length === 0) return 0;
    const distance = Math.min(...unreached.map((goal) => conditionDistance(goal.condition, variables)));
    return Math.floor(1_000_000 / (1 + distance));
  }

  results(exhaustive: boolean): GoalResult[] {
    return this.goals.map((goal) => {
      const witness = this.witnesses.get(goal.id);
      return {
        id: goal.id,
        ...(goal.description ? { description: goal.description } : {}),
        status: witness ? "reached" : exhaustive ? "proven_unreachable" : "not_reached_within_limits",
        statesEvaluated: this.evaluated.get(goal.id) ?? 0,
        ...(witness ? { witness } : {}),
        ...(!witness && this.closest.get(goal.id) ? { closestObserved: this.closest.get(goal.id) } : {}),
      };
    });
  }
}
