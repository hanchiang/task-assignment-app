// Task writes: create a tree, change status, assignee or skills. Each update runs inside withTreeLock,
// loads what the rules need, calls rules.ts, then writes. See docs/design.md → Write paths and Create path.
import type pg from "pg";
import type { FastifyBaseLogger } from "fastify";
import { v7 as uuidv7 } from "uuid";
import { lockDeveloper, withTransaction, withTreeLock } from "../db.js";
import { badRequest, validationError } from "../errors.js";
import { listDevelopers } from "../developers/repo.js";
import limits from "../limits.json" with { type: "json" };
import type { SkillIdentifier } from "../llm/skillIdentifier.js";
import { findSkills, listSkills } from "../skills/repo.js";
import { parse } from "../validation.js";
import * as repo from "./repo.js";
import { ancestorsToReopen, checkAssignment, checkCanBeDone, checkRawTree, checkSkillEdit, type Status } from "./rules.js";
import { NewTaskSchema, nodePath, type NewTask, type StatusChange, type TaskNode, type TaskRef } from "./schemas.js";

export class TaskService {
  constructor(private readonly deps: { pool: pg.Pool; identifier: SkillIdentifier }) {}

  async changeStatus(taskId: string, status: Status, log: FastifyBaseLogger): Promise<StatusChange> {
    return withTreeLock(this.deps.pool, taskId, async (client, task) => {
      if (status === "DONE") checkCanBeDone(task, await repo.directSubtasks(client, taskId));

      let reopened: TaskRef[] = [];
      if (task.status === "DONE" && status !== "DONE") {
        const tree = await repo.treeStatuses(client, task.root_id);
        const ids = ancestorsToReopen(task.parent_id, tree);
        if (ids.length > 0) await repo.setStatus(client, ids, "IN_PROGRESS");
        reopened = ids.map((id) => ({ id, title: tree.get(id)!.title, status: "IN_PROGRESS" }));
      }
      await repo.setStatus(client, [taskId], status);

      log.info({ taskId, from: task.status, to: status, reopened: reopened.map((r) => r.id) }, "status changed");
      // The locked task exists, so the reads after each write below cannot come back empty.
      return { task: (await repo.getSubtree(client, taskId))!, reopened };
    });
  }

  async changeAssignee(taskId: string, developerId: string | null, log: FastifyBaseLogger): Promise<TaskNode> {
    return withTreeLock(this.deps.pool, taskId, async (client, task) => {
      if (developerId !== null) {
        const developer = await lockDeveloper(client, developerId);
        if (!developer) throw validationError(`Developer ${developerId} does not exist.`);
        checkAssignment({ title: task.title, skills: await repo.taskSkills(client, taskId) }, developer);
      }
      await repo.setAssignee(client, taskId, developerId);
      log.info({ taskId, from: task.assignee_id, to: developerId }, "assignee changed");
      return (await repo.getSubtree(client, taskId))!;
    });
  }

  async changeSkills(
    taskId: string,
    skillIds: string[],
    unassignIfUnqualified: boolean,
    log: FastifyBaseLogger,
  ): Promise<TaskNode> {
    const ids = [...new Set(skillIds)];
    return withTreeLock(this.deps.pool, taskId, async (client, task) => {
      const found = await findSkills(client, ids);
      if (found.length !== ids.length) {
        const known = new Set(found.map((r) => r.id));
        throw validationError(`Unknown skill id(s): ${ids.filter((id) => !known.has(id)).join(", ")}.`);
      }

      const assignee = task.assignee_id ? await lockDeveloper(client, task.assignee_id) : undefined;
      const { clearAssignee } = checkSkillEdit(found, assignee, unassignIfUnqualified);

      const before = await repo.replaceSkills(client, taskId, ids, clearAssignee);
      log.info(
        {
          taskId,
          from: { skillSource: task.skill_source, skillIds: before },
          to: { skillSource: "USER", skillIds: ids },
          unassigned: clearAssignee ? task.assignee_id : undefined,
        },
        "skills changed",
      );
      return (await repo.getSubtree(client, taskId))!;
    });
  }

