export type AssertionLiteral = string | number | boolean | null;
export type AssertionOperator = "==" | "!=" | "<" | "<=" | ">" | ">=";

export type AssertionOperand =
  | { variable: string }
  | { literal: AssertionLiteral };

export type AssertionCondition =
  | { left: AssertionOperand; operator: AssertionOperator; right: AssertionOperand }
  | { all: AssertionCondition[] }
  | { any: AssertionCondition[] }
  | { not: AssertionCondition };

export type AssertionScope = "always" | "terminal" | { knot: string };

export interface AssertionDefinition {
  id: string;
  description?: string;
  when: AssertionScope;
  condition: AssertionCondition;
}

export interface AssertionViolation {
  ruleId: string;
  description?: string;
  observedValues: Record<string, unknown>;
  path: string[];
  choiceIndices: number[];
  firstDiscoveredAtState: number;
  foundBy: string;
  knot?: string;
  sourceLocation?: { file: string; line: number; approximate: false };
}

export interface AssertionResult {
  id: string;
  description?: string;
  when: AssertionScope;
  status: "violated" | "not_observed" | "exhaustively_verified";
  observations: number;
  violations: AssertionViolation[];
}

export interface AssertionObservation {
  variables: Record<string, unknown>;
  terminal: boolean;
  knots?: string[];
  path: string[];
  choiceIndices: number[];
  state: number;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function keys(value: Record<string, unknown>, allowed: string[], at: string, issues: string[]): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) issues.push(`${at}.${key}: unknown key`);
}

function operand(value: unknown, at: string, issues: string[]): AssertionOperand | undefined {
  if (!record(value)) {
    issues.push(`${at}: expected { variable: name } or { literal: value }`);
    return undefined;
  }
  keys(value, ["variable", "literal"], at, issues);
  const hasVariable = Object.hasOwn(value, "variable");
  const hasLiteral = Object.hasOwn(value, "literal");
  if (hasVariable === hasLiteral) {
    issues.push(`${at}: expected exactly one of variable or literal`);
    return undefined;
  }
  if (hasVariable) {
    if (typeof value.variable !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(value.variable)) {
      issues.push(`${at}.variable: expected an Ink variable name`);
      return undefined;
    }
    return { variable: value.variable };
  }
  if (!["string", "number", "boolean"].includes(typeof value.literal) && value.literal !== null) {
    issues.push(`${at}.literal: expected string, number, boolean, or null`);
    return undefined;
  }
  if (typeof value.literal === "number" && !Number.isFinite(value.literal)) {
    issues.push(`${at}.literal: expected a finite number`);
    return undefined;
  }
  return { literal: value.literal as AssertionLiteral };
}

function condition(value: unknown, at: string, issues: string[], depth = 0): AssertionCondition | undefined {
  if (depth > 20) {
    issues.push(`${at}: condition nesting exceeds 20 levels`);
    return undefined;
  }
  if (!record(value)) {
    issues.push(`${at}: expected a comparison, all, any, or not condition`);
    return undefined;
  }
  const forms = ["all", "any", "not"].filter((key) => Object.hasOwn(value, key));
  const comparison = ["left", "operator", "right"].some((key) => Object.hasOwn(value, key));
  if (forms.length + Number(comparison) !== 1) {
    issues.push(`${at}: expected exactly one condition form`);
    return undefined;
  }
  if (comparison) {
    keys(value, ["left", "operator", "right"], at, issues);
    const left = operand(value.left, `${at}.left`, issues);
    const right = operand(value.right, `${at}.right`, issues);
    const operators = ["==", "!=", "<", "<=", ">", ">="];
    if (!operators.includes(value.operator as string)) {
      issues.push(`${at}.operator: expected ${operators.join(", ")}`);
      return undefined;
    }
    return left && right
      ? { left, operator: value.operator as AssertionOperator, right }
      : undefined;
  }
  const form = forms[0] as "all" | "any" | "not";
  keys(value, [form], at, issues);
  if (form === "not") {
    const nested = condition(value.not, `${at}.not`, issues, depth + 1);
    return nested ? { not: nested } : undefined;
  }
  if (!Array.isArray(value[form]) || value[form].length === 0) {
    issues.push(`${at}.${form}: expected a non-empty list`);
    return undefined;
  }
  const nested = value[form].map((item, index) => condition(item, `${at}.${form}[${index}]`, issues, depth + 1));
  return nested.every(Boolean) ? { [form]: nested as AssertionCondition[] } as AssertionCondition : undefined;
}

export function parseAssertionDefinitions(
  value: unknown,
  at: string,
  issues: string[]
): AssertionDefinition[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    issues.push(`${at}: expected a list`);
    return undefined;
  }
  const seen = new Set<string>();
  const definitions: AssertionDefinition[] = [];
  value.forEach((item, index) => {
    const here = `${at}[${index}]`;
    if (!record(item)) {
      issues.push(`${here}: expected a mapping`);
      return;
    }
    keys(item, ["id", "description", "when", "condition"], here, issues);
    if (typeof item.id !== "string" || !/^[a-z][a-z0-9_-]{0,63}$/.test(item.id)) {
      issues.push(`${here}.id: expected 1-64 lowercase letters, numbers, _ or -`);
      return;
    }
    if (seen.has(item.id)) issues.push(`${here}.id: duplicate assertion id ${item.id}`);
    seen.add(item.id);
    if (item.description !== undefined && (typeof item.description !== "string" || item.description.length > 240)) {
      issues.push(`${here}.description: expected a string of at most 240 characters`);
    }
    let when: AssertionScope | undefined;
    if (item.when === "always" || item.when === "terminal") when = item.when;
    else if (record(item.when) && typeof item.when.knot === "string") {
      keys(item.when, ["knot"], `${here}.when`, issues);
      when = { knot: item.when.knot };
    } else issues.push(`${here}.when: expected always, terminal, or { knot: name }`);
    const parsedCondition = condition(item.condition, `${here}.condition`, issues);
    if (when && parsedCondition) {
      definitions.push({
        id: item.id,
        ...(typeof item.description === "string" ? { description: item.description } : {}),
        when,
        condition: parsedCondition,
      });
    }
  });
  return definitions;
}

