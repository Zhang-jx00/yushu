/** 御书异常基类：所有错误携带稳定错误码，便于上层分支处理与提示。 */
export class YushuError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.code = code;
    this.name = new.target.name;
  }
}

/** frontmatter 解析 / 序列化错误 */
export class FrontmatterError extends YushuError {
  constructor(message: string, options?: ErrorOptions) {
    super("E_FRONTMATTER", message, options);
  }
}

/** ID 与命名空间错误 */
export class IdError extends YushuError {
  constructor(message: string, options?: ErrorOptions) {
    super("E_ID", message, options);
  }
}