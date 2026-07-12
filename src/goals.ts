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
  condition?: AssertionCondition;
  stages?: GoalStageDefinition[];
}

export interface GoalStageDefinition {
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
  status: "reached" | "not_reached_within_limits" | "proven_unreachable" | "blocked_by_stage";
  statesEvaluated: number;
  witness?: GoalWitness;
  closestObserved?: {
    distance: number;
    observedValues: Record<string, unknown>;
    path: string[];
    choiceIndices: number[];
  };
  stages?: GoalStageResult[];
}

export interface GoalStageResult {
  id: string;
  description?: string;
  status: "reached" | "not_reached_within_limits" | "proven_unreachable" | "blocked_by_stage";
  statesEvaluated: number;
  blockedBy?: string;
  witness?: GoalWitness;
  closestObserved?: GoalResult["closestObserved"];
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
      if (!["id", "description", "condition", "stages"].includes(key)) issues.push(`${here}.${key}: unknown key`);
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
    if ((item.condition === undefined) === (item.stages === undefined)) {
      issues.push(`${here}: expected exactly one of condition or stages`);
      return;
    }
    const parsed = item.condition === undefined ? undefined : parseCondition(item.condition, `${here}.condition`, issues);
    let stages: GoalStageDefinition[] | undefined;
    let stageCount = 0;
    if (item.stages !== undefined) {
      if (!Array.isArray(item.stages) || item.stages.length < 2) {
        issues.push(`${here}.stages: expected at least two ordered stages`);
      } else {
        stageCount = item.stages.length;
        const stageIds = new Set<string>();
        stages = [];
        item.stages.forEach((stage, stageIndex) => {
          const stageAt = `${here}.stages[${stageIndex}]`;
          if (!record(stage)) {
            issues.push(`${stageAt}: expected a mapping`);
            return;
          }
          for (const key of Object.keys(stage)) {
            if (!["id", "description", "condition"].includes(key)) issues.push(`${stageAt}.${key}: unknown key`);
          }
          if (typeof stage.id !== "string" || !/^[a-z][a-z0-9_-]{0,63}$/.test(stage.id)) {
            issues.push(`${stageAt}.id: expected 1-64 lowercase letters, numbers, _ or -`);
            return;
          }
          if (stageIds.has(stage.id)) issues.push(`${stageAt}.id: duplicate stage id ${stage.id}`);
          stageIds.add(stage.id);
          if (stage.description !== undefined && (typeof stage.description !== "string" || stage.description.length > 240)) {
            issues.push(`${stageAt}.description: expected a string of at most 240 characters`);
          }
          const condition = parseCondition(stage.condition, `${stageAt}.condition`, issues);
          if (condition) stages!.push({
            id: stage.id,
            ...(typeof stage.description === "string" ? { description: stage.description } : {}),
            condition,
          });
        });
      }
    }
    if (parsed || (stages && stages.length === stageCount)) result.push({
      id: item.id,
      ...(typeof item.description === "string" ? { description: item.description } : {}),
      ...(parsed ? { condition: parsed } : {}),
      ...(stages ? { stages } : {}),
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
    goals.flatMap((goal) => goal.condition
      ? [{ id: goal.id, description: goal.description, when: "always" as const, condition: goal.condition }]
      : (goal.stages ?? []).map((stage) => ({
          id: `${goal.id}_${stage.id}`.slice(0, 64),
          description: stage.description,
          when: "always" as const,
          condition: stage.condition,
        }))),
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

  private targets(goal: GoalDefinition): Array<{ key: string; id: string; description?: string; condition: AssertionCondition }> {
    if (goal.condition) return [{ key: goal.id, id: goal.id, description: goal.description, condition: goal.condition }];
    const conditions: AssertionCondition[] = [];
    return (goal.stages ?? []).map((stage) => {
      conditions.push(stage.condition);
      return {
        key: `${goal.id}/${stage.id}`,
        id: stage.id,
        description: stage.description,
        condition: conditions.length === 1 ? conditions[0] : { all: [...conditions] },
      };
    });
  }

  observe(observation: {
    variables: Record<string, unknown>;
    path: string[];
    choiceIndices: number[];
    state: number;
  }): void {
    for (const goal of this.goals) for (const target of this.targets(goal)) {
      this.evaluated.set(target.key, (this.evaluated.get(target.key) ?? 0) + 1);
      const distance = conditionDistance(target.condition, observation.variables);
      const candidate = {
        distance,
        observedValues: observedValues(target.condition, observation.variables),
        path: [...observation.path],
        choiceIndices: [...observation.choiceIndices],
      };
      const previous = this.closest.get(target.key);
      if (!previous || distance < previous.distance || (distance === previous.distance && candidate.path.length < previous.path.length)) {
        this.closest.set(target.key, candidate);
      }
      if (distance === 0 && !this.witnesses.has(target.key)) {
        this.witnesses.set(target.key, {
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
    const candidates = this.goals.flatMap((goal) => {
      const targets = this.targets(goal);
      const index = targets.findIndex((target) => !this.witnesses.has(target.key));
      if (index < 0) return [];
      const distance = conditionDistance(targets[index].condition, variables);
      return [{ stage: index, distance }];
    });
    if (!candidates.length) return 0;
    const best = candidates.sort((a, b) => b.stage - a.stage || a.distance - b.distance)[0];
    return best.stage * 1_000_000 + Math.floor(999_999 / (1 + best.distance));
  }

  reachedGoalCount(): number {
    return this.goals.filter((goal) => {
      const targets = this.targets(goal);
      return targets.length > 0 && this.witnesses.has(targets[targets.length - 1].key);
    }).length;
  }

  reachedStageCount(): number {
    return this.goals.reduce((total, goal) => total + (goal.stages ?? []).filter((stage) =>
      this.witnesses.has(`${goal.id}/${stage.id}`)
    ).length, 0);
  }

  results(exhaustive: boolean): GoalResult[] {
    return this.goals.map((goal) => {
      const targets = this.targets(goal);
      const stageResults: GoalStageResult[] | undefined = goal.stages?.map((stage, index) => {
        const target = targets[index];
        const previous = index > 0 ? targets[index - 1] : undefined;
        const blocked = previous && !this.witnesses.has(previous.key);
        const witness = this.witnesses.get(target.key);
        return {
          id: stage.id,
          ...(stage.description ? { description: stage.description } : {}),
          status: blocked ? "blocked_by_stage" : witness ? "reached" : exhaustive ? "proven_unreachable" : "not_reached_within_limits",
          statesEvaluated: this.evaluated.get(target.key) ?? 0,
          ...(blocked ? { blockedBy: goal.stages![index - 1].id } : {}),
          ...(witness ? { witness } : {}),
          ...(!witness && !blocked && this.closest.get(target.key) ? { closestObserved: this.closest.get(target.key) } : {}),
        };
      });
      const final = targets[targets.length - 1];
      const witness = this.witnesses.get(final.key);
      const finalStage = stageResults?.[stageResults.length - 1];
      return {
        id: goal.id,
        ...(goal.description ? { description: goal.description } : {}),
        status: witness ? "reached" : finalStage?.status ?? (exhaustive ? "proven_unreachable" : "not_reached_within_limits"),
        statesEvaluated: this.evaluated.get(final.key) ?? 0,
        ...(witness ? { witness } : {}),
        ...(!witness && this.closest.get(final.key) ? { closestObserved: this.closest.get(final.key) } : {}),
        ...(stageResults ? { stages: stageResults } : {}),
      };
    });
  }
}
