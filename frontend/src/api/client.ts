// Fetch wrapper and one function per endpoint. Every failure becomes a RequestError, so callers
// switch on `code` and never inspect a Response. Tests stub this module instead of the network.
import type {
  Developer,
  ErrorBody,
  Id,
  Meta,
  NewTask,
  Skill,
  SkillsUpdate,
  Status,
  StatusChange,
  TaskNode,
} from "./types";

export const NETWORK_ERROR = "NETWORK_ERROR";
export const UNEXPECTED_RESPONSE = "UNEXPECTED_RESPONSE";

export class RequestError extends Error {
  constructor(
    readonly status: number, // 0 when no response arrived
    readonly code: string,
    message: string,
    readonly details?: unknown,
    readonly requestId?: string,
  ) {
    super(message);
    this.name = "RequestError";
  }
}

// A 500, a network failure, or a reply that is not the API's error body (such as nginx's 504 page):
// nothing the user can fix by editing the input.
export function isUnexpectedFailure(err: unknown): boolean {
  if (!(err instanceof RequestError)) return true;
  return err.status === 0 || err.status >= 500 || err.code === UNEXPECTED_RESPONSE;
}

// The text a page shows for a failed change: the backend's own message for a rule or input error,
// and a generic line with the request id (when there is one) for anything unexpected.
export function describeFailure(err: unknown): string {
  if (!(err instanceof RequestError)) return "Something went wrong.";
  if (!isUnexpectedFailure(err)) return err.message;
  if (err.requestId) return `Something went wrong (request id ${err.requestId}).`;
  return `Something went wrong. ${err.message}`;
}

function isErrorBody(body: unknown): body is ErrorBody {
  const error = (body as ErrorBody | null)?.error;
  return typeof error?.code === "string" && typeof error.message === "string";
}

async function readJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return undefined;
  }
}

function toRequestError(status: number, body: unknown): RequestError {
  if (!isErrorBody(body)) {
    return new RequestError(status, UNEXPECTED_RESPONSE, `The server answered with status ${status}.`);
  }
  const { code, message, details, requestId } = body.error;
  return new RequestError(status, code, message, details, requestId);
}

async function send(method: string, path: string, body?: unknown): Promise<Response> {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify(body);
  }
  try {
    return await fetch(path, init);
  } catch {
    throw new RequestError(0, NETWORK_ERROR, "Could not reach the server.");
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await send(method, path, body);
  const json = await readJson(res);
  if (!res.ok) throw toRequestError(res.status, json);
  if (json === undefined) {
    const message = "The server sent a reply the app could not read.";
    throw new RequestError(res.status, UNEXPECTED_RESPONSE, message);
  }
  return json as T;
}

export const getTasks = () => request<TaskNode[]>("GET", "/api/tasks");
export const getDevelopers = () => request<Developer[]>("GET", "/api/developers");
export const getSkills = () => request<Skill[]>("GET", "/api/skills");
export const getMeta = () => request<Meta>("GET", "/api/meta");

export const createTask = (task: NewTask) => request<TaskNode>("POST", "/api/tasks", task);

export const setStatus = (taskId: Id, status: Status) =>
  request<StatusChange>("PUT", `/api/tasks/${taskId}/status`, { status });

export const setAssignee = (taskId: Id, developerId: Id | null) =>
  request<TaskNode>("PUT", `/api/tasks/${taskId}/assignee`, { developerId });

export const setSkills = (taskId: Id, update: SkillsUpdate) =>
  request<TaskNode>("PUT", `/api/tasks/${taskId}/skills`, update);