  async create(body: unknown, log: FastifyBaseLogger): Promise<TaskNode> {
    const { pool, identifier } = this.deps;

    // 1. Validate everything that can fail before the LLM call, so an invalid request never spends one.
    checkRawTree(body, limits);
    const nodes = flatten(parse(NewTaskSchema, body, "task", nodePath));

    const [skills, developers] = await Promise.all([listSkills(pool), listDevelopers(pool)]);
    const skillById = new Map(skills.map((s) => [s.id, s]));
    const skillByName = new Map(skills.map((s) => [s.name, s]));
    const developerById = new Map(developers.map((d) => [d.id, { ...d, skillIds: new Set(d.skills.map((s) => s.id)) }]));

    for (const n of nodes) {
      const unknown = n.skillIds.filter((id) => !skillById.has(id));
      if (unknown.length > 0) throw validationError(`Unknown skill id(s): ${unknown.join(", ")}.`, { path: n.path });
      if (n.assigneeId && !developerById.has(n.assigneeId)) {
        throw validationError(`Developer ${n.assigneeId} does not exist.`, { path: n.path });
      }
    }
    for (const n of nodes) {
      if (n.assigneeId && n.skillIds.length === 0) {
        throw badRequest(
          "ASSIGNEE_WITHOUT_USER_SKILLS",
          `'${n.title}' names an assignee but no skills. Pick its skills to assign it now, or assign it later.`,
          { path: n.path },
        );
      }
    }
    const checkAssignees = (byId: Map<string, { name: string; skillIds: Set<string> }>) => {
      for (const n of nodes) {
        if (!n.assigneeId) continue;
        const skills = n.skillIds.map((id) => skillById.get(id)!);
        checkAssignment({ title: n.title, skills }, byId.get(n.assigneeId)!, { path: n.path });
      }
    };
    checkAssignees(developerById);

    // 2. One identification call for every skill-less title, before any transaction opens.
    const pending = nodes.filter((n) => n.skillIds.length === 0);
    if (pending.length > 0) {
      // A rejection means every title failed. Only the error name is logged: the message could carry
      // provider free text or a title.
      let answers: (string[] | null)[];
      try {
        answers = await identifier.identify(pending.map((n) => n.title));
      } catch (err) {
        log.error({ errorName: (err as Error)?.name, titleCount: pending.length }, "skill identifier failed; saving those tasks as FAILED");
        answers = [];
      }
      pending.forEach((n, i) => {
        const ids = new Set((answers[i] ?? []).flatMap((name) => skillByName.get(name)?.id ?? []));
        n.skillIds = [...ids];
        n.skillSource = ids.size > 0 ? "LLM" : "FAILED";
      });
    }

    // 3. Lock each named assignee and re-check with the skills read under the lock, then insert the tree.
    // New rows are invisible until commit, so they need no lock.
    const rootId = nodes[0]!.id;
    const created = await withTransaction(pool, async (client) => {
      const locked = new Map<string, { name: string; skillIds: Set<string> }>();
      const assigneeIds = [...new Set(nodes.flatMap((n) => (n.assigneeId ? [n.assigneeId] : [])))].sort();
      for (const id of assigneeIds) {
        const dev = await lockDeveloper(client, id);
        if (!dev) throw validationError(`Developer ${id} does not exist.`);
        locked.set(id, dev);
      }
      checkAssignees(locked);
      await repo.insertTree(client, nodes.map((n) => ({ ...n, assigneeId: n.assigneeId ?? null })));
      return (await repo.getSubtree(client, rootId))!;
    });

    log.info(
      { taskId: rootId, tasks: nodes.length, sentToLlm: pending.length, failed: pending.filter((n) => n.skillSource === "FAILED").length },
      "task tree created",
    );
    return created;
  }
}

type FlatNode = Omit<repo.InsertRow, "assigneeId"> & { path: number[]; assigneeId: string | undefined };

// Walks the request tree once, in memory: assigns ids, parent links and sibling positions.
function flatten(input: NewTask): FlatNode[] {
  const out: FlatNode[] = [];
  const rootId = uuidv7();
  const walk = (node: NewTask, id: string, parentId: string | null, position: number, path: number[]) => {
    out.push({
      id,
      title: node.title,
      skillIds: [...new Set(node.skillIds ?? [])],
      skillSource: "USER",
      parentId,
      rootId,
      position,
      assigneeId: node.assigneeId,
      path,
    });
    (node.subtasks ?? []).forEach((child, i) => walk(child, uuidv7(), id, i, [...path, i]));
  };
  walk(input, rootId, null, 0, []);
  return out;
}
