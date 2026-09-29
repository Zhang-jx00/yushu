import Ajv, { type ErrorObject, type ValidateFunction } from "ajv";
import { YushuError } from "@yushu/core";
import {
  CORE_CHAPTER_SCHEMA_ID,
  CORE_OUTLINE_SCHEMA_ID,
  CORE_SCHEMAS,
  CORE_SETTING_CARD_SCHEMA_ID,
  CORE_WORLD_SCHEMA_ID,
  type JsonSchemaObject,
} from "./schemas.js";

export class SchemaValidationError extends YushuError {
  readonly issues: ValidationIssue[];

  constructor(schemaId: string, issues: ValidationIssue[]) {
    super(
      "E_VALIDATION",
      `数据未通过 ${schemaId} 校验（${issues.length} 处问题）：${issues
        .slice(0, 3)
        .map((i) => `${i.path} ${i.message}`)
        .join("；")}`,
    );
    this.issues = issues;
  }
}

export interface ValidationIssue {
  /** 数据路径，如 /aliases/0 */
  path: string;
  message: string;
  keyword: string;
}

export interface ValidationResult {
  valid: boolean;
  issues: ValidationIssue[];
}

function toIssues(errors: ErrorObject[] | null | undefined): ValidationIssue[] {
  return (errors ?? []).map((e) => ({
    path: e.instancePath === "" ? "/" : e.instancePath,
    message: e.message ?? "未知错误",
    keyword: e.keyword,
  }));
}

/** JSON Schema 注册表：登记 → 校验；同一 registry 内 schema 可互相引用（$ref）。 */
export class SchemaRegistry {
  private readonly ajv: Ajv;
  private readonly validators = new Map<string, ValidateFunction>();

  constructor() {
    this.ajv = new Ajv({ allErrors: true, strict: false });
  }

  /** 登记并编译 schema（要求含 $id）。重复登记同一 $id 抛错。 */
  add(schema: JsonSchemaObject): void {
    const id = schema["$id"];
    if (typeof id !== "string" || id === "") {
      throw new YushuError("E_SCHEMA", "schema 缺少 $id，无法登记");
    }
    if (this.validators.has(id)) {
      throw new YushuError("E_SCHEMA", `schema 已存在：${id}`);
    }
    const fn = this.ajv.compile(schema);
    this.validators.set(id, fn);
  }

  has(id: string): boolean {
    return this.validators.has(id);
  }

  ids(): string[] {
    return [...this.validators.keys()];
  }

  validate(id: string, data: unknown): ValidationResult {
    const fn = this.validators.get(id);
    if (!fn) {
      throw new YushuError("E_SCHEMA", `未登记的 schema：${id}`);
    }
    const valid = fn(data) as boolean;
    return { valid, issues: valid ? [] : toIssues(fn.errors) };
  }

  /** 校验失败即抛 SchemaValidationError。 */
  assertValid(id: string, data: unknown): void {
    const result = this.validate(id, data);
    if (!result.valid) {
      throw new SchemaValidationError(id, result.issues);
    }
  }
}

/** 创建预载全部核心 schema 的注册表。 */
export function createRegistry(): SchemaRegistry {
  const registry = new SchemaRegistry();
  for (const schema of CORE_SCHEMAS) {
    registry.add(schema);
  }
  return registry;
}

/** 进程级默认注册表（懒加载）。 */
let defaultRegistry: SchemaRegistry | undefined;

export function getDefaultRegistry(): SchemaRegistry {
  defaultRegistry ??= createRegistry();
  return defaultRegistry;
}

export function validateWorld(data: unknown): ValidationResult {
  return getDefaultRegistry().validate(CORE_WORLD_SCHEMA_ID, data);
}

export function validateSettingCard(data: unknown): ValidationResult {
  return getDefaultRegistry().validate(CORE_SETTING_CARD_SCHEMA_ID, data);
}

export {
  CORE_CHAPTER_SCHEMA_ID,
  CORE_OUTLINE_SCHEMA_ID,
  CORE_SCHEMAS,
  CORE_SETTING_CARD_SCHEMA_ID,
  CORE_WORLD_SCHEMA_ID,
};
export type { JsonSchemaObject };