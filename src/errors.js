/** 表示可向用户展示的业务错误，避免把内部路径或 SQL 暴露到页面。 */
export class AppError extends Error {
  /** 设置 HTTP 状态和中文提示。 */
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
