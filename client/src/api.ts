export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public code = "REQUEST_FAILED",
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export async function api<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api/v1${path}`, {
      ...options,
      credentials: "same-origin",
      headers: {
        ...(options.body ? { "Content-Type": "application/json" } : {}),
        ...options.headers,
      },
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError")
      throw error;
    throw new ApiError("网络连接失败，请稍后重试。", 0, "NETWORK_ERROR");
  }
  const contentType = response.headers.get("content-type") || "";
  const data = contentType.includes("application/json")
    ? await response.json()
    : null;
  if (!response.ok) {
    if (response.status === 401)
      window.dispatchEvent(new Event("renewly:unauthorized"));
    throw new ApiError(
      data?.error?.message || `请求失败（${response.status}），请稍后重试。`,
      response.status,
      data?.error?.code,
    );
  }
  return data as T;
}

export const json = (method: string, data?: unknown): RequestInit => ({
  method,
  ...(data === undefined ? {} : { body: JSON.stringify(data) }),
});
export const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : "操作失败，请稍后重试。";