function variablesInOperand(value: AssertionOperand): string[] {
  return "variable" in value ? [value.variable] : [];
}

function comparisons(value: AssertionCondition): Array<Extract<AssertionCondition, { left: AssertionOperand }>> {
  if ("left" in value) return [value];
  if ("not" in value) return comparisons(value.not);
  return ("all" in value ? value.all : value.any).flatMap(comparisons);
}

function typeOfOperand(value: AssertionOperand, variables: Record<string, unknown>): string | undefined {
  if ("variable" in value && !Object.hasOwn(variables, value.variable)) return undefined;
  const resolved = "variable" in value ? variables[value.variable] : value.literal;
  return resolved === null ? "null" : typeof resolved;
}

export function validateAssertions(
  definitions: AssertionDefinition[],
  variables: Record<string, unknown>,
  knots: string[]
): string[] {
  const issues: string[] = [];
  for (const rule of definitions) {
    if (typeof rule.when === "object" && !knots.includes(rule.when.knot)) {
      issues.push(`assertions.${rule.id}.when.knot: unknown knot ${rule.when.knot}`);
    }
    for (const comparison of comparisons(rule.condition)) {
      for (const name of [...variablesInOperand(comparison.left), ...variablesInOperand(comparison.right)]) {
        if (!Object.hasOwn(variables, name)) issues.push(`assertions.${rule.id}: unknown variable ${name}`);
      }
      const left = typeOfOperand(comparison.left, variables);
      const right = typeOfOperand(comparison.right, variables);
      if (left === undefined || right === undefined) continue;
      if (left !== right) issues.push(`assertions.${rule.id}: cannot compare ${left} with ${right}`);
      if (!["==", "!="].includes(comparison.operator) && !["number", "string"].includes(left)) {
        issues.push(`assertions.${rule.id}: ${comparison.operator} requires numbers or strings`);
      }
    }
  }
  return [...new Set(issues)];
}

function resolve(value: AssertionOperand, variables: Record<string, unknown>): unknown {
  return "variable" in value ? variables[value.variable] : value.literal;
}

export function evaluateCondition(value: AssertionCondition, variables: Record<string, unknown>): boolean {
  if ("all" in value) return value.all.every((item) => evaluateCondition(item, variables));
  if ("any" in value) return value.any.some((item) => evaluateCondition(item, variables));
  if ("not" in value) return !evaluateCondition(value.not, variables);
  const left = resolve(value.left, variables) as AssertionLiteral;
  const right = resolve(value.right, variables) as AssertionLiteral;
  switch (value.operator) {
    case "==": return left === right;
    case "!=": return left !== right;
    case "<": return left! < right!;
    case "<=": return left! <= right!;
    case ">": return left! > right!;
    case ">=": return left! >= right!;
  }
}

export function observedValues(condition: AssertionCondition, variables: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const comparison of comparisons(condition)) {
    for (const name of [...variablesInOperand(comparison.left), ...variablesInOperand(comparison.right)]) {
      result[name] = variables[name];
    }
  }
  return result;
}

function applies(rule: AssertionDefinition, observation: AssertionObservation): boolean {
  if (rule.when === "always") return true;
  if (rule.when === "terminal") return observation.terminal;
  return observation.knots?.includes(rule.when.knot) ?? false;
}

export class AssertionTracker {
  private readonly observations = new Map<string, number>();
  private readonly violations = new Map<string, AssertionViolation>();

  constructor(
    private readonly definitions: AssertionDefinition[],
    private readonly foundBy: string,
    private readonly knotLocations: Record<string, { file: string; line: number }> = {}
  ) {}

  observe(observation: AssertionObservation): void {
    for (const rule of this.definitions) {
      if (!applies(rule, observation)) continue;
      this.observations.set(rule.id, (this.observations.get(rule.id) ?? 0) + 1);
      if (evaluateCondition(rule.condition, observation.variables)) continue;
      const violation: AssertionViolation = {
        ruleId: rule.id,
        ...(rule.description ? { description: rule.description } : {}),
        observedValues: observedValues(rule.condition, observation.variables),
        path: [...observation.path],
        choiceIndices: [...observation.choiceIndices],
        firstDiscoveredAtState: observation.state,
        foundBy: this.foundBy,
        ...(typeof rule.when === "object" ? { knot: rule.when.knot } : {}),
        ...(typeof rule.when === "object" && this.knotLocations[rule.when.knot]
          ? { sourceLocation: { ...this.knotLocations[rule.when.knot], approximate: false as const } }
          : {}),
      };
      const previous = this.violations.get(rule.id);
      if (!previous || violation.path.length < previous.path.length) this.violations.set(rule.id, violation);
    }
  }

  results(exhaustive: boolean): AssertionResult[] {
    return this.definitions.map((rule) => {
      const violation = this.violations.get(rule.id);
      return {
        id: rule.id,
        ...(rule.description ? { description: rule.description } : {}),
        when: rule.when,
        status: violation ? "violated" : exhaustive ? "exhaustively_verified" : "not_observed",
        observations: this.observations.get(rule.id) ?? 0,
        violations: violation ? [violation] : [],
      };
    });
  }
}
