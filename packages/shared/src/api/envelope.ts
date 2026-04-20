// 成功响应
export interface ApiSuccessResponse<T> {
  success: true;
  data: T;
}

// 错误响应
export interface ApiErrorResponse {
  success: false;
  error: {
    code: string;
    message: string;
  };
}

export type ApiResponse<T> = ApiSuccessResponse<T> | ApiErrorResponse;

// 后端用的辅助函数：构造成功响应
export function ok<T>(data: T): ApiSuccessResponse<T> {
  return { success: true, data };
}

// 后端用的辅助函数：构造错误响应
export function fail(code: string, message: string): ApiErrorResponse {
  return { success: false, error: { code, message } };
}
